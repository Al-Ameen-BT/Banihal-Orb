#!/usr/bin/env bash
# squid-agent.sh — pull-based Squid config agent.
#
# Talks ONLY to the platform control API (`/api/proxy-agent/*`), signing every
# request with the per-proxy registration key (HMAC-SHA256). Pulls a signed
# config bundle when the platform revision advances, validates it with
# `squid -k parse`, hot-reloads via `squid -k reconfigure`, and acks the result.
# No inbound ports: the userland never listens.
#
# Env knobs:
#   SQUID_PLATFORM   https://origin of the platform (no trailing slash)   [required]
#   SQUID_PROXY_ID   the squid proxy id from the platform                 [required]
#   SQUID_KEY_FILE   file holding the `pk_…` raw key   (default /etc/squid-agent/key)
#   SQUID_INTERVAL   poll seconds                        (default 5)
#   SQUID_CONF_DIR   generated conf dir                  (default /etc/squid/acls)
#   SQUID_PUBKEY     PEM with the bundle public key. If set, bundles are
#                    signature-checked before apply. If unset, the agent DOES
#                    NOT apply unsigned bundles (safety first).
#   SQUID_TELEMETRY_INTERVAL  telemetry push seconds  (default 60)
#   SQUID_TELEMETRY_HELPER    path to the telemetry helper (default
#                             /usr/local/libexec/squid-agent-telemetry.py)
set -u

: "${SQUID_PLATFORM:?SQUID_PLATFORM is required}"
: "${SQUID_PROXY_ID:?SQUID_PROXY_ID is required}"
: "${SQUID_INTERVAL:=5}"
: "${SQUID_CONF_DIR:=/etc/squid/acls}"
: "${SQUID_TELEMETRY_INTERVAL:=60}"
KEY_FILE="${SQUID_KEY_FILE:/etc/squid-agent/key}"
SQUID_MAIN_CONF="${SQUID_MAIN_CONF:/etc/squid/squid.conf}"
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

# Decode the poll response with node exactly as the platform built the bundle:
# writes <work>/_canon.json (the signed canonical bytes) + one file per entry,
# and echoes `seq signature` if a bundle is pending, else nothing.
decode_bundle() { # decode_bundle workdir <json>  -> "seq sig" | empty
  node -e '
    const fs=require("fs");
    const [dest, json] = [process.argv[1], fs.readFileSync(0,"utf8")];
    const resp=JSON.parse(json);
    if(!resp.pending) process.exit(0);
    const seq=resp.pending.seq, files=resp.pending.files;
    fs.writeFileSync(dest+"/_canon.json", JSON.stringify({seq,files}));
    for(const f of files){
      const safe=f.path.replace(/[^A-Za-z0-9._\/-]/g,"_");
      const out=dest+"/"+safe.replace(/^\/+/,"").split("/").pop();
      fs.writeFileSync(out, f.content);
    }
    process.stdout.write(seq+" "+resp.pending.signature);
  ' "$1" <<< "$2"
}

verify_bundle() { # verify_bundle seq canonbytes sigfile pubpem -> 0 ok
  local seq="$1" sig="$2" pub="$3" canon="$4"
  node -e '
    const fs=require("fs"),crypto=require("crypto");
    try{
      const [seq,sig,pub,canon]=process.argv.slice(1);
      const ok=crypto.verify(null,fs.readFileSync(canon),crypto.createPublicKey(fs.readFileSync(pub,"utf8")),Buffer.from(sig,"base64"));
      process.exit(ok?0:1);
    }catch(e){ process.exit(2); }
  ' "$seq" "$sig" "$pub" "$canon" 2>/dev/null
}

send_result() { # send_result seq ok error
  local seq="$1" ok="$2" err="${3:-}"
  local body; [[ "$ok" == true ]] \
    && body="{\"seq\":$seq,\"ok\":true}" \
    || body="{\"seq\":$seq,\"ok\":false,\"error\":\"${err//\"/\\\"}\"}"
  local hash ts sig
  hash="$(printf '%s' "$body" | openssl dgst -sha256 -binary | xxd -p -c 256 | tr -d '\n')"
  ts="$(date +%s%3N)"; sig="$(sign POST /api/proxy-agent/result "$hash" "$ts")"
  curl -sS --max-time 20 -X POST "$PLATFORM/api/proxy-agent/result" \
    -H 'Content-Type: application/json' \
    -H "X-Proxy-Id: $SQUID_PROXY_ID" -H "X-Proxy-Timestamp: $ts" -H "Authorization: Bearer $sig" \
    --data "$body" >/dev/null || log "ack failed seq=$seq"
}

apply() { # apply <workdir>
  local dir="$1" f
  # One generated include, then validate the WHOLE conf before reloading.
  grep -q "$SQUID_CONF_DIR" "$SQUID_MAIN_CONF" 2>/dev/null || \
    printf 'include %s/*.conf\n' "$SQUID_CONF_DIR" >> "$SQUID_MAIN_CONF"
  for f in "$dir"/*; do
    [[ "$(basename "$f")" == "_canon.json" ]] && continue
    cp -f "$f" "$SQUID_CONF_DIR/" || return 1
    chmod 0644 "$SQUID_CONF_DIR/$(basename "$f")"
  done
  squid -k parse -f "$SQUID_MAIN_CONF" >>/var/log/squid-agent.log 2>&1 || return 1
  squid -k reconfigure >>/var/log/squid-agent.log 2>&1 || return 1
}

poll() {
  local ts sig resp http json
  ts="$(date +%s%3N)"; sig="$(sign GET /api/proxy-agent/poll "$SHASUM_EMPTY" "$ts")"
  resp="$(curl -sS --max-time 20 -w '\n%{http_code}' "$PLATFORM/api/proxy-agent/poll" \
    -H "X-Proxy-Id: $SQUID_PROXY_ID" -H "X-Proxy-Timestamp: $ts" -H "Authorization: Bearer $sig")" || { log "poll transport error"; return; }
  http="${resp##*$'\n'}"; json="${resp%$'\n'*}"
  if [[ "$http" != "200" ]]; then log "poll rejected (HTTP $http) — check proxy id/key"; return; fi

  local workdir="/tmp/squid-agent-$SQUID_PROXY_ID" meta
  mkdir -p "$workdir" "$SQUID_CONF_DIR"
  meta="$(decode_bundle "$workdir" "$json")"
  [[ -n "$meta" ]] || return
  local seq="${meta%% *}" sig="${meta#* }"
  log "bundle pending seq=$seq"

  # Safety first: unsigned/unverifiable bundles are never applied.
  if [[ -z "${SQUID_PUBKEY:-}" || ! -r "$SQUID_PUBKEY" ]]; then
    log "SQUID_PUBKEY not pinned — refusing to apply seq=$seq"
    rm -rf "$workdir"; sleep "$SQUID_INTERVAL"; return
  fi
  if ! verify_bundle "$seq" "$sig" "$SQUID_PUBKEY" "$workdir/_canon.json"; then
    log "signature verification FAILED seq=$seq — not applying"
    send_result "$seq" false "signature verification failed"
    rm -rf "$workdir"; return
  fi

  if apply "$workdir"; then send_result "$seq" true; log "applied seq=$seq"; else
    send_result "$seq" false "apply failed"
    log "apply FAILED seq=$seq"
  fi
  rm -rf "$workdir"
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