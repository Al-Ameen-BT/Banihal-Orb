#!/usr/bin/env bash
# 🔐 B2B-Site — internal HTTPS installer and service checklist (no domain name)
#
# Generates a self-signed certificate covering this server's IPs and hostnames,
# installs b2b-site.conf, and runs the full HTTPS checklist against the live host.
#
# Usage:
#   sudo ./https-nginx.sh                          # auto-detect the primary LAN IP
#   sudo ./https-nginx.sh 172.17.121.200           # name the address explicitly
#   sudo ./https-nginx.sh 172.17.121.200 --san b2b.internal --san 10.0.0.5
#   sudo ./https-nginx.sh --renew-cert             # reissue (IP changed / expiring)
#   sudo ./https-nginx.sh --check-only             # read-only, changes nothing
#
# Let's Encrypt is not used and cannot be: ACME proves control of a PUBLIC DNS
# name, and this host has none. A self-signed certificate gives identical TLS
# encryption — the browser warning is about identity being unvouched-for, which
# is what trusting the certificate on each client resolves.

set -euo pipefail

PRIMARY=""
EXTRA_SANS=()
RENEW_CERT=false
CHECK_ONLY=false

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
TEMPLATE="$SCRIPT_DIR/b2b-site.conf"
SITE_NAME="b2b-site.conf"
AVAILABLE="/etc/nginx/sites-available/$SITE_NAME"
ENABLED="/etc/nginx/sites-enabled/$SITE_NAME"
SSL_DIR="/etc/nginx/ssl"
CRT="$SSL_DIR/b2b-site.crt"
KEY="$SSL_DIR/b2b-site.key"
CERT_DAYS=825   # macOS/iOS refuse to trust server certs valid for longer

# multer accepts 5 files x 10 MB (server/src/modules/ticketing/uploads.ts); the
# proxy must allow more than that or uploads die at nginx with a 413.
MIN_BODY_MB=50

PASS=0; FAIL=0; WARN=0
ok()   { echo "  ✅ $1"; PASS=$((PASS+1)); }
bad()  { echo "  ❌ $1"; FAIL=$((FAIL+1)); }
warn() { echo "  ⚠️  $1"; WARN=$((WARN+1)); }
step() { echo; echo "── $1"; }
die()  { echo "❌ $1" >&2; exit 1; }

# ─── Arguments ───────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case "$1" in
        --san)        EXTRA_SANS+=("${2:-}"); shift ;;
        --renew-cert) RENEW_CERT=true ;;
        --check-only) CHECK_ONLY=true ;;
        -h|--help)    sed -n '2,18p' "$0"; exit 0 ;;
        -*)           die "Unknown option: $1" ;;
        *)            PRIMARY="$1" ;;
    esac
    shift
done

[[ "$EUID" -eq 0 ]] || die "Must run as root (sudo $0 ...)"
[[ -f "$TEMPLATE" ]] || die "Config template not found: $TEMPLATE"

# ─── 1. Preflight ────────────────────────────────────────────────────────────
step "1. Preflight"

command -v nginx   >/dev/null || die "nginx is not installed.  apt install nginx"
command -v curl    >/dev/null || die "curl is not installed.  apt install curl"
command -v openssl >/dev/null || die "openssl is not installed.  apt install openssl"
ok "nginx, curl and openssl present"

NGINX_VER="$(nginx -v 2>&1 | sed 's|.*/||')"
ok "nginx $NGINX_VER"

# `http2 on;` is nginx >= 1.25.1 only. On anything older it is an UNKNOWN
# directive and nginx refuses to start, so pick the form this build understands.
if [[ "$(printf '%s\n1.25.1\n' "$NGINX_VER" | sort -V | head -1)" == "1.25.1" ]]; then
    HTTP2_MODE="modern"; ok "HTTP/2: using 'http2 on;' (nginx >= 1.25.1)"
else
    HTTP2_MODE="legacy"; warn "HTTP/2: nginx < 1.25.1 — rewriting to 'listen 443 ssl http2;'"
fi

