#!/usr/bin/env bash
# ============================================================================
# provision.sh — create + schema-apply the four application databases
# ----------------------------------------------------------------------------
# Idempotent. Safe to re-run. Replaces `prisma db push` as the schema authority.
#
#   Step 1  create databases (needs a superuser)  → 00_databases.sql
#   Step 2  apply each schema to its own database → b2b*.sql
#
# 00_databases.sql also creates b2b_ticketing_admin, but its SCHEMA is loaded
# separately from the `ticketingDB` pg dump (pg_restore) — NOT by this script.
#
# Env / config:
#   Reads DATABASE_URL, CHAT_DATABASE_URL, TICKETING_DATABASE_URL,
#   TICKET_DATABASE_URL from the environment, falling back to server/.env.
#   SUPERUSER_PSQL overrides how the CREATE DATABASE step connects
#   (default: "sudo -u postgres psql"). Set e.g. SUPERUSER_PSQL="psql -U postgres"
#   on systems without sudo.
#   DB_CONTAINER applies each schema inside that Podman container over stdin
#   instead of through a host psql client — so the containerized deploy needs no
#   postgresql-client package and does not depend on the database being published
#   to the host. Set by deploy/podman/build.sh; leave unset for bare metal.
#
# Usage:  bash db/provision.sh
# ============================================================================
set -euo pipefail

DB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$DB_DIR/../.env"

# Pull a KEY's value from server/.env if it isn't already in the environment.
load_from_env() {
  local key="$1"
  if [ -z "${!key:-}" ] && [ -f "$ENV_FILE" ]; then
    local line
    line="$(grep -E "^${key}=" "$ENV_FILE" | tail -1 || true)"
    if [ -n "$line" ]; then
      local val="${line#*=}"
      val="${val%\"}"; val="${val#\"}"   # strip surrounding double quotes
      val="${val%\'}"; val="${val#\'}"   # strip surrounding single quotes
      export "$key=$val"
    fi
  fi
}

for k in DATABASE_URL CHAT_DATABASE_URL TICKETING_DATABASE_URL TICKET_DATABASE_URL ADMIN_TICKETING_DATABASE_URL; do
  load_from_env "$k"
  if [ -z "${!k:-}" ]; then echo "❌ $k is not set (env or $ENV_FILE)"; exit 1; fi
done

SUPERUSER_PSQL="${SUPERUSER_PSQL:-sudo -u postgres psql}"

# psql/libpq rejects Prisma's `?schema=...` URL parameter — strip just that one,
# keeping any other query params (sslmode, connect_timeout, …). node-postgres
# (used by the app + db:verify) tolerates it, so only psql needs this.
psql_url() { echo "$1" | sed -E 's/([?&])schema=[^&]*//g; s/\?&/?/g; s/[?&]$//; s/^([^?]*)&/\1?/'; }

# Apply one .sql file to the database a URL names. Fed over STDIN rather than
# `-f`, because a host path is not visible inside a container — that one detail is
# what lets the same call serve both the bare-metal and the DB_CONTAINER paths.
apply() { # $1 = database URL, $2 = .sql file
  if [ -n "${DB_CONTAINER:-}" ]; then
    local db="${1##*/}"; db="${db%%\?*}"        # database name out of the URL
    podman exec -i "$DB_CONTAINER" psql -U postgres -d "$db" -v ON_ERROR_STOP=1 < "$2"
  else
    psql "$(psql_url "$1")" -v ON_ERROR_STOP=1 -f "$2"
  fi
}

echo "🗄️  Step 1/2 — creating databases…"
$SUPERUSER_PSQL -v ON_ERROR_STOP=1 < "$DB_DIR/00_databases.sql"

echo "📐 Step 2/2 — applying schemas…"
apply "$DATABASE_URL"           "$DB_DIR/b2b.sql"
apply "$CHAT_DATABASE_URL"      "$DB_DIR/b2b_chat.sql"
apply "$TICKETING_DATABASE_URL" "$DB_DIR/b2b_ticketing.sql"
apply "$TICKET_DATABASE_URL"    "$DB_DIR/b2b_ticket.sql"

# ─── Post-schema migrations ────────────────────────────────────────────────
# Idempotent ALTER TABLE statements for columns added after the base schemas
# were first deployed. Safe to re-run (ADD COLUMN IF NOT EXISTS).
echo "🔧 Applying post-schema migrations…"
apply "$TICKET_DATABASE_URL"    "$DB_DIR/2026-09-09-tickets-resolved-at.sql"
apply "$TICKET_DATABASE_URL"    "$DB_DIR/2026-09-10-projects-deleted-at.sql"
apply "$DATABASE_URL"           "$DB_DIR/2026-09-16-external-api.sql"
apply "$DATABASE_URL"           "$DB_DIR/2026-09-16-approval-channel.sql"
apply "$DATABASE_URL"           "$DB_DIR/2026-09-17-squid-proxy.sql"
apply "$DATABASE_URL"           "$DB_DIR/2026-09-17-slack-link.sql"
apply "$DATABASE_URL"           "$DB_DIR/2026-09-18-service-expiry-reminders.sql"
apply "$DATABASE_URL"           "$DB_DIR/2026-09-18-squid-telemetry.sql"
# The Administrators' isolated store is the SAME 14-table schema in its own
# database. Upstream loads it from the `ticketingDB` pg dump, which is not in this
# repo — b2b_ticket.sql is idempotent and non-destructive, so applying it here
# gives a from-scratch install a working admin store instead of a schemaless one.
# Non-fatal, and PGCONNECT_TIMEOUT keeps a dead host from stalling the deploy for
# the full TCP timeout. This store is on a REMOTE host: under `set -e` an outage
# there used to abort provisioning with a non-zero exit even though all four LOCAL
# databases had already been applied successfully — deploy.sh then reported a scary
# "provisioning failed" and people started deploying by hand instead, skipping
# provisioning altogether. That is how `customers.approved` never reached the live
# database. A remote store being down must not mask four local successes.
PGCONNECT_TIMEOUT=5 apply "$ADMIN_TICKETING_DATABASE_URL" "$DB_DIR/b2b_ticket.sql" \
  || echo "⚠️  admin ticket store ($ADMIN_TICKETING_DATABASE_URL) unreachable — skipped. The four local databases above were applied."
# Same resolvedAt migration on the admin store — both stores share the 14-table
# schema, so both need the column. Idempotent, non-fatal like the apply above.
PGCONNECT_TIMEOUT=5 apply "$ADMIN_TICKETING_DATABASE_URL" "$DB_DIR/2026-09-09-tickets-resolved-at.sql" \
  || echo "⚠️  resolvedAt migration not applied to admin ticket store ($ADMIN_TICKETING_DATABASE_URL)."
# Same for Projects.deletedAt — the admin store shares the 14-table schema too.
PGCONNECT_TIMEOUT=5 apply "$ADMIN_TICKETING_DATABASE_URL" "$DB_DIR/2026-09-10-projects-deleted-at.sql" \
  || echo "⚠️  deletedAt migration not applied to admin ticket store ($ADMIN_TICKETING_DATABASE_URL)."

echo "✅ Provisioning complete."
