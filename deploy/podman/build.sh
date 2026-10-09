#!/usr/bin/env bash
# ============================================================================
# build.sh — bring the containerized deployment from "units installed" to
# "images built, config written, databases provisioned".
#
#   sudo ./deploy/podman/build.sh [tag]
#
# Every phase is idempotent, so this is BOTH the first-run bootstrap and the
# day-2 rebuild. On a re-run it regenerates nothing, prompts for nothing, and
# leaves every existing secret byte-identical.
#
# Images are tagged BOTH :latest and :<tag> (default: the short git sha). That
# second tag is the rollback artifact — the main thing containers buy over the
# in-place systemd deploy:
#
#   podman tag localhost/b2b-api:<previous-sha> localhost/b2b-api:latest
#   systemctl restart b2b-api
#
# ── Why this script writes /etc/b2b/*.env instead of a human ──
# Quadlet's `EnvironmentFile=` is NOT systemd's. It becomes `podman run
# --env-file`, which reads the file VERBATIM — it does not strip quotes. A
# hand-written `DATABASE_URL="postgres://…"` therefore reaches the container
# with the quotes still attached, config/env.ts's z.string().url() rejects it,
# the API exits 1, and Restart=always turns that into a restart loop that
# surfaces only as "systemctl restart b2b-api failed". Generating these files
# here is what keeps that from coming back.
# ============================================================================
set -euo pipefail

# ─── env-file helpers ────────────────────────────────────────────────────────
# These read and write KEY=value files WITHOUT shell-sourcing them. Sourcing is
# what a `.env` invites and it is wrong here twice over: an unquoted value with a
# space would execute as a command, and a quoted one would be silently accepted
# by the shell but rejected by podman --env-file. awk with ENVIRON keeps values
# opaque — no glob, no escape processing, no word splitting.

env_get() { # FILE KEY -> value on stdout, empty if absent
    [ -f "$1" ] || return 0
    EG_KEY="$2" awk 'BEGIN { k = ENVIRON["EG_KEY"] }
        index($0, k "=") == 1 { print substr($0, length(k) + 2); exit }' "$1"
}

env_set() { # FILE KEY VALUE — replace in place, keeping position; append if new
    local f="$1" tmp
    tmp="$(mktemp)"
    ES_KEY="$2" ES_VALUE="$3" awk '
        BEGIN { k = ENVIRON["ES_KEY"]; v = ENVIRON["ES_VALUE"]; done = 0 }
        !done && index($0, k "=") == 1 { print k "=" v; done = 1; next }
        { print }
        END { if (!done) print k "=" v }
    ' "$f" > "$tmp"
    cat "$tmp" > "$f"          # `cat >` not `mv`: keeps the file's 0600 mode
    rm -f "$tmp"
}

set_if_missing() { # FILE KEY VALUE
    [ -n "$(env_get "$1" "$2")" ] || env_set "$1" "$2" "$3"
}

# Strip matched surrounding quotes from every assignment. This is the actual fix
# for the reported failure, and it also repairs a file someone hand-edited back
# into `KEY="value"` — which they will, because every .env they have ever seen
# looks like that.
normalize_env() {
    [ -f "$1" ] || return 0
    local tmp; tmp="$(mktemp)"
    sed -E -e 's/^([A-Za-z_][A-Za-z0-9_]*)="(.*)"[[:space:]]*$/\1=\2/' \
           -e "s/^([A-Za-z_][A-Za-z0-9_]*)='(.*)'[[:space:]]*\$/\1=\2/" "$1" > "$tmp"
    if ! cmp -s "$tmp" "$1"; then
        cp -p "$1" "$1.bak"
        cat "$tmp" > "$1"
        echo "   🔧 stripped quotes from $1 (backup: $1.bak)"
    fi
    rm -f "$tmp"
}

new_env_file() { # FILE HEADER…
    [ -f "$1" ] && return 0
    local f="$1"; shift
    install -m 0600 /dev/null "$f"
    {
        printf '# %s\n' "$@"
        echo '#'
        echo '# ⚠ NO QUOTES. This file is read by `podman run --env-file`, which takes the'
        echo '#   value verbatim — quotes included. KEY="value" reaches the container as'
        echo '#   "value" WITH the quotes, and the API then dies on config/env.ts validation.'
        echo '#   Written by deploy/podman/build.sh; re-running it strips any quotes added here.'
        echo
    } > "$f"
}

