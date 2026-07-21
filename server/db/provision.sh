#!/usr/bin/env bash
# ============================================================================
# provision.sh — create + schema-apply the four application databases
# ----------------------------------------------------------------------------
# Idempotent. Safe to re-run. Replaces `prisma db push` as the schema authority.
#
#   Step 1  create databases (needs a superuser)  → 00_databases.sql
#   Step 2  apply each schema to its own database → b2b*.sql
#
# The Administrators' isolated ticket store (b2b_ticketing_admin) is NOT
# provisioned — it falls back to b2b_ticket when ADMIN_TICKETING_DATABASE_URL
# is unset (see src/config/ticketDatabase.ts).
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

for k in DATABASE_URL CHAT_DATABASE_URL TICKETING_DATABASE_URL TICKET_DATABASE_URL; do
  load_from_env "$k"
  if [ -z "${!k:-}" ]; then echo "❌ $k is not set (env or $ENV_FILE)"; exit 1; fi
done

SUPERUSER_PSQL="${SUPERUSER_PSQL:-sudo -u postgres psql}"

echo "🗄️  Step 1/2 — creating databases (skipping b2b_ticketing_admin)…"
$SUPERUSER_PSQL -v ON_ERROR_STOP=1 -f "$DB_DIR/00_databases.sql"

echo "📐 Step 2/2 — applying schemas…"
psql "$DATABASE_URL"           -v ON_ERROR_STOP=1 -f "$DB_DIR/b2b.sql"
psql "$CHAT_DATABASE_URL"      -v ON_ERROR_STOP=1 -f "$DB_DIR/b2b_chat.sql"
psql "$TICKETING_DATABASE_URL" -v ON_ERROR_STOP=1 -f "$DB_DIR/b2b_ticketing.sql"
psql "$TICKET_DATABASE_URL"    -v ON_ERROR_STOP=1 -f "$DB_DIR/b2b_ticket.sql"

echo "✅ Provisioning complete."
