#!/usr/bin/env bash
# ============================================================================
# test-envfile.sh — self-check for build.sh's env-file helpers.
#
#   ./deploy/podman/test-envfile.sh
#
# No root, no podman, no build. It sources build.sh (which returns early when
# sourced) and asserts against a temp file.
#
# The first case is the regression that took the deployment down: a quoted
# `.env` fed to `podman run --env-file`, which does not strip quotes.
# ============================================================================
set -euo pipefail

# shellcheck source=./build.sh
. "$(dirname "${BASH_SOURCE[0]}")/build.sh"

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
F="$TMP/server.env"
fails=0

check() { # LABEL EXPECTED ACTUAL
    if [ "$2" = "$3" ]; then
        echo "  ✅ $1"
    else
        echo "  ❌ $1"; echo "       expected: [$2]"; echo "       got:      [$3]"
        fails=$((fails + 1))
    fi
}

# ── The bug ──────────────────────────────────────────────────────────────────
# A file in the shape install.sh used to seed from server/.env.
cat > "$F" <<'EOF'
# comment line, must survive
DATABASE_URL="postgresql://postgres:pw@b2b-postgres:5432/b2b?schema=public"
COOKIE_SECURE="true"
PORT=3001
ADMIN_DOMAINS='banihal.in,example.com'
MAIL_FROM="noreply@banihal.in"
EOF

echo "normalize_env — strips the quotes podman --env-file would keep"
normalize_env "$F" >/dev/null
check "DATABASE_URL unquoted" \
    "postgresql://postgres:pw@b2b-postgres:5432/b2b?schema=public" "$(env_get "$F" DATABASE_URL)"
check "COOKIE_SECURE unquoted"  "true" "$(env_get "$F" COOKIE_SECURE)"
check "single quotes stripped too" "banihal.in,example.com" "$(env_get "$F" ADMIN_DOMAINS)"
check "unquoted value untouched" "3001" "$(env_get "$F" PORT)"
check "no stray quote survives anywhere" "" "$(grep -v '^#' "$F" | grep '"' || true)"
check "comments survive" "1" "$(grep -c '^# comment line' "$F")"
check "backup written" "1" "$([ -f "$F.bak" ] && echo 1 || echo 0)"

echo
echo "normalize_env — idempotent, and leaves an already-clean file alone"
cp "$F" "$TMP/before"; rm -f "$F.bak"
normalize_env "$F" >/dev/null
check "second run is a no-op" "same" "$(cmp -s "$TMP/before" "$F" && echo same || echo differs)"
check "no needless .bak" "0" "$([ -f "$F.bak" ] && echo 1 || echo 0)"

# ── Values the shell would mangle if this ever went back to sourcing ──────────
echo
echo "env_set / env_get — opaque values round-trip"
for v in 'p@ss w0rd'                  `# space: would word-split` \
         'a"b'\''c'                   `# both quote kinds` \
         'back\slash\n'               `# a literal backslash-n, not a newline` \
         'x&y|z;$(id)`id`'            `# shell metacharacters` \
         '*'                          `# would glob` ; do
    env_set "$F" SMTP_PASS "$v"
    check "round-trip [$v]" "$v" "$(env_get "$F" SMTP_PASS)"
done

echo
echo "env_set — replaces in place, does not duplicate or reorder"
env_set "$F" PORT 4000
check "value replaced" "4000" "$(env_get "$F" PORT)"
check "exactly one PORT line" "1" "$(grep -c '^PORT=' "$F")"
check "DATABASE_URL still first assignment" "DATABASE_URL" \
    "$(grep -m1 -oE '^[A-Z_]+' "$F")"
env_set "$F" BRAND_NEW_KEY hello
check "new key appended" "hello" "$(env_get "$F" BRAND_NEW_KEY)"

echo
echo "env_get — absent key is empty, prefixes do not collide"
check "absent key" "" "$(env_get "$F" NOPE)"
env_set "$F" PORTAL_URL "https://portal.example.com"
check "PORT not confused with PORTAL_URL" "4000" "$(env_get "$F" PORT)"

echo
echo "keep_or_gen — an existing real value always wins"
env_set "$F" JWT_ACCESS_SECRET keepme
keep_or_gen "$F" JWT_ACCESS_SECRET gen32 >/dev/null
check "existing secret kept" "keepme" "$(env_get "$F" JWT_ACCESS_SECRET)"

env_set "$F" POSTGRES_PASSWORD CHANGE_ME
keep_or_gen "$F" POSTGRES_PASSWORD gen24 >/dev/null
pw="$(env_get "$F" POSTGRES_PASSWORD)"
check "CHANGE_ME placeholder replaced (48 hex chars)" "48" "${#pw}"
# The generated password is interpolated into five connection URLs unencoded, so
# it must not contain anything a URL parser would treat as a delimiter.
check "generated password is URL-safe" "safe" \
    "$(case "$pw" in *[^A-Za-z0-9._~-]*) echo unsafe ;; *) echo safe ;; esac)"

env_set "$F" IMPERSONATION_SECRET ""
keep_or_gen "$F" IMPERSONATION_SECRET gen32 >/dev/null
sec="$(env_get "$F" IMPERSONATION_SECRET)"
# config/env.ts enforces z.string().min(32) on the three JWT-family secrets.
check "empty value generated, clears the min(32) in config/env.ts" "yes" \
    "$([ "${#sec}" -ge 32 ] && echo yes || echo no)"

echo
echo "set_if_missing — only fills a gap"
set_if_missing "$F" PORT 9999
check "present value not overwritten" "4000" "$(env_get "$F" PORT)"
set_if_missing "$F" ALLOWED_ORIGINS "https://example.com"
check "missing value filled" "https://example.com" "$(env_get "$F" ALLOWED_ORIGINS)"

echo
if [ "$fails" -eq 0 ]; then
    echo "✅ All env-file helper checks passed."
else
    echo "❌ $fails check(s) failed."
    exit 1
fi
