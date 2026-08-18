#!/usr/bin/env bash
# 🔐 B2B-Site — internal HTTPS installer and service checklist (no domain name)
#
# Generates a self-signed certificate covering this server's IPs and hostnames,
# installs b2b-site.conf, opens the firewall, and runs the full HTTPS checklist.
#
# Works on both nginx layouts:
#   Debian/Ubuntu  sites-available + sites-enabled symlink
#   RHEL/Rocky/Alma/CentOS  conf.d/*.conf  (no sites-enabled at all)
#
# Usage:
#   sudo ./https-nginx.sh                          # auto-detect the primary LAN IP
#   sudo ./https-nginx.sh 172.17.121.200           # name the address explicitly
#   sudo ./https-nginx.sh 172.17.121.200 --san b2b.internal --san 10.0.0.5
#   sudo ./https-nginx.sh --renew-cert             # reissue (IP changed / expiring)
#   sudo ./https-nginx.sh --check-only             # read-only, changes nothing
#   sudo ./https-nginx.sh --fix-env                # write the origin into both .env files
#
# The exact .env values for this server's origin are ALWAYS printed at the end,
# pass or fail. --fix-env writes them for you (both files are backed up first).
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
FIX_ENV=false

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="$SCRIPT_DIR/b2b-site.conf"
SITE_NAME="b2b-site.conf"
NGINX_CONF="/etc/nginx/nginx.conf"
BACKUP_DIR="/var/backups/b2b-nginx"
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
        --fix-env)    FIX_ENV=true ;;
        -h|--help)    sed -n '2,27p' "$0"; exit 0 ;;
        -*)           die "Unknown option: $1" ;;
        *)            PRIMARY="$1" ;;
    esac
    shift
done

[[ "$EUID" -eq 0 ]] || die "Must run as root (sudo $0 ...)"
[[ -f "$TEMPLATE" ]] || die "Config template not found: $TEMPLATE
Keep https-nginx.sh and b2b-site.conf together in the same directory."

# Find the project root by walking up until server/.env is plausible; falls back
# to two levels up (repo/deploy/nginx). Only used for the .env consistency check,
# so a miss downgrades to a warning rather than stopping the install.
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." 2>/dev/null && pwd || echo "$SCRIPT_DIR")"

# ─── 1. Preflight ────────────────────────────────────────────────────────────
step "1. Preflight"

command -v nginx   >/dev/null || die "nginx is not installed.  dnf install nginx  |  apt install nginx"
command -v curl    >/dev/null || die "curl is not installed."
command -v openssl >/dev/null || die "openssl is not installed."
ok "nginx, curl and openssl present"

NGINX_VER="$(nginx -v 2>&1 | sed 's|.*/||')"
ok "nginx $NGINX_VER"

# `http2 on;` is nginx >= 1.25.1 only. On anything older it is an UNKNOWN
# directive and nginx refuses to start, so pick the form this build understands.
if [[ "$(printf '%s\n1.25.1\n' "$NGINX_VER" | sort -V | head -1)" == "1.25.1" ]]; then
    HTTP2_MODE="modern"; ok "HTTP/2: using 'http2 on;' (nginx >= 1.25.1)"
else
    HTTP2_MODE="legacy"; ok "HTTP/2: nginx < 1.25.1 — folding into 'listen 443 ssl http2;'"
fi

# Layout differs by distro family. RHEL has no sites-available/sites-enabled at
# all: nginx.conf includes conf.d/*.conf directly, so the file IS the enabled
# site and there is nothing to symlink.
if [[ -d /etc/nginx/sites-available && -d /etc/nginx/sites-enabled ]]; then
    LAYOUT="debian"
    TARGET="/etc/nginx/sites-available/$SITE_NAME"
    ENABLED="/etc/nginx/sites-enabled/$SITE_NAME"
    ok "Layout: Debian-style (sites-available + sites-enabled)"
