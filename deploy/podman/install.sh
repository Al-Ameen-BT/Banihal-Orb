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

# ── Env files ────────────────────────────────────────────────────────────────
# Secrets live here, on the host, mode 0600 — never in a unit file and never in
# an image layer (a layer is readable by anyone who can pull it). Seeded from the
# existing deploy so the containers inherit the values already in use.
mkdir -p "$CONF_DIR"
chmod 0755 "$CONF_DIR"
for pair in "server/.env:server.env" "client/.env:client.env"; do
    src="$ROOT/${pair%%:*}"; dst="$CONF_DIR/${pair##*:}"
    if [ ! -f "$dst" ]; then
        if [ -f "$src" ]; then
            echo "  Seeding $dst from ${pair%%:*}"
            install -m 0600 "$src" "$dst"
        else
            echo "  ⚠️  $dst missing and no $src to seed it from — create it before starting."
        fi
    else
        echo "  Keeping existing $dst"
    fi
done

if [ ! -f "$CONF_DIR/postgres.env" ]; then
    cat > "$CONF_DIR/postgres.env" <<'EOF'
# Superuser for the containerized cluster. The five application databases are
# created by server/db/provision.sh, not by the image's POSTGRES_DB.
POSTGRES_USER=postgres
POSTGRES_PASSWORD=CHANGE_ME
EOF
    chmod 0600 "$CONF_DIR/postgres.env"
    echo "  ⚠️  Wrote $CONF_DIR/postgres.env with a placeholder password — set it before starting."
fi

echo "🔄 Reloading systemd (regenerates units from the Quadlet files)"
systemctl daemon-reload

cat <<'EOF'

✅ Units installed. Nothing has been started; b2b.service is untouched.

Next, in order:
  1. Edit /etc/b2b/postgres.env, server.env and client.env.
     In server.env, point the URLs at the containers and set the proxy subnet:
       DATABASE_URL="postgresql://postgres:...@b2b-postgres:5432/b2b?schema=public"
       REDIS_URL="redis://b2b-redis:6379"
       TRUST_PROXY="10.89.10.0/24"     # NOT 'loopback' once nginx is a container
  2. systemctl start b2b-postgres b2b-redis
  3. ./deploy/podman/migrate-db.sh          # copies the five DBs off the host cluster
  4. ./deploy/podman/build.sh
  5. systemctl start b2b-api b2b-web        # parallel-run and smoke-test first
  6. systemctl start b2b-nginx              # cutover: stop host nginx first
  7. systemctl enable b2b-postgres b2b-redis b2b-api b2b-web b2b-nginx
EOF
