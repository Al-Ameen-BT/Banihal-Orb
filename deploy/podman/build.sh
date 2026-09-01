#!/usr/bin/env bash
# ============================================================================
# build.sh — build the API and web images.
#
#   ./deploy/podman/build.sh [tag]
#
# Every build is tagged BOTH :latest and :<tag> (default: the short git sha).
# That second tag is the rollback artifact — the main thing containers buy over
# the in-place systemd deploy:
#
#   podman tag localhost/b2b-api:<previous-sha> localhost/b2b-api:latest
#   systemctl restart b2b-api
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TAG="${1:-$(git rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M%S)}"

# ── Client build args ────────────────────────────────────────────────────────
# NEXT_PUBLIC_* are INLINED INTO THE BROWSER BUNDLE at `next build`, so they must
# be correct HERE — setting them in the Quadlet unit later does nothing.
#
# Sourced from the same client env file the deployment uses, so there is one
# source of truth rather than a value duplicated into this script.
CLIENT_ENV="${CLIENT_ENV:-/etc/b2b/client.env}"
if [ -f "$CLIENT_ENV" ]; then
    # shellcheck disable=SC1090
    set -a; . "$CLIENT_ENV"; set +a
else
    echo "⚠️  $CLIENT_ENV not found — falling back to client/.env"
    [ -f client/.env ] && { set -a; . client/.env; set +a; }
fi

if [ -z "${NEXT_PUBLIC_API_URL:-}" ]; then
    # Not a warning. The image builds fine and every browser API call fails once
    # deployed, which is a much more expensive way to discover this.
    echo "❌ NEXT_PUBLIC_API_URL is not set."
    echo "   It is baked into the browser bundle at build time and cannot be fixed at runtime."
    echo "   Set it in $CLIENT_ENV to this site's own https:// origin, then rebuild."
    exit 1
fi

echo "🏗️  Building b2b-api:$TAG"
podman build -f Containerfile.api -t "localhost/b2b-api:$TAG" -t localhost/b2b-api:latest .

echo "🏗️  Building b2b-web:$TAG  (NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL)"
podman build -f Containerfile.web \
    --build-arg "NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL" \
    --build-arg "NEXT_PUBLIC_VAPID_PUBLIC_KEY=${NEXT_PUBLIC_VAPID_PUBLIC_KEY:-}" \
    -t "localhost/b2b-web:$TAG" -t localhost/b2b-web:latest .

echo
echo "✅ Built localhost/b2b-api:$TAG and localhost/b2b-web:$TAG (also tagged :latest)"
echo "   Apply with:  systemctl restart b2b-api b2b-web"
