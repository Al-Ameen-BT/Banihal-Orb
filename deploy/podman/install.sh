#!/usr/bin/env bash
# ============================================================================
# install.sh — install the Quadlet units and the container nginx config.
#
#   sudo ./deploy/podman/install.sh
#
# Idempotent. Installs units only; it does NOT start anything and does NOT touch
# the running b2b.service — starting the stack is a deliberate, separate step so
# this can be run safely on a live host.
# ============================================================================
set -euo pipefail

if [ "$EUID" -ne 0 ]; then
    echo "🔒 This script must be run with sudo or as root."
    exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
UNIT_DIR=/etc/containers/systemd
CONF_DIR=/etc/b2b

command -v podman >/dev/null || { echo "❌ podman is not installed. apt install podman"; exit 1; }

# .pod Quadlet units need Podman 4.4+ for containers and 5.0+ for pods.
PODMAN_MAJOR="$(podman version --format '{{.Client.Version}}' | cut -d. -f1)"
if [ "$PODMAN_MAJOR" -lt 5 ]; then
    echo "❌ Podman $PODMAN_MAJOR detected; .pod Quadlet units need 5.0+."
    echo "   Either upgrade, or drop the .pod files and create the pods with"
    echo "   'podman pod create' from an ExecStartPre in each .container unit."
    exit 1
fi

echo "📦 Installing Quadlet units to $UNIT_DIR"
mkdir -p "$UNIT_DIR"
install -m 0644 "$ROOT"/deploy/podman/*.network   "$UNIT_DIR"/
install -m 0644 "$ROOT"/deploy/podman/*.volume    "$UNIT_DIR"/
install -m 0644 "$ROOT"/deploy/podman/*.pod       "$UNIT_DIR"/
install -m 0644 "$ROOT"/deploy/podman/*.container "$UNIT_DIR"/

echo "📦 Installing container nginx config to $CONF_DIR/nginx"
mkdir -p "$CONF_DIR/nginx"
install -m 0644 "$ROOT/deploy/nginx/b2b-site.container.conf" "$CONF_DIR/nginx/b2b-site.conf"

# ── Boot-time b2b network IPAM repair (hand-written units, NOT Quadlet) ──────
# After an unclean shutdown netavark's sqlite IPAM can hold stale leases for the
# pods' pinned addresses, so the pods then fail to start with an IPAM collision.
# b2b-ipam-repair.service drops the b2b network at boot and lets the Quadlet
# network unit recreate it fresh — but only when the last shutdown was unclean
# (detected by an absent marker that b2b-clean-shutdown-marker.service touches on
# every clean shutdown). These live in /etc/systemd/system, not the Quadlet dir.
install -m 0755 "$ROOT/deploy/podman/b2b-ipam-repair.sh" /usr/local/sbin/b2b-ipam-repair.sh
install -m 0644 "$ROOT/deploy/podman/b2b-clean-shutdown-marker.service" /etc/systemd/system/b2b-clean-shutdown-marker.service
install -m 0644 "$ROOT/deploy/podman/b2b-ipam-repair.service" /etc/systemd/system/b2b-ipam-repair.service

# ── Env files are NOT written here ───────────────────────────────────────────
# build.sh owns /etc/b2b/{server,client,postgres}.env. This script used to seed
# them by copying the repo's server/.env, and that is precisely how the
# deployment broke: those files are quoted (KEY="value") because every .env is,
# but Quadlet's EnvironmentFile= becomes `podman run --env-file`, which reads the
# value VERBATIM — quotes included. The API then failed config/env.ts validation
# and restart-looped, visible only as "systemctl restart b2b-api failed".
#
# build.sh generates the secrets, derives the container-topology values, and
# strips quotes from anything hand-edited, so there is one owner and one format.

echo "🔄 Reloading systemd (regenerates units from the Quadlet files)"
systemctl daemon-reload

# The IPAM repair + clean-shutdown marker units must be present at every boot.
systemctl enable b2b-ipam-repair.service b2b-clean-shutdown-marker.service >/dev/null 2>&1 || true

cat <<'EOF'

✅ Units installed. Nothing has been started; b2b.service is untouched.

Next:
  1. sudo ./deploy/podman/build.sh
     Writes /etc/b2b/{server,client,postgres}.env (generating the JWT, VAPID and
     Postgres secrets), builds both images, then creates and verifies the five
     databases. Asks once for this host's public origin, admin email domains and
     SMTP; a re-run prompts for nothing and regenerates nothing.

  2. systemctl start b2b-api b2b-web        # parallel-run and smoke-test first
  3. systemctl start b2b-nginx              # cutover: stop host nginx first
  4. systemctl enable b2b-postgres b2b-redis b2b-api b2b-web b2b-nginx

Migrating from an existing bare-metal cluster? Run ./deploy/podman/migrate-db.sh
with the application STOPPED, between steps 1 and 2.

To tear it all down: ./deploy/podman/drop.sh  (add --all-gone to destroy the
databases and uploads too).
EOF
