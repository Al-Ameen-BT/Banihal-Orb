#!/usr/bin/env bash
# 🔐 B2B-Site — nginx + HTTPS installer and service checklist
#
# Drops b2b-site.conf into place, obtains a Let's Encrypt certificate, and then
# runs the full HTTPS checklist against the live host.
#
# Usage:
#   sudo ./https-nginx.sh <domain> --email admin@yourcompany.com
#   sudo ./https-nginx.sh <domain> --email a@b.com --staging   # rehearsal, fake cert
#   sudo ./https-nginx.sh <domain> --check-only                # read-only, changes nothing
#
# Certificates are obtained with `certbot certonly --webroot`, NOT `--nginx`, so
# certbot never rewrites b2b-site.conf — this file stays the single source of truth.

set -euo pipefail

DOMAIN=""
EMAIL=""
STAGING=false
CHECK_ONLY=false

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
TEMPLATE="$SCRIPT_DIR/b2b-site.conf"
SITE_NAME="b2b-site.conf"
AVAILABLE="/etc/nginx/sites-available/$SITE_NAME"
ENABLED="/etc/nginx/sites-enabled/$SITE_NAME"
WEBROOT="/var/www/html"

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
        --email)      EMAIL="${2:-}"; shift ;;
        --staging)    STAGING=true ;;
        --check-only) CHECK_ONLY=true ;;
        -h|--help)    sed -n '2,14p' "$0"; exit 0 ;;
        -*)           die "Unknown option: $1" ;;
        *)            DOMAIN="$1" ;;
    esac
    shift
done

[[ -n "$DOMAIN" ]] || die "Domain required.  Usage: sudo $0 <domain> --email you@example.com"
[[ "$EUID" -eq 0 ]] || die "Must run as root (sudo $0 $DOMAIN ...)"
[[ -f "$TEMPLATE" ]] || die "Config template not found: $TEMPLATE"

echo "🔐 B2B-Site HTTPS setup for $DOMAIN"
$CHECK_ONLY && echo "   (--check-only: no changes will be made)"

# ─── 1. Preflight ────────────────────────────────────────────────────────────
step "1. Preflight"

command -v nginx   >/dev/null || die "nginx is not installed.  apt install nginx"
command -v curl    >/dev/null || die "curl is not installed.  apt install curl"
command -v openssl >/dev/null || die "openssl is not installed.  apt install openssl"
ok "nginx, curl and openssl present"

NGINX_VER="$(nginx -v 2>&1 | sed 's|.*/||')"
ok "nginx $NGINX_VER"

# `http2 on;` is nginx >= 1.25.1 only. On anything older it is an UNKNOWN
# directive and nginx refuses to start, so pick the form this build understands
# instead of leaving a landmine in the config.
if [[ "$(printf '%s\n1.25.1\n' "$NGINX_VER" | sort -V | head -1)" == "1.25.1" ]]; then
    HTTP2_MODE="modern"
    ok "HTTP/2: using 'http2 on;' (nginx >= 1.25.1)"
else
    HTTP2_MODE="legacy"
    warn "HTTP/2: nginx < 1.25.1 — rewriting to 'listen 443 ssl http2;'"
fi

# A record pointing somewhere else is the most common cause of a failed ACME
# challenge, so surface it before spending a rate-limited certbot attempt.
if command -v dig >/dev/null; then
    RESOLVED="$(dig +short "$DOMAIN" A | tail -1)"
    PUBLIC_IP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || echo '')"
    if [[ -z "$RESOLVED" ]]; then
        warn "$DOMAIN has no A record — the ACME challenge will fail"
    elif [[ -n "$PUBLIC_IP" && "$RESOLVED" != "$PUBLIC_IP" ]]; then
        warn "$DOMAIN resolves to $RESOLVED but this host is $PUBLIC_IP"
    else
        ok "DNS: $DOMAIN → $RESOLVED"
    fi
fi

