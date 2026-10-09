#!/usr/bin/env bash
# ============================================================================
# drop.sh — tear the containerized stack back down.
#
#   sudo ./deploy/podman/drop.sh              # containers + pods + network
#   sudo ./deploy/podman/drop.sh --all-gone   # ALSO volumes (all DBs, all uploads)
#                                             # and every b2b image
#
# Two modes, deliberately. The default is safe to run at any time — it removes
# everything reconstructible and touches no data, which is what you want when a
# build or a cutover went wrong and you just need the containers recreated.
#
# --all-gone is the full wipe: it destroys b2b-pgdata (all five databases) and
# b2b-uploads (every ticket attachment). There is no undo and no backup taken
# here — take one first if the data matters.
#
# Neither mode touches the Quadlet units in /etc/containers/systemd (install.sh
# owns those) or /etc/b2b/*.env (build.sh owns those), so after either mode a
# single build.sh run brings the stack back with no re-prompting.
# ============================================================================
set -euo pipefail

if [ "$EUID" -ne 0 ]; then
    echo "🔒 This script must be run with sudo or as root."
    exit 1
fi

command -v podman >/dev/null || { echo "❌ podman is not installed."; exit 1; }

ALL_GONE=false
ASSUME_YES=false
while [ $# -gt 0 ]; do
    case "$1" in
        --all-gone) ALL_GONE=true ;;
        --yes|-y)   ASSUME_YES=true ;;
        *) echo "❌ Unknown option: $1"; echo "   Usage: $0 [--all-gone] [--yes]"; exit 1 ;;
    esac
    shift
done

SERVICES=(b2b-nginx b2b-web b2b-api b2b-redis b2b-postgres)
CONTAINERS=(b2b-nginx b2b-web b2b-api b2b-redis b2b-postgres)
PODS=(b2b-nginx b2b-app b2b-redis b2b-postgres)
VOLUMES=(b2b-pgdata b2b-uploads)

# ── Confirm, while there is still something to lose ──────────────────────────
if [ "$ALL_GONE" = true ] && [ "$ASSUME_YES" = false ]; then
    echo "⚠️  --all-gone destroys the following PERMANENTLY:"
    for v in "${VOLUMES[@]}"; do
        if podman volume exists "$v" 2>/dev/null; then
            size=$(podman volume inspect "$v" --format '{{.Mountpoint}}' 2>/dev/null \
                   | xargs -r du -sh 2>/dev/null | cut -f1)
            printf '     volume %-14s %s\n' "$v" "${size:-unknown size}"
        fi
    done
    podman images --filter 'reference=localhost/b2b-*' \
        --format '     image  {{.Repository}}:{{.Tag}}  {{.Size}}' 2>/dev/null || true
    echo
    echo "   b2b-pgdata is all five databases. b2b-uploads is every ticket attachment."
    read -r -p "   Type 'all-gone' to continue: " ok
    [ "$ok" = "all-gone" ] || { echo "Aborted — nothing was removed."; exit 1; }
fi

# ── Stop ─────────────────────────────────────────────────────────────────────
# Stopped before anything is removed, or Restart=always recreates a container
# out from under us. `|| true` throughout: a partially-installed host is the
# normal case for this script, and a missing unit is not an error here.
echo "⏹️  Stopping services"
systemctl stop "${SERVICES[@]}" 2>/dev/null || true
systemctl disable "${SERVICES[@]}" 2>/dev/null || true

# ── Containers, pods, network ────────────────────────────────────────────────
echo "🧹 Removing containers"
for c in "${CONTAINERS[@]}"; do
    podman rm -f "$c" >/dev/null 2>&1 && echo "     removed $c" || true
done

echo "🧹 Removing pods"
for p in "${PODS[@]}"; do
    podman pod rm -f "$p" >/dev/null 2>&1 && echo "     removed pod $p" || true
done

echo "🧹 Removing network"
podman network rm b2b >/dev/null 2>&1 && echo "     removed network b2b" || true

# ── The destructive half ─────────────────────────────────────────────────────
if [ "$ALL_GONE" = true ]; then
    echo "💥 Removing volumes (databases + uploads)"
    for v in "${VOLUMES[@]}"; do
        podman volume rm -f "$v" >/dev/null 2>&1 && echo "     removed volume $v" || true
    done

    echo "💥 Removing images"
    # By id, so every tag of an image (:latest AND the :<git-sha> rollback tags)
    # goes in one call instead of leaving dangling tags behind.
    ids=$(podman images --filter 'reference=localhost/b2b-*' --format '{{.ID}}' 2>/dev/null | sort -u)
    if [ -n "$ids" ]; then
        # shellcheck disable=SC2086
        podman rmi -f $ids >/dev/null 2>&1 || true
        echo "     removed $(echo "$ids" | wc -l) image(s)"
    fi
fi

systemctl daemon-reload

# ── What survived ────────────────────────────────────────────────────────────
echo
echo "✅ Teardown complete."
if [ "$ALL_GONE" = true ]; then
    cat <<'EOF'
   Gone: containers, pods, network, volumes (all databases + uploads), images.
   Kept: Quadlet units in /etc/containers/systemd, config in /etc/b2b.

   Rebuild from here with build.sh alone — install.sh is not needed again and
   the generated secrets in /etc/b2b/server.env are reused, so nothing prompts:

     sudo ./deploy/podman/build.sh
     sudo systemctl start b2b-api b2b-web b2b-nginx
EOF
else
    echo "   Kept: volumes $(printf '%s ' "${VOLUMES[@]}")(databases + uploads), images, units, /etc/b2b."
    echo "   Data is intact. Bring the stack back with:"
    echo
    echo "     sudo ./deploy/podman/build.sh"
    echo "     sudo systemctl start b2b-api b2b-web b2b-nginx"
    echo
    echo "   To destroy the data too, re-run with --all-gone."
fi
