#!/usr/bin/env bash
# squid-agent.sh — telemetry and heartbeat agent.
#
# Talks ONLY to the platform control API (`/api/proxy-agent/*`), signing every
# request with the per-proxy registration key (HMAC-SHA256).
# Polls to maintain a heartbeat, and pushes telemetry (access logs, stats).
#
# *Note*: Config pull mechanism has been retired. The Slack bot now handles
# configuration changes and applies them directly.
#
# Env knobs:
#   SQUID_PLATFORM   https://origin of the platform (no trailing slash)   [required]
#   SQUID_PROXY_ID   the squid proxy id from the platform                 [required]
#   SQUID_KEY_FILE   file holding the `pk_…` raw key   (default /etc/squid-agent/key)
#   SQUID_INTERVAL   poll seconds                        (default 5)
#   SQUID_TELEMETRY_INTERVAL  telemetry push seconds  (default 60)
#   SQUID_TELEMETRY_HELPER    path to the telemetry helper (default
#                             /usr/local/libexec/squid-agent-telemetry.py)
set -u

: "${SQUID_PLATFORM:?SQUID_PLATFORM is required}"
: "${SQUID_PROXY_ID:?SQUID_PROXY_ID is required}"
: "${SQUID_INTERVAL:=5}"
: "${SQUID_TELEMETRY_INTERVAL:=60}"
KEY_FILE="${SQUID_KEY_FILE:/etc/squid-agent/key}"
PLATFORM="$SQUID_PLATFORM"
SHASUM_EMPTY="e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
TELEMETRY_HELPER="${SQUID_TELEMETRY_HELPER:-/usr/local/libexec/squid-agent-telemetry.py}"

log() { printf '[%s] squid-agent(%s) %s\n' "$(date '+%F %T')" "$SQUID_PROXY_ID" "$*" | tee -a /var/log/squid-agent.log; }
e() { log "fatal: $*"; exit 1; }

[[ -r "$KEY_FILE" ]] || e "key file $KEY_FILE not readable"
KEY="$(tr -d '\r\n ' <"$KEY_FILE")"

sign() { # sign METHOD path bodyhash ts  -> hex HMAC (canonical form as on platform)
  { printf '%s\n%s\n%s\n%s' "$4" "$1" "$2" "$3"; } | \
    openssl dgst -sha256 -hmac "$KEY" -binary | xxd -p -c 256 | tr -d '\n'
}

poll() {
  # The platform uses this endpoint to register the proxy as online.
  local ts sig resp http
  ts="$(date +%s%3N)"; sig="$(sign GET /api/proxy-agent/poll "$SHASUM_EMPTY" "$ts")"
  resp="$(curl -sS --max-time 20 -w '\n%{http_code}' "$PLATFORM/api/proxy-agent/poll" \
    -H "X-Proxy-Id: $SQUID_PROXY_ID" -H "X-Proxy-Timestamp: $ts" -H "Authorization: Bearer $sig")" || { log "poll transport error"; return; }
  http="${resp##*$'\n'}"
  if [[ "$http" != "200" ]]; then log "poll rejected (HTTP $http) — check proxy id/key"; return; fi
}

# Push a telemetry snapshot at most every SQUID_TELEMETRY_INTERVAL seconds.
telemetry() {
  command -v python3 >/dev/null 2>&1 || return 0
  local last now
  last="$(cat /var/run/squid-agent-telemetry 2>/dev/null || echo 0)"
  now="$(date +%s)"
  (( now - last >= SQUID_TELEMETRY_INTERVAL )) || return 0
  echo "$now" >/var/run/squid-agent-telemetry
  python3 "$TELEMETRY_HELPER" >>/var/log/squid-agent.log 2>&1 \
    || log "telemetry push failed (helper)"
}

log "agent up (platform $PLATFORM, poll ${SQUID_INTERVAL}s)"
while true; do poll; telemetry; sleep "$SQUID_INTERVAL"; done