# ─── 2. Install the config ───────────────────────────────────────────────────
if ! $CHECK_ONLY; then
    step "2. Installing $SITE_NAME"

    if [[ -f "$AVAILABLE" ]]; then
        BACKUP="$AVAILABLE.$(date +%Y%m%d-%H%M%S).bak"
        cp "$AVAILABLE" "$BACKUP"
        ok "Backed up existing config → $BACKUP"
    fi

    render_config() {
        # $1 = destination.  Substitutes the domain and, on older nginx, folds
        # `http2 on;` back into the listen directive.
        sed "s/app\.example\.com/$DOMAIN/g" "$TEMPLATE" > "$1"
        if [[ "$HTTP2_MODE" == "legacy" ]]; then
            sed -i 's/^\(\s*\)listen      443 ssl;/\1listen      443 ssl http2;/' "$1"
            sed -i '/^\s*http2\s*on;/d' "$1"
        fi
    }

    CERT_DIR="/etc/letsencrypt/live/$DOMAIN"
    mkdir -p "$WEBROOT"

    if [[ ! -f "$CERT_DIR/fullchain.pem" ]]; then
        # Bootstrap problem: the :443 block references certificates that do not
        # exist yet, so `nginx -t` fails and nginx cannot serve the ACME
        # challenge that would create them. Stand up an HTTP-only server first.
        step "2a. No certificate yet — installing a temporary HTTP-only server"
        cat > "$AVAILABLE" <<EOF
server {
    listen      80;
    listen      [::]:80;
    server_name $DOMAIN;
    location ^~ /.well-known/acme-challenge/ { root $WEBROOT; }
    location / { return 503 "B2B-Site: awaiting certificate\n"; }
}
EOF
        ln -sf "$AVAILABLE" "$ENABLED"
        rm -f /etc/nginx/sites-enabled/default
        nginx -t >/dev/null 2>&1 || { nginx -t; die "Bootstrap config rejected"; }
        systemctl reload nginx
        ok "Temporary :80 server live for the ACME challenge"

        step "2b. Requesting the certificate"
        command -v certbot >/dev/null || die "certbot is not installed.  apt install certbot"
        [[ -n "$EMAIL" ]] || die "--email is required to request a certificate"

        CERTBOT_ARGS=(certonly --webroot -w "$WEBROOT" -d "$DOMAIN"
                      --email "$EMAIL" --agree-tos --no-eff-email --non-interactive)
        $STAGING && CERTBOT_ARGS+=(--staging)
        certbot "${CERTBOT_ARGS[@]}" || die "certbot failed — check DNS and that :80 is reachable from the internet"
        ok "Certificate issued for $DOMAIN"
    else
        ok "Certificate already present — leaving it alone"
    fi

    step "2c. Installing the full HTTPS config"
    render_config "$AVAILABLE"
    ln -sf "$AVAILABLE" "$ENABLED"
    rm -f /etc/nginx/sites-enabled/default
    nginx -t >/dev/null 2>&1 || { nginx -t; die "Config rejected — nothing reloaded, previous config still live"; }
    systemctl reload nginx
    ok "Config installed and nginx reloaded"
fi

# ─── 3. HTTPS service checklist ──────────────────────────────────────────────
step "3. HTTPS service checklist"

# -- config --
nginx -t >/dev/null 2>&1 && ok "nginx -t passes" || bad "nginx -t FAILS (run 'nginx -t' for detail)"
[[ -L "$ENABLED" || -f "$ENABLED" ]] && ok "$SITE_NAME is enabled" || bad "$SITE_NAME is not in sites-enabled"
[[ -e /etc/nginx/sites-enabled/default ]] && warn "the distro 'default' site is still enabled" || ok "distro default site removed"

# -- upstreams --
LISTEN="$(ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null || echo '')"
grep -q ':3000' <<<"$LISTEN" && ok "frontend listening on :3000" || bad "nothing listening on :3000 (Next.js down → 502)"
grep -q ':3001' <<<"$LISTEN" && ok "API listening on :3001"      || bad "nothing listening on :3001 (API down → 502)"
if systemctl is-active --quiet b2b.service 2>/dev/null; then
    ok "b2b.service is active"
else
    warn "b2b.service is not active (are you running the apps another way?)"
