#!/usr/bin/env bash
# install.sh — install the squid-agent on a target squid host.
#   sudo ./install.sh <platform-origin> <proxy-id> <registration-key> [bundle-public-key.pem]
# The registration key is shown ONCE in the platform UI (Squid page → Install &
# keys, or staff console at service-assign time). Keep it out of shell history:
#   read -sp 'key: ' K; sudo ./install.sh ... "$K"
set -euo pipefail

PLATFORM="${1:?usage: install.sh <platform-origin> <proxy-id> <registration-key> [pubkey.pem]}"
PROXY_ID="${2:?proxy id required}"
KEY="${3:?registration key required}"
PUB="${4:-}"

AGENT_DIR=/usr/local/lib/squid-agent
mkdir -p "$AGENT_DIR" /etc/squid-agent /etc/squid/acls
cp squid-agent.sh "$AGENT_DIR/"
chmod 0700 "$AGENT_DIR/squid-agent.sh"

umask 077
printf '%s\n' "$KEY" > /etc/squid-agent/key
printf 'SQUID_PLATFORM=%s\nSQUID_PROXY_ID=%s\n' "$PLATFORM" "$PROXY_ID" > /etc/squid-agent/env
[[ -n "$PUB" ]] && cp "$PUB" /etc/squid-agent/bundle.pub && echo "SQUID_PUBKEY=/etc/squid-agent/bundle.pub" >> /etc/squid-agent/env

[[ -x /usr/sbin/squid ]] || echo "WARNING: squid not found at /usr/sbin/squid — install squid before enabling."

cp squid-agent.service /etc/systemd/system/squid-agent.service
systemctl daemon-reload
systemctl enable --now squid-agent.service

cat <<EOF
Installed:
  $AGENT_DIR/squid-agent.sh   (the loop)
  /etc/squid-agent/key        (registration key, mode 0600)
  /etc/squid-agent/env        (platform + proxy id)
  /etc/squid-agent/bundle.pub (bundle signing public key, if pinned)
  squid-agent.service         (systemd, running)

Test: journalctl -u squid-agent.service -f
The agent polls ${PLATFORM}/api/proxy-agent/poll every ${SQUID_INTERVAL:-5}s and
applies bundles only after verifying their signature.
EOF