gen32() { openssl rand -hex 32; }
gen24() { openssl rand -hex 24; }

keep_or_gen() { # FILE KEY GENERATOR — an existing real value ALWAYS wins
    local cur; cur="$(env_get "$1" "$2")"
    case "$cur" in
        ''|change-me*|CHANGE_ME*) env_set "$1" "$2" "$("$3")"; echo "   generated $2" ;;
    esac
}

ask() { # FILE KEY PROMPT [DEFAULT] [secret]
    local f="$1" k="$2" prompt="$3" def="${4:-}" secret="${5:-}"
    [ -n "$(env_get "$f" "$k")" ] && return 0
    local override="${!k:-}"
    if [ -n "$override" ]; then env_set "$f" "$k" "$override"; return 0; fi
    if [ ! -t 0 ]; then
        echo "❌ $k is not set and there is no terminal to prompt on."
        echo "   Pass it in the environment:  $k='…' sudo -E $0"
        exit 1
    fi
    local ans
    if [ -n "$secret" ]; then
        read -r -s -p "   $prompt: " ans; echo
    else
        read -r -p "   $prompt${def:+ [$def]}: " ans
    fi
    env_set "$f" "$k" "${ans:-$def}"
}

# Sourcing this file gets you the helpers above and nothing else — that is how
# test-envfile.sh exercises them without root, podman, or a build.
[ "${BASH_SOURCE[0]}" = "${0}" ] || return 0

# ─── preflight ───────────────────────────────────────────────────────────────
if [ "$EUID" -ne 0 ]; then
    echo "🔒 This script must be run with sudo or as root (it writes /etc/b2b at 0600)."
    exit 1
fi

command -v podman  >/dev/null || { echo "❌ podman is not installed."; exit 1; }
command -v openssl >/dev/null || { echo "❌ openssl is not installed (needed to generate secrets)."; exit 1; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

[ -f /etc/containers/systemd/b2b-api.container ] || {
    echo "❌ Quadlet units are not installed. Run this first:"
    echo "     sudo ./deploy/podman/install.sh"
    exit 1
}

TAG="${1:-$(git rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M%S)}"

CONF_DIR=/etc/b2b
SERVER_ENV="$CONF_DIR/server.env"
CLIENT_ENV="$CONF_DIR/client.env"
PG_ENV="$CONF_DIR/postgres.env"

# ─────────────────────────────────────────────────────────────────────────────
# Phase 1 — configuration
# ─────────────────────────────────────────────────────────────────────────────
echo "⚙️  Phase 1/6 — configuration in $CONF_DIR"
mkdir -p "$CONF_DIR"; chmod 0755 "$CONF_DIR"

new_env_file "$PG_ENV"     'PostgreSQL superuser for the containerized cluster.' \
                           'The five application databases are created by server/db/provision.sh.'
new_env_file "$SERVER_ENV" 'B2B-Site API configuration (b2b-api.container).'
new_env_file "$CLIENT_ENV" 'B2B-Site web configuration (b2b-web.container).' \
                           'NEXT_PUBLIC_* here are BUILD ARGS — change one and you must rebuild.'
chmod 0600 "$PG_ENV" "$SERVER_ENV" "$CLIENT_ENV"
for f in "$PG_ENV" "$SERVER_ENV" "$CLIENT_ENV"; do normalize_env "$f"; done

# ── PostgreSQL superuser ─────────────────────────────────────────────────────
# The postgres image only honours POSTGRES_PASSWORD at initdb. Once b2b-pgdata
# carries a cluster, rewriting this value produces a password that authenticates
# against nothing — so an initialised volume pins whatever is already here.
pg_initialised() {
    podman volume exists b2b-pgdata 2>/dev/null || return 1
    local mp; mp="$(podman volume inspect b2b-pgdata --format '{{.Mountpoint}}' 2>/dev/null)" || return 1
    [ -n "$mp" ] && [ -s "$mp/pgdata/PG_VERSION" ]
}

set_if_missing "$PG_ENV" POSTGRES_USER postgres
if pg_initialised; then
    PG_PW="$(env_get "$PG_ENV" POSTGRES_PASSWORD)"
    case "$PG_PW" in
        ''|CHANGE_ME*)
            echo "❌ b2b-pgdata is already initialised but $PG_ENV has no usable password."
            echo "   The cluster's real password is only inside that volume. Either put it back"
            echo "   in $PG_ENV, or discard the data with:  sudo ./deploy/podman/drop.sh --all-gone"
            exit 1 ;;
    esac
    echo "   keeping POSTGRES_PASSWORD (b2b-pgdata already initialised)"
else
    keep_or_gen "$PG_ENV" POSTGRES_PASSWORD gen24
    PG_PW="$(env_get "$PG_ENV" POSTGRES_PASSWORD)"
fi

# The password goes into five connection URLs below. Hex from gen24 is URL-safe;
# a hand-set one containing :/@?#& is not, and would corrupt every URL silently.
case "$PG_PW" in
    *[^A-Za-z0-9._~-]*)
        echo "   ⚠️  POSTGRES_PASSWORD contains characters that are not URL-safe."
        echo "      The *_DATABASE_URL values below will need manual percent-encoding." ;;
esac

# ── Secrets ──────────────────────────────────────────────────────────────────
# Never regenerated once present, and not only to avoid logging everyone out:
# changing SLACK_TOKEN_SECRET makes every stored Slack token and AD password
# permanently undecryptable, and changing PASSWORD_PEPPER invalidates every
# password-reuse fingerprint.
for k in JWT_ACCESS_SECRET IMPERSONATION_SECRET SLACK_TOKEN_SECRET PASSWORD_PEPPER; do
    keep_or_gen "$SERVER_ENV" "$k" gen32
done

# ── Site-specific values: asked once, then remembered ────────────────────────
if [ -z "$(env_get "$SERVER_ENV" FRONTEND_URL)" ]; then
    echo
    echo "   This host's public address. Everything is served from ONE origin behind"
    echo "   nginx, so this is also the API's address — that keeps the auth cookie"
    echo "   first-party and CORS out of the picture."
    ask "$SERVER_ENV" FRONTEND_URL "Public origin (scheme + host)" "https://$(hostname -f 2>/dev/null || hostname)"
fi
ORIGIN="$(env_get "$SERVER_ENV" FRONTEND_URL)"

if [ -z "$(env_get "$SERVER_ENV" ADMIN_DOMAINS)" ]; then
    echo
    echo "   Work-email domains allowed to hold the ADMINISTRATOR role, comma-separated."
    echo "   ⚠ PRIVATE domains you control only. A public mailbox domain here (gmail.com,"
    echo "     outlook.com, …) makes any signup from it a platform super-admin."
    ask "$SERVER_ENV" ADMIN_DOMAINS "Admin email domains"
fi

if [ -z "$(env_get "$SERVER_ENV" SMTP_HOST)" ]; then
    echo
    echo "   SMTP. A 6-digit MFA code is emailed on EVERY login, so if mail cannot be"
    echo "   sent, nobody can log in — this is not optional in practice."
    ask "$SERVER_ENV" SMTP_HOST "SMTP host"
    ask "$SERVER_ENV" SMTP_PORT "SMTP port" 587
    ask "$SERVER_ENV" SMTP_USER "SMTP username (blank if the relay authenticates by IP)"
    ask "$SERVER_ENV" SMTP_PASS "SMTP password" "" secret
    ask "$SERVER_ENV" MAIL_FROM "From address" "noreply@${ORIGIN#*://}"
fi

# ── Derived from the container topology ──────────────────────────────────────
# Written unconditionally: these must agree with postgres.env and b2b.network,
# and a stale copy is exactly the silent breakage this script exists to prevent.
PGBASE="postgresql://$(env_get "$PG_ENV" POSTGRES_USER):$PG_PW@b2b-postgres:5432"
env_set "$SERVER_ENV" DATABASE_URL                 "$PGBASE/b2b?schema=public"
env_set "$SERVER_ENV" CHAT_DATABASE_URL            "$PGBASE/b2b_chat"
env_set "$SERVER_ENV" TICKETING_DATABASE_URL       "$PGBASE/b2b_ticketing"
env_set "$SERVER_ENV" TICKET_DATABASE_URL          "$PGBASE/b2b_ticket"
# The Administrators' isolated store is deployment-specific. This site points it
# at its own `ticketing` database, NOT the script's generated b2b_ticketing_admin —
# derive it only when unset, so a re-run never silently repoints admin ticketing
# at a different database and "loses" its data.
set_if_missing "$SERVER_ENV" ADMIN_TICKETING_DATABASE_URL "$PGBASE/b2b_ticketing_admin"
env_set "$SERVER_ENV" REDIS_URL "redis://b2b-redis:6379"
env_set "$SERVER_ENV" UPLOAD_DIR /app/uploads