fi

# -- certificate --
CERT="/etc/letsencrypt/live/$DOMAIN/fullchain.pem"
if [[ -f "$CERT" ]]; then
    EXPIRY="$(openssl x509 -enddate -noout -in "$CERT" | cut -d= -f2)"
    DAYS=$(( ( $(date -d "$EXPIRY" +%s) - $(date +%s) ) / 86400 ))
    if   [[ $DAYS -lt 0  ]]; then bad  "certificate EXPIRED $((-DAYS)) days ago"
    elif [[ $DAYS -lt 14 ]]; then warn "certificate expires in $DAYS days — renewal should have run"
    else                          ok   "certificate valid for $DAYS more days"
    fi
    openssl x509 -noout -checkhost "$DOMAIN" -in "$CERT" >/dev/null 2>&1 \
        && ok "certificate matches $DOMAIN" || bad "certificate does NOT cover $DOMAIN"
else
    bad "no certificate at $CERT"
fi
if systemctl is-enabled --quiet certbot.timer 2>/dev/null || systemctl is-enabled --quiet snap.certbot.renew.timer 2>/dev/null; then
    ok "automatic renewal timer is enabled"
else
    warn "no certbot renewal timer enabled — the cert will expire in 90 days"
fi

# -- live HTTPS behaviour --
code()   { curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "$@" 2>/dev/null || echo 000; }
header() { curl -sSI --max-time 15 "$@" 2>/dev/null || true; }

REDIR="$(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 15 "http://$DOMAIN/" 2>/dev/null || echo '000 -')"
if [[ "$REDIR" == 30[18]*https://* ]]; then ok "http:// redirects to https:// ($REDIR)"
else bad "http:// does not redirect to https:// (got: $REDIR)"; fi

if curl -sS -o /dev/null --max-time 15 "https://$DOMAIN/" 2>/dev/null; then
    ok "TLS handshake succeeds"
else
    bad "TLS handshake FAILED — cert/key mismatch, or :443 not reachable"
fi

HSTS="$(header "https://$DOMAIN/" | grep -i '^strict-transport-security' || true)"
[[ -n "$HSTS" ]] && ok "HSTS present:${HSTS#*:}" || bad "no Strict-Transport-Security header"

HEALTH="$(code "https://$DOMAIN/health")"
[[ "$HEALTH" == "200" ]] && ok "/health returns 200 through nginx" || bad "/health returned $HEALTH (200 expected)"

ROOT="$(code "https://$DOMAIN/")"
[[ "$ROOT" =~ ^(200|307|308)$ ]] && ok "app root returns $ROOT" || bad "app root returned $ROOT"

# The API must answer through the proxy. 401 is the CORRECT answer here — it
# proves the request reached Express and the auth middleware ran, rather than
# nginx handing back its own 404/502.
APIC="$(code "https://$DOMAIN/api/users/me")"
[[ "$APIC" == "401" ]] && ok "/api reaches the API (401 = auth middleware ran)" \
    || warn "/api/users/me returned $APIC (401 expected when logged out)"

# TLS 1.0/1.1 must be refused. Skipped when the local curl cannot speak them.
if curl -sS --tlsv1.1 --tls-max 1.1 -o /dev/null --max-time 10 "https://$DOMAIN/" 2>/dev/null; then
    bad "TLS 1.1 is ACCEPTED — restrict ssl_protocols to TLSv1.2 TLSv1.3"
else
    ok "TLS 1.0/1.1 refused (or unsupported locally)"
fi

# -- upload + streaming limits, read from the effective config --
BODY="$(nginx -T 2>/dev/null | awk '/server_name '"$DOMAIN"'/,0' | grep -m1 client_max_body_size | grep -oE '[0-9]+' || echo 0)"
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

# -- application environment must agree with the public origin --
step "4. Application environment"
ORIGIN="https://$DOMAIN"
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
echo "🎉 HTTPS is live at $ORIGIN"
$STAGING && echo "⚠️  --staging was used: this certificate is NOT trusted by browsers. Re-run without --staging."
exit 0
