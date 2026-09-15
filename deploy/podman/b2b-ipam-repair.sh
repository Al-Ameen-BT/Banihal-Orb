#!/usr/bin/env bash
# b2b-ipam-repair.sh — clear Podman IPAM stale leases on the b2b network after an
# unclean shutdown (crash / power loss / kernel panic), BEFORE any pod joins the
# network.
#
# Marker semantics (/var/lib/b2b-ipam-repair/clean-shutdown.marker):
#   touched by b2b-clean-shutdown-marker.service's ExecStop on every CLEAN
#   shutdown; purged here at boot. present => previous shutdown was clean,
#   absent   => unclean shutdown (or very first boot).
set -euo pipefail

MARKER_DIR=/var/lib/b2b-ipam-repair
MARKER="$MARKER_DIR/clean-shutdown.marker"
NETWORK=b2b

log() { echo "b2b-ipam-repair: $*" >&2; }

mkdir -p "$MARKER_DIR"

if [[ -f "$MARKER" ]]; then
    rm -f "$MARKER"
    log "previous shutdown was clean - no IPAM repair needed"
    exit 0
fi

log "previous shutdown was UNCLEAN - dropping '$NETWORK' network so the quadlet unit recreates it"

# No systemctl calls here, and deliberately none: this unit is ordered Before
# b2b-network.service (and every member), so the network is torn down while
# nothing is attached, and the quadlet network unit (`podman network create
# --ignore`) recreates it on its own start — the only reliable way to purge
# netavark's sqlite IPAM after an unclean shutdown. Restarting/stopping
# b2b-network.service FROM this unit (a required dependency, per the earlier
# design) cancelled the repair job with SIGTERM and bounced the network into
# systemd's start-limit rule, taking the whole stack down.

if podman network exists "$NETWORK" 2>/dev/null; then
    attached=$(podman network inspect "$NETWORK" \
        --format '{{len .Containers}}' 2>/dev/null || echo 0)
    if [[ "$attached" != "0" ]]; then
        log "WARNING: '$NETWORK' still has $attached attached container(s) - NOT removing"
        exit 0
    fi
    if podman network rm "$NETWORK" >/dev/null 2>&1; then
        log "'$NETWORK' network removed - IPAM leases cleared"
    else
        log "WARNING: failed to remove '$NETWORK' network - stale lease may persist"
    fi
else
    log "'$NETWORK' network does not exist - nothing to repair"
fi

# The quadlet b2b-network.service runs next and recreates the network fresh.

exit 0