# Read from b2b.network rather than hardcoded, so the pinned subnet and the value
# Express checks X-Forwarded-For against cannot drift apart. Wrong here and every
# IP-keyed rate limiter collapses into one bucket, with nothing in the logs.
SUBNET="$(sed -n 's/^Subnet=//p' "$ROOT/deploy/podman/b2b.network" | head -1)"
[ -n "$SUBNET" ] || { echo "❌ No Subnet= in deploy/podman/b2b.network"; exit 1; }
env_set "$SERVER_ENV" TRUST_PROXY "$SUBNET"

# The browser drops a Secure cookie sent over plain HTTP, which presents as
# "login succeeds then immediately fails" — so this tracks the scheme exactly.
case "$ORIGIN" in https://*) env_set "$SERVER_ENV" COOKIE_SECURE true ;;
                  *)         env_set "$SERVER_ENV" COOKIE_SECURE false ;; esac

set_if_missing "$SERVER_ENV" ALLOWED_ORIGINS "$ORIGIN"
set_if_missing "$CLIENT_ENV" NEXT_PUBLIC_API_URL "$ORIGIN"

echo "   ✅ $SERVER_ENV, $CLIENT_ENV, $PG_ENV"

# ─────────────────────────────────────────────────────────────────────────────
# Phase 2 — API image
# ─────────────────────────────────────────────────────────────────────────────
echo
echo "🏗️  Phase 2/6 — building b2b-api:$TAG"
podman build -f Containerfile.api -t "localhost/b2b-api:$TAG" -t localhost/b2b-api:latest .

# ─────────────────────────────────────────────────────────────────────────────
# Phase 3 — VAPID keys
# ─────────────────────────────────────────────────────────────────────────────
# Generated with the image just built, because `web-push` is already a server
# dependency and Containerfile.api copies node_modules whole. No npx, no network,
# no new dependency — which is why this runs after Phase 2.
echo
echo "🔑 Phase 3/6 — Web Push (VAPID)"
if [ -z "$(env_get "$SERVER_ENV" VAPID_PUBLIC_KEY)" ]; then
    # Captured with $(...) rather than a process substitution: `set -e` does not
    # see a failure inside <(...), and a silent one here would write empty keys.
    VAPID_OUT="$(podman run --rm localhost/b2b-api:latest \
        node -e 'const k=require("web-push").generateVAPIDKeys();console.log(k.publicKey,k.privateKey)')"
    read -r VAPID_PUB VAPID_PRIV <<<"$VAPID_OUT"
    [ -n "$VAPID_PUB" ] && [ -n "$VAPID_PRIV" ] || {
        echo "❌ VAPID key generation produced nothing. Got: [$VAPID_OUT]"; exit 1; }
    env_set "$SERVER_ENV" VAPID_PUBLIC_KEY  "$VAPID_PUB"
    env_set "$SERVER_ENV" VAPID_PRIVATE_KEY "$VAPID_PRIV"
    set_if_missing "$SERVER_ENV" VAPID_SUBJECT "mailto:$(env_get "$SERVER_ENV" MAIL_FROM)"
    echo "   generated a VAPID key pair"
else
    echo "   keeping the existing key pair (rotating it unsubscribes every browser)"
fi
# Only the API needs the pair. The browser fetches the public half from
# /api/push/vapid-public-key at runtime, so there is no second copy to keep in
# step and no web rebuild after a rotation — which is what used to break push:
# the key baked into the web image drifted from the one in server.env, silently.