# Collect every address this box answers on, so ONE certificate covers whichever
# one a user types. A cert that omits the address the browser used is rejected
# outright, and that is by far the most common self-signed mistake.
mapfile -t HOST_IPS < <(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+(\.[0-9]+){3}$' || true)
[[ -n "$PRIMARY" ]] || PRIMARY="${HOST_IPS[0]:-}"
[[ -n "$PRIMARY" ]] || die "Could not auto-detect an IP. Pass one: sudo $0 <ip-or-hostname>"

SHORT_HOST="$(hostname -s 2>/dev/null || echo '')"
FQDN_HOST="$(hostname -f 2>/dev/null || echo '')"

SAN_IPS=(); SAN_DNS=()
add_san() {
    local v="$1"
    [[ -n "$v" ]] || return 0
    if [[ "$v" =~ ^[0-9]+(\.[0-9]+){3}$ ]]; then
        [[ " ${SAN_IPS[*]-} " == *" $v "* ]] || SAN_IPS+=("$v")
    else
        [[ " ${SAN_DNS[*]-} " == *" $v "* ]] || SAN_DNS+=("$v")
    fi
}
add_san "$PRIMARY"
for ip in "${HOST_IPS[@]-}"; do add_san "$ip"; done
add_san "127.0.0.1"
add_san "localhost"
add_san "$SHORT_HOST"
add_san "$FQDN_HOST"
for s in "${EXTRA_SANS[@]-}"; do add_san "$s"; done

ok "Primary address: $PRIMARY"
ok "Certificate will cover: ${SAN_IPS[*]-} ${SAN_DNS[*]-}"

ORIGIN="https://$PRIMARY"

# ─── 2. Certificate ──────────────────────────────────────────────────────────
if ! $CHECK_ONLY; then
    step "2. Self-signed certificate"

    NEED_CERT=false
    if [[ ! -f "$CRT" || ! -f "$KEY" ]]; then
        NEED_CERT=true; echo "  No certificate yet — generating one."
    elif $RENEW_CERT; then
        NEED_CERT=true; echo "  --renew-cert given — reissuing."
    elif ! openssl x509 -noout -checkip "$PRIMARY" -in "$CRT" >/dev/null 2>&1 \
      && ! openssl x509 -noout -checkhost "$PRIMARY" -in "$CRT" >/dev/null 2>&1; then
        NEED_CERT=true
        echo "  Existing certificate does not cover $PRIMARY (IP changed?) — reissuing."
    fi

    if $NEED_CERT; then
        mkdir -p "$SSL_DIR"
        CNF="$(mktemp)"
        {
            echo "[req]"
            echo "distinguished_name = dn"
            echo "x509_extensions    = v3_req"
            echo "prompt             = no"
            echo "[dn]"
            echo "CN = $PRIMARY"
            echo "O  = B2B-Site Internal"
            echo "[v3_req]"
            echo "basicConstraints = CA:FALSE"
            echo "keyUsage         = digitalSignature, keyEncipherment"
            echo "extendedKeyUsage = serverAuth"
            echo "subjectAltName   = @alt"
            echo "[alt]"
            i=1; for v in "${SAN_IPS[@]-}";  do echo "IP.$i = $v";  i=$((i+1)); done
            i=1; for v in "${SAN_DNS[@]-}"; do echo "DNS.$i = $v"; i=$((i+1)); done
        } > "$CNF"

        [[ -f "$CRT" ]] && cp "$CRT" "$CRT.$(date +%Y%m%d-%H%M%S).bak"
        openssl req -x509 -nodes -newkey rsa:2048 -sha256 -days "$CERT_DAYS" \
            -keyout "$KEY" -out "$CRT" -config "$CNF" -extensions v3_req >/dev/null 2>&1 \
            || { rm -f "$CNF"; die "openssl failed to generate the certificate"; }
        rm -f "$CNF"
        chmod 600 "$KEY"; chmod 644 "$CRT"
        ok "Certificate generated, valid $CERT_DAYS days"
    else
        ok "Existing certificate covers $PRIMARY — leaving it alone"
    fi

    # ─── 3. Install the config ───────────────────────────────────────────────
    step "3. Installing $SITE_NAME"

    if [[ -f "$AVAILABLE" ]]; then
        BACKUP="$AVAILABLE.$(date +%Y%m%d-%H%M%S).bak"
        cp "$AVAILABLE" "$BACKUP"
        ok "Backed up existing config → $BACKUP"
    fi

    cp "$TEMPLATE" "$AVAILABLE"
    if [[ "$HTTP2_MODE" == "legacy" ]]; then
        sed -i 's/^\(\s*\)listen      443 ssl default_server;/\1listen      443 ssl http2 default_server;/' "$AVAILABLE"
        sed -i '/^\s*http2\s*on;/d' "$AVAILABLE"
    fi
    ln -sf "$AVAILABLE" "$ENABLED"
    # This config claims default_server on :80 and :443; leaving the distro
    # default enabled would be a duplicate default_server and nginx refuses to start.
    rm -f /etc/nginx/sites-enabled/default
    nginx -t >/dev/null 2>&1 || { nginx -t; die "Config rejected — nothing reloaded, previous config still live"; }
    systemctl reload nginx
    ok "Config installed and nginx reloaded"
fi

# ─── 4. HTTPS service checklist ──────────────────────────────────────────────
step "4. HTTPS service checklist"

nginx -t >/dev/null 2>&1 && ok "nginx -t passes" || bad "nginx -t FAILS (run 'nginx -t' for detail)"
[[ -L "$ENABLED" || -f "$ENABLED" ]] && ok "$SITE_NAME is enabled" || bad "$SITE_NAME is not in sites-enabled"
[[ -e /etc/nginx/sites-enabled/default ]] && bad "distro 'default' site still enabled — duplicate default_server" || ok "distro default site removed"

# -- upstreams --
LISTEN="$(ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null || echo '')"
grep -q ':3000' <<<"$LISTEN" && ok "frontend listening on :3000" || bad "nothing listening on :3000 (Next.js down → 502)"
grep -q ':3001' <<<"$LISTEN" && ok "API listening on :3001"      || bad "nothing listening on :3001 (API down → 502)"
grep -qE ':443' <<<"$LISTEN"  && ok "nginx listening on :443"     || bad "nothing listening on :443"
if systemctl is-active --quiet b2b.service 2>/dev/null; then
    ok "b2b.service is active"
else
    warn "b2b.service is not active (are you running the apps another way?)"
fi

# -- certificate --
if [[ -f "$CRT" ]]; then
    EXPIRY="$(openssl x509 -enddate -noout -in "$CRT" | cut -d= -f2)"
    DAYS=$(( ( $(date -d "$EXPIRY" +%s) - $(date +%s) ) / 86400 ))
    if   [[ $DAYS -lt 0  ]]; then bad  "certificate EXPIRED $((-DAYS)) days ago — re-run with --renew-cert"
    elif [[ $DAYS -lt 30 ]]; then warn "certificate expires in $DAYS days — re-run with --renew-cert"
    else                          ok   "certificate valid for $DAYS more days"
    fi

    # The address must be in subjectAltName. A matching Common Name has not been
    # accepted by Chrome since v58, so a CN-only cert fails with
    # ERR_CERT_COMMON_NAME_INVALID even though it "looks" correct.
    SAN_LINE="$(openssl x509 -noout -ext subjectAltName -in "$CRT" 2>/dev/null | tail -n +2 | xargs || true)"
    if [[ -n "$SAN_LINE" ]]; then
        ok "subjectAltName: $SAN_LINE"
    else
        bad "certificate has NO subjectAltName — every modern browser will reject it"
    fi
    if openssl x509 -noout -checkip "$PRIMARY" -in "$CRT" >/dev/null 2>&1 \
    || openssl x509 -noout -checkhost "$PRIMARY" -in "$CRT" >/dev/null 2>&1; then
        ok "certificate covers $PRIMARY"
    else
        bad "certificate does NOT cover $PRIMARY — re-run with --renew-cert"
    fi
else
    bad "no certificate at $CRT"
fi

# -- live HTTPS behaviour --
# --cacert (not -k) proves the served chain actually validates against this
# certificate; -k would pass even if nginx were serving something else entirely.
CA=(--cacert "$CRT")
[[ -f "$CRT" ]] || CA=(-k)
code()   { curl -sS "${CA[@]}" -o /dev/null -w '%{http_code}' --max-time 15 "$@" 2>/dev/null || echo 000; }

REDIR="$(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 15 "http://$PRIMARY/" 2>/dev/null || echo '000 -')"
if [[ "$REDIR" == 30[18]*https://* ]]; then ok "http:// redirects to https:// ($REDIR)"
else bad "http:// does not redirect to https:// (got: $REDIR)"; fi

if curl -sS "${CA[@]}" -o /dev/null --max-time 15 "$ORIGIN/" 2>/dev/null; then
    ok "TLS handshake validates against the installed certificate"
else
    bad "TLS handshake FAILED — cert/key mismatch, or :443 not reachable"
fi

HEALTH="$(code "$ORIGIN/health")"
[[ "$HEALTH" == "200" ]] && ok "/health returns 200 through nginx" || bad "/health returned $HEALTH (200 expected)"

ROOT="$(code "$ORIGIN/")"
[[ "$ROOT" =~ ^(200|307|308)$ ]] && ok "app root returns $ROOT" || bad "app root returned $ROOT"

# 401 is the CORRECT answer — it proves the request reached Express and the auth
# middleware ran, rather than nginx handing back its own 404/502.
APIC="$(code "$ORIGIN/api/users/me")"
[[ "$APIC" == "401" ]] && ok "/api reaches the API (401 = auth middleware ran)" \
    || warn "/api/users/me returned $APIC (401 expected when logged out)"

if curl -sS "${CA[@]}" --tlsv1.1 --tls-max 1.1 -o /dev/null --max-time 10 "$ORIGIN/" 2>/dev/null; then
    bad "TLS 1.1 is ACCEPTED — restrict ssl_protocols to TLSv1.2 TLSv1.3"
else
    ok "TLS 1.0/1.1 refused (or unsupported locally)"
fi

# -- upload + streaming limits, read from the effective config --
BODY="$(nginx -T 2>/dev/null | grep -m1 client_max_body_size | grep -oE '[0-9]+' || echo 0)"
if [[ "${BODY:-0}" -ge "$MIN_BODY_MB" ]]; then
    ok "client_max_body_size ${BODY}m covers the ${MIN_BODY_MB}MB upload ceiling"
else
    bad "client_max_body_size is ${BODY}m — ticket uploads need > ${MIN_BODY_MB}m or they 413"
fi

if nginx -T 2>/dev/null | grep -A6 'location = /api/chat' | grep -q 'proxy_buffering off'; then
    ok "assistant SSE has proxy_buffering off"
else
    bad "/api/chat is missing 'proxy_buffering off' — the assistant will appear frozen"
fi

# -- application environment must agree with the origin --
step "5. Application environment"
check_env() { # file, key, expected
    local f="$1" k="$2" want="$3" got
    [[ -f "$f" ]] || { warn "$(basename "$(dirname "$f")")/$(basename "$f") not found — skipping $k"; return; }
    got="$(grep -E "^\s*$k=" "$f" | tail -1 | cut -d= -f2- | tr -d '"'"'"' \r')"
    if [[ -z "$got" ]]; then warn "$k is not set (expected $want)"
    elif [[ "$got" == *"$want"* ]]; then ok "$k = $got"
    else bad "$k = $got (expected $want)"; fi
}
check_env "$PROJECT_DIR/server/.env" ALLOWED_ORIGINS      "$ORIGIN"
check_env "$PROJECT_DIR/server/.env" FRONTEND_URL         "$ORIGIN"
check_env "$PROJECT_DIR/server/.env" COOKIE_SECURE        "true"
check_env "$PROJECT_DIR/server/.env" NODE_ENV             "production"
check_env "$PROJECT_DIR/client/.env" NEXT_PUBLIC_API_URL  "$ORIGIN"

# ─── Summary ─────────────────────────────────────────────────────────────────
echo
echo "──────────────────────────────────────────────"
echo "  ✅ $PASS passed   ⚠️  $WARN warnings   ❌ $FAIL failed"
echo "──────────────────────────────────────────────"

if [[ $FAIL -gt 0 ]]; then
    echo "Investigate with:  sudo nginx -t   |   sudo tail -50 /var/log/nginx/error.log"
    exit 1
fi

cat <<EOF

🎉 HTTPS is live at $ORIGIN

Browsers will warn until this certificate is trusted on each client. TLS is
already encrypting either way — the warning is only about identity. Copy
$CRT to the client and install it:

  Windows  certutil -addstore -f Root b2b-site.crt          (Run as Administrator)
  macOS    sudo security add-trusted-cert -d -r trustRoot \\
             -k /Library/Keychains/System.keychain b2b-site.crt
  Linux    sudo cp b2b-site.crt /usr/local/share/ca-certificates/ && sudo update-ca-certificates
  Firefox  keeps its own store: Settings > Privacy & Security > Certificates >
           View Certificates > Authorities > Import (Firefox ignores the OS store)

Then set these to match the origin and restart the app (sudo systemctl restart b2b):
  server/.env   ALLOWED_ORIGINS=$ORIGIN   FRONTEND_URL=$ORIGIN   COOKIE_SECURE=true
  client/.env   NEXT_PUBLIC_API_URL=$ORIGIN     (a rebuild is required — it is inlined)

If the server's IP ever changes, re-run:  sudo $0 --renew-cert
EOF
exit 0