else
    LAYOUT="rhel"
    TARGET="/etc/nginx/conf.d/$SITE_NAME"
    ENABLED="$TARGET"
    ok "Layout: RHEL-style (conf.d/*.conf — no symlink needed)"
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

if ! $CHECK_ONLY; then
    mkdir -p "$BACKUP_DIR"

    # ─── 2. Certificate ──────────────────────────────────────────────────────
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

        [[ -f "$CRT" ]] && cp "$CRT" "$BACKUP_DIR/b2b-site.crt.$(date +%Y%m%d-%H%M%S).bak"
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
    step "3. Installing $SITE_NAME ($LAYOUT layout)"

    # Backups go OUTSIDE the nginx tree. A *.bak left in conf.d/ is not matched by
    # `include conf.d/*.conf`, but keeping stale server blocks next to live ones
    # is exactly how duplicate-listen errors get introduced later.
    if [[ -f "$TARGET" ]]; then
        BACKUP="$BACKUP_DIR/$SITE_NAME.$(date +%Y%m%d-%H%M%S).bak"
        cp "$TARGET" "$BACKUP"
        ok "Backed up existing config → $BACKUP"
    fi

    # Guard against the template and the destination being the same file, which
    # happens if this script is run from inside conf.d/ — `cp a a` errors and the
    # old `ln -sf a a` failed with "are the same file".
    if [[ "$TEMPLATE" -ef "$TARGET" ]]; then
        ok "Template is already the installed config — editing in place"
    else
        cp "$TEMPLATE" "$TARGET"
    fi

    if [[ "$HTTP2_MODE" == "legacy" ]]; then
        sed -i 's/^\(\s*\)listen      443 ssl default_server;/\1listen      443 ssl http2 default_server;/' "$TARGET"
        sed -i '/^\s*http2\s*on;/d' "$TARGET"
    fi

    if [[ "$LAYOUT" == "debian" ]]; then
        ln -sfn "$TARGET" "$ENABLED"
        rm -f /etc/nginx/sites-enabled/default
        ok "Enabled via sites-enabled symlink; distro default removed"
    else
        ok "Installed to conf.d/ (loaded automatically)"
    fi

    # RHEL ships a `server { listen 80 default_server; ... }` INSIDE nginx.conf.
    # Ours also claims default_server, and two default servers on the same
    # address is a hard error: "a duplicate default server for 0.0.0.0:80".
    # Strip only the default_server token, leaving their block otherwise intact.
    if grep -qE '^\s*listen[^;#]*default_server' "$NGINX_CONF" 2>/dev/null; then
        cp "$NGINX_CONF" "$BACKUP_DIR/nginx.conf.$(date +%Y%m%d-%H%M%S).bak"
        sed -i -E 's/^(\s*listen[^;#]*) default_server(.*;)/\1\2/' "$NGINX_CONF"
        ok "Removed the stock default_server in nginx.conf (backed up) — it would"
        echo "     have collided with ours and stopped nginx from starting"
    else
        ok "No conflicting default_server in nginx.conf"
    fi

    # ─── 4. SELinux + firewall ───────────────────────────────────────────────
    step "4. SELinux and firewall"

    # THE classic RHEL symptom: nginx starts fine, then every request 502s with
    # "Permission denied ... connect() to 127.0.0.1:3000 failed" in the error log,
    # because SELinux forbids the web server opening network connections.
    if command -v getenforce >/dev/null && [[ "$(getenforce 2>/dev/null)" == "Enforcing" ]]; then
        if [[ "$(getsebool httpd_can_network_connect 2>/dev/null | awk '{print $3}')" == "on" ]]; then
            ok "SELinux enforcing; httpd_can_network_connect already on"
        else
            setsebool -P httpd_can_network_connect 1 2>/dev/null \
                && ok "SELinux enforcing → enabled httpd_can_network_connect (else every request 502s)" \
                || warn "Could not set httpd_can_network_connect — expect 502s (install policycoreutils-python-utils)"
        fi
    else
        ok "SELinux not enforcing — no boolean needed"
    fi

    if command -v firewall-cmd >/dev/null && firewall-cmd --state >/dev/null 2>&1; then
        firewall-cmd --permanent --add-service=http  >/dev/null 2>&1 || true
        firewall-cmd --permanent --add-service=https >/dev/null 2>&1 || true
        firewall-cmd --reload >/dev/null 2>&1 || true
        ok "firewalld: opened http + https"
    elif command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q '^Status: active'; then
        ufw allow 80/tcp  >/dev/null 2>&1 || true
        ufw allow 443/tcp >/dev/null 2>&1 || true
        ok "ufw: opened 80/tcp + 443/tcp"
    else
        ok "No active firewalld/ufw detected"
    fi

    # ─── 5. Validate and reload ──────────────────────────────────────────────
    step "5. Validate and reload"
    nginx -t >/dev/null 2>&1 || { echo; nginx -t; die "Config rejected — nothing reloaded, previous config still live"; }
    ok "nginx -t passes"
    systemctl enable nginx >/dev/null 2>&1 || true
    systemctl reload nginx 2>/dev/null || systemctl restart nginx
    ok "nginx reloaded"
