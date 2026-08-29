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

echo "🗄️  Step 1/2 — creating databases…"
$SUPERUSER_PSQL -v ON_ERROR_STOP=1 -f "$DB_DIR/00_databases.sql"

echo "📐 Step 2/2 — applying schemas…"
psql "$(psql_url "$DATABASE_URL")"           -v ON_ERROR_STOP=1 -f "$DB_DIR/b2b.sql"
psql "$(psql_url "$CHAT_DATABASE_URL")"      -v ON_ERROR_STOP=1 -f "$DB_DIR/b2b_chat.sql"
psql "$(psql_url "$TICKETING_DATABASE_URL")" -v ON_ERROR_STOP=1 -f "$DB_DIR/b2b_ticketing.sql"
psql "$(psql_url "$TICKET_DATABASE_URL")"    -v ON_ERROR_STOP=1 -f "$DB_DIR/b2b_ticket.sql"
# The Administrators' isolated store is the SAME 14-table schema in its own
# database. Upstream loads it from the `ticketingDB` pg dump, which is not in this
# repo — b2b_ticket.sql is idempotent and non-destructive, so applying it here
# gives a from-scratch install a working admin store instead of a schemaless one.
psql "$(psql_url "$ADMIN_TICKETING_DATABASE_URL")" -v ON_ERROR_STOP=1 -f "$DB_DIR/b2b_ticket.sql"

echo "✅ Provisioning complete."
