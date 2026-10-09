#!/usr/bin/env bash
# ============================================================================
# migrate-db.sh — copy the five application databases from the HOST PostgreSQL
# cluster into the containerized one.
#
#   ./deploy/podman/migrate-db.sh
#
# Read-only against the host cluster: it dumps, it never drops or alters. The
# host cluster is the rollback, so leave it running and intact until at least one
# backup cycle has passed after cutover.
#
# Run it with the application STOPPED, or the dump captures a moving target and
# writes made during the copy are silently lost at cutover.
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONTAINER="${CONTAINER:-b2b-postgres}"
HOST_PSQL="${HOST_PSQL:-sudo -u postgres}"
DUMP_DIR="${DUMP_DIR:-/var/tmp/b2b-migrate-$(date +%Y%m%d-%H%M%S)}"

# 00_databases.sql creates all five; b2b_ticketing_admin's SCHEMA is loaded
# separately from a pg dump (see server/db/provision.sh), but its DATA still has
# to come across here like the rest.
DBS=(b2b b2b_chat b2b_ticketing b2b_ticketing_admin b2b_ticket)

podman container exists "$CONTAINER" || {
    echo "❌ Container '$CONTAINER' not found. systemctl start b2b-postgres first."
    exit 1
}

echo "⏸️  Is the application stopped? A dump taken while it writes loses those writes."
read -r -p "   Type 'yes' to continue: " ok
[ "$ok" = "yes" ] || { echo "Aborted."; exit 1; }

mkdir -p "$DUMP_DIR"
echo "📁 Dumps: $DUMP_DIR"

# ── Dump ─────────────────────────────────────────────────────────────────────
# Custom format (-Fc): compressed, and restorable with pg_restore's error
# handling rather than a plain SQL stream that keeps going after a failure.
for db in "${DBS[@]}"; do
    echo "  ⬇️  $db"
    $HOST_PSQL pg_dump -Fc "$db" > "$DUMP_DIR/$db.dump"
done

# ── Restore ──────────────────────────────────────────────────────────────────
for db in "${DBS[@]}"; do
    echo "  ⬆️  $db"
    # createdb is expected to fail on a re-run; the restore below is what matters.
    podman exec "$CONTAINER" createdb -U postgres "$db" 2>/dev/null || true
    # --clean --if-exists makes this re-runnable: it drops the objects it is about
    # to recreate instead of erroring on every one of them the second time.
    podman exec -i "$CONTAINER" pg_restore -U postgres -d "$db" --clean --if-exists \
        < "$DUMP_DIR/$db.dump" || echo "     ⚠️  pg_restore reported errors for $db — review before cutover"
done

# ── Verify ───────────────────────────────────────────────────────────────────
echo
echo "🔎 Row counts — host vs container. These must match."
for db in "${DBS[@]}"; do
    q="SELECT COALESCE(SUM(n_live_tup),0) FROM pg_stat_user_tables;"
    # ANALYZE first: pg_stat_user_tables is an estimate and reads 0 on a freshly
    # restored database until the planner has looked at it — without this every
    # row here reads as a mismatch.
    podman exec "$CONTAINER" psql -U postgres -qc 'ANALYZE;' -d "$db" >/dev/null 2>&1 || true
    host=$($HOST_PSQL psql -tAc "$q" -d "$db" 2>/dev/null || echo '?')
    cont=$(podman exec "$CONTAINER" psql -U postgres -tAc "$q" -d "$db" 2>/dev/null || echo '?')
    flag=""; [ "$host" != "$cont" ] && flag="  ⚠️  MISMATCH"
    printf '   %-22s host=%-10s container=%-10s%s\n' "$db" "$host" "$cont" "$flag"
done

cat <<EOF

✅ Dump/restore complete. Dumps kept at $DUMP_DIR — do not delete them until
   cutover is confirmed.

Next: point server.env at the container and run the app's own preflight, which
fail-fast checks every required database:

   cd $ROOT/server && npm run db:verify
EOF