fi

# ─── 6. HTTPS service checklist ──────────────────────────────────────────────
step "6. HTTPS service checklist"

nginx -t >/dev/null 2>&1 && ok "nginx -t passes" || bad "nginx -t FAILS (run 'nginx -t' for detail)"
[[ -e "$ENABLED" ]] && ok "$SITE_NAME is installed ($LAYOUT layout)" || bad "$SITE_NAME is not installed at $ENABLED"
if [[ "$LAYOUT" == "debian" && -e /etc/nginx/sites-enabled/default ]]; then
    bad "distro 'default' site still enabled — duplicate default_server"
fi
systemctl is-active --quiet nginx && ok "nginx service is active" || bad "nginx service is NOT running (systemctl status nginx)"

# -- upstreams --
LISTEN="$(ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null || echo '')"
grep -q ':3000' <<<"$LISTEN" && ok "frontend listening on :3000" || bad "nothing listening on :3000 (Next.js down → 502)"
grep -q ':3001' <<<"$LISTEN" && ok "API listening on :3001"      || bad "nothing listening on :3001 (API down → 502)"
grep -q ':443'  <<<"$LISTEN" && ok "nginx listening on :443"     || bad "nothing listening on :443"
grep -q ':80'   <<<"$LISTEN" && ok "nginx listening on :80"      || bad "nothing listening on :80"
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
    [[ -n "$SAN_LINE" ]] && ok "subjectAltName: $SAN_LINE" \
        || bad "certificate has NO subjectAltName — every modern browser will reject it"
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
CA=(--cacert "$CRT"); [[ -f "$CRT" ]] || CA=(-k)
code() { curl -sS "${CA[@]}" -o /dev/null -w '%{http_code}' --max-time 15 "$@" 2>/dev/null || echo 000; }

