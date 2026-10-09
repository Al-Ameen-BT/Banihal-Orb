#!/usr/bin/env bash
# ============================================================================
# local-setup.sh — one-shot local test environment: Postgres → schemas → seed.
# ----------------------------------------------------------------------------
# Only the install step needs sudo; everything after it runs as you. Idempotent —
# re-running re-seeds without touching an already-installed server.
#
#   bash server/db/local-setup.sh
# ============================================================================
set -euo pipefail

DB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$DB_DIR/.."

if ! command -v psql >/dev/null 2>&1; then
  echo "📦 Installing PostgreSQL (sudo required)…"
  sudo apt-get update
  sudo apt-get install -y postgresql postgresql-contrib
fi

# The service name differs between init systems; try systemd, fall back to pg_ctlcluster.
if ! pg_isready -q 2>/dev/null; then
  echo "▶️  Starting PostgreSQL…"
  sudo systemctl start postgresql 2>/dev/null \
    || sudo pg_ctlcluster "$(ls /etc/postgresql | head -1)" main start
fi

# server/.env connects as postgres/postgres over TCP, but a fresh install leaves
# the `postgres` role password-less and peer-only — so set it once.
echo "🔑 Setting the postgres role password…"
sudo -u postgres psql -qc "ALTER USER postgres WITH PASSWORD 'postgres';"

echo "🗄️  Provisioning databases + schemas…"
bash "$DB_DIR/provision.sh"

echo "🌱 Seeding ticket data…"
cd "$SERVER_DIR" && npm run db:seed:tickets

echo
echo "✅ Done. Start the two processes:"
echo "   server/   npm run dev      # Node API      :3001"
echo "   client/   npm run dev      # Next.js       :3000"
echo "   then open http://localhost:3000/dashboard/ops"