# ─────────────────────────────────────────────────────────────────────────────
# Phase 4 — web image
# ─────────────────────────────────────────────────────────────────────────────
# NEXT_PUBLIC_* are INLINED INTO THE BROWSER BUNDLE at `next build`, so they must
# be correct HERE — setting them in the Quadlet unit later does nothing.
NEXT_PUBLIC_API_URL="$(env_get "$CLIENT_ENV" NEXT_PUBLIC_API_URL)"
if [ -z "$NEXT_PUBLIC_API_URL" ]; then
    # Not a warning. The image builds fine and every browser API call fails once
    # deployed, which is a much more expensive way to discover this.
    echo "❌ NEXT_PUBLIC_API_URL is empty in $CLIENT_ENV."
    exit 1
fi

echo
echo "🏗️  Phase 4/6 — building b2b-web:$TAG  (NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL)"
podman build -f Containerfile.web \
    --build-arg "NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL" \
    -t "localhost/b2b-web:$TAG" -t localhost/b2b-web:latest .

# ─────────────────────────────────────────────────────────────────────────────
# Phase 5 — databases
# ─────────────────────────────────────────────────────────────────────────────
echo
echo "🗄️  Phase 5/6 — databases"
systemctl start b2b-postgres b2b-redis

printf '   waiting for b2b-postgres to become healthy'
for _ in $(seq 1 60); do
    if podman healthcheck run b2b-postgres >/dev/null 2>&1; then healthy=1; break; fi
    printf '.'; sleep 2
done
echo
[ "${healthy:-}" = 1 ] || {
    echo "❌ b2b-postgres never became healthy. Look at:  journalctl -u b2b-postgres -n 50"
    exit 1
}

# Provisioning runs THROUGH the container, so no host postgresql-client is needed
# and the published 127.0.0.1:5432 port is not relied on. provision.sh owns the
# SQL — creating the five databases and applying each schema — and is idempotent.
SUPERUSER_PSQL="podman exec -i b2b-postgres psql -U postgres" \
DB_CONTAINER="b2b-postgres" \
DATABASE_URL="$(env_get "$SERVER_ENV" DATABASE_URL)" \
CHAT_DATABASE_URL="$(env_get "$SERVER_ENV" CHAT_DATABASE_URL)" \
TICKETING_DATABASE_URL="$(env_get "$SERVER_ENV" TICKETING_DATABASE_URL)" \
TICKET_DATABASE_URL="$(env_get "$SERVER_ENV" TICKET_DATABASE_URL)" \
ADMIN_TICKETING_DATABASE_URL="$(env_get "$SERVER_ENV" ADMIN_TICKETING_DATABASE_URL)" \
    bash "$ROOT/server/db/provision.sh"

# ─────────────────────────────────────────────────────────────────────────────
# Phase 6 — verify
# ─────────────────────────────────────────────────────────────────────────────
# Deliberately run through --env-file rather than by exporting the values: that
# is the exact parsing path that broke this deployment, so a quoting regression
# fails HERE instead of as a restart loop after cutover.
echo
echo "🔎 Phase 6/6 — verifying config and databases as the API sees them"

# First the config gate — this is literally the module whose process.exit(1) took
# the deployment down. It only validates, it never connects, so a quoting or
# missing-value regression fails here in a second instead of as a restart loop
# twenty minutes into a cutover.
podman run --rm --env-file "$SERVER_ENV" -e NODE_ENV=production \
    localhost/b2b-api:latest node -e 'require("/app/dist/config/env.js")' \
    || { echo "❌ config/env.ts rejected $SERVER_ENV (see above)."; exit 1; }
echo "   ✅ config/env.ts accepts $SERVER_ENV"

podman run --rm --network b2b --env-file "$SERVER_ENV" \
    -e NODE_ENV=production localhost/b2b-api:latest npm run --silent db:verify

cat <<EOF

✅ Built localhost/b2b-api:$TAG and localhost/b2b-web:$TAG (also tagged :latest)
   Config written to $CONF_DIR, databases provisioned and verified.

Start the application:

   systemctl start b2b-api b2b-web
   systemctl start b2b-nginx        # stop any host nginx first (port conflict)
   systemctl enable b2b-postgres b2b-redis b2b-api b2b-web b2b-nginx

Then verify for real — see the checklist in deploy/podman/README.md:
   curl -fsS $ORIGIN/health         # every database "connected"
   log in end to end                # proves SMTP/MFA actually works
EOF