REDIR="$(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 15 "http://$PRIMARY/" 2>/dev/null || echo '000 -')"
[[ "$REDIR" == 30[18]*https://* ]] && ok "http:// redirects to https:// ($REDIR)" \
    || bad "http:// does not redirect to https:// (got: $REDIR)"

curl -sS "${CA[@]}" -o /dev/null --max-time 15 "$ORIGIN/" 2>/dev/null \
    && ok "TLS handshake validates against the installed certificate" \
    || bad "TLS handshake FAILED — cert/key mismatch, or :443 not reachable"

HEALTH="$(code "$ORIGIN/health")"
[[ "$HEALTH" == "200" ]] && ok "/health returns 200 through nginx" \
    || bad "/health returned $HEALTH (200 expected; 502 here = SELinux or upstream down)"

ROOT="$(code "$ORIGIN/")"
[[ "$ROOT" =~ ^(200|307|308)$ ]] && ok "app root returns $ROOT" || bad "app root returned $ROOT"

# 401 is the CORRECT answer — it proves the request reached Express and the auth
# middleware ran, rather than nginx handing back its own 404/502.
APIC="$(code "$ORIGIN/api/users/me")"
[[ "$APIC" == "401" ]] && ok "/api reaches the API (401 = auth middleware ran)" \
    || warn "/api/users/me returned $APIC (401 expected when logged out)"

# -- upload + streaming limits, read from the effective config --
BODY="$(nginx -T 2>/dev/null | grep -m1 client_max_body_size | grep -oE '[0-9]+' || echo 0)"
[[ "${BODY:-0}" -ge "$MIN_BODY_MB" ]] \
    && ok "client_max_body_size ${BODY}m covers the ${MIN_BODY_MB}MB upload ceiling" \
    || bad "client_max_body_size is ${BODY}m — ticket uploads need > ${MIN_BODY_MB}m or they 413"

nginx -T 2>/dev/null | grep -A6 'location = /api/chat' | grep -q 'proxy_buffering off' \
    && ok "assistant SSE has proxy_buffering off" \
    || bad "/api/chat is missing 'proxy_buffering off' — the assistant will appear frozen"

# Everything above this line is nginx/TLS/upstream health. Snapshot the count so
# the .env guidance can be gated on nginx ACTUALLY WORKING — those two failure
# modes have different fixes, and env values are noise while the proxy is down.
NGINX_FAIL=$FAIL

# -- application environment must agree with the origin --
step "7. Application environment"
check_env() { # file, key, expected
    local f="$1" k="$2" want="$3" got
    [[ -f "$f" ]] || { warn "$f not found — skipping $k"; return; }
    got="$(grep -E "^\s*$k=" "$f" | tail -1 | cut -d= -f2- | tr -d '"'"'"' \r')"
    if [[ -z "$got" ]]; then warn "$k is not set (expected $want)"
    elif [[ "$got" == *"$want"* ]]; then ok "$k = $got"
    else bad "$k = $got (expected $want)"; fi
}
SERVER_ENV="$PROJECT_DIR/server/.env"
CLIENT_ENV="$PROJECT_DIR/client/.env"

check_env "$SERVER_ENV" ALLOWED_ORIGINS      "$ORIGIN"
check_env "$SERVER_ENV" FRONTEND_URL         "$ORIGIN"
check_env "$SERVER_ENV" COOKIE_SECURE        "true"
check_env "$SERVER_ENV" NODE_ENV             "production"
check_env "$CLIENT_ENV" NEXT_PUBLIC_API_URL  "$ORIGIN"

# ─── 8. Optionally write the values ──────────────────────────────────────────
# Replaces the key in place, or appends it when absent — FRONTEND_URL in
# particular is often missing entirely, in which case it silently defaults to
# http://localhost:3000 and every password-reset email points at the wrong host.
set_env() { # file, key, value
    local f="$1" k="$2" v="$3"
    [[ -f "$f" ]] || { warn "$f not found — cannot set $k"; return; }
    if grep -qE "^\s*$k=" "$f"; then
        sed -i -E "s|^\s*$k=.*|$k=$v|" "$f"
    else
        printf '%s=%s
' "$k" "$v" >> "$f"
    fi
    echo "     $k=$v"
}

if $FIX_ENV && [[ $NGINX_FAIL -gt 0 ]]; then
    step "8. Writing .env values — SKIPPED"
    warn "nginx is not serving correctly yet; fix that first, then re-run --fix-env"
elif $FIX_ENV; then
    step "8. Writing .env values"
    for f in "$SERVER_ENV" "$CLIENT_ENV"; do
        [[ -f "$f" ]] || continue
        cp "$f" "$BACKUP_DIR/$(basename "$(dirname "$f")")-env.$(date +%Y%m%d-%H%M%S).bak"
    done
    ok "Backed up both .env files to $BACKUP_DIR"
    echo "   server/.env:"
    set_env "$SERVER_ENV" NODE_ENV            "\"production\""
    set_env "$SERVER_ENV" ALLOWED_ORIGINS     "\"$ORIGIN\""
    set_env "$SERVER_ENV" FRONTEND_URL        "\"$ORIGIN\""
    set_env "$SERVER_ENV" COOKIE_SECURE       "\"true\""
    echo "   client/.env:"
    set_env "$CLIENT_ENV" NEXT_PUBLIC_API_URL "$ORIGIN"
    ok "Written — the client still needs a REBUILD (NEXT_PUBLIC_* is inlined)"
fi

# ─── Summary ─────────────────────────────────────────────────────────────────
echo
echo "──────────────────────────────────────────────"
echo "  ✅ $PASS passed   ⚠️  $WARN warnings   ❌ $FAIL failed"
echo "──────────────────────────────────────────────"

# nginx first. While the proxy is down, .env values pointing at an https:// origin
# that does not answer are premature — so they are withheld until the TLS,
# listener and upstream checks all pass.
if [[ $NGINX_FAIL -gt 0 ]]; then
    cat <<EOF

❌ nginx is NOT serving $ORIGIN yet — $NGINX_FAIL infrastructure check(s) failed.

Fix those first; the .env values are printed once the proxy is confirmed working
(setting them now would point the app at an origin that does not answer).

  sudo nginx -t
  sudo systemctl status nginx --no-pager
  sudo tail -50 /var/log/nginx/error.log
  sudo ss -ltnp | grep -E ':80|:443'

Common causes on this platform:
  502 on every request   SELinux — sudo setsebool -P httpd_can_network_connect 1
  connection refused     firewalld — sudo firewall-cmd --permanent --add-service={http,https} && sudo firewall-cmd --reload
  won't start            duplicate default_server in /etc/nginx/nginx.conf
  unknown directive      'http2 on' on nginx < 1.25.1 — re-run this script, it rewrites it

Then re-run:  sudo $0 $PRIMARY
EOF
    exit 1
fi

# ─── nginx is confirmed working ──────────────────────────────────────────────
cat <<EOF

🎉 nginx is configured and HTTPS is live at $ORIGIN

── Now add these to your .env files ──────────────────────────────────────────

  server/.env
    NODE_ENV="production"
    ALLOWED_ORIGINS="$ORIGIN"
    FRONTEND_URL="$ORIGIN"
    COOKIE_SECURE="true"

  client/.env
    NEXT_PUBLIC_API_URL=$ORIGIN

  ALLOWED_ORIGINS is the CORS allow-list and accepts a comma-separated list, so
  keep another origin alongside it if you still reach the app that way:
    ALLOWED_ORIGINS="$ORIGIN, http://$PRIMARY:3000"

  FRONTEND_URL builds the links inside password-reset and MFA emails. Leave it
  unset and it defaults to http://localhost:3000 — the mail goes out with a link
  nobody outside this box can open.

  Apply all of the above automatically:
    sudo $0 $PRIMARY --fix-env

  Then rebuild + restart. NEXT_PUBLIC_* is inlined at BUILD time, so a restart
  alone leaves the old value compiled into the bundle:
    cd $PROJECT_DIR/client && npm run build
    sudo systemctl restart b2b

── Trust the certificate on each client ──────────────────────────────────────

Browsers warn until this certificate is trusted. TLS is already encrypting
either way — the warning is only about identity. Copy $CRT
to the client and install it:

  Windows  certutil -addstore -f Root b2b-site.crt          (Run as Administrator)
  macOS    sudo security add-trusted-cert -d -r trustRoot \
             -k /Library/Keychains/System.keychain b2b-site.crt
  Linux    sudo cp b2b-site.crt /usr/local/share/ca-certificates/ && sudo update-ca-certificates
  Firefox  keeps its own store: Settings > Privacy & Security > Certificates >
           View Certificates > Authorities > Import (Firefox ignores the OS store)

If the server's IP ever changes, re-run:  sudo $0 --renew-cert
EOF

if [[ $FAIL -gt 0 ]]; then
    echo
    echo "⚠️  nginx is fine, but $FAIL .env value(s) above still need setting."
    exit 1
fi
exit 0
