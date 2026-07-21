#!/usr/bin/env bash
# 🛡️ Tech Platform Native Systemd Deployer
# This script prepares, builds, and deploys the B2B SaaS web application using native systemd services.
# MUST be run with sudo/root privileges.
#
# Usage: sudo ./deploy.sh [--dev] [--user <username>]

set -e

# --- 1. Privilege Check ---
if [ "$EUID" -ne 0 ]; then
    echo "🔒 Error: This script must be run with sudo or root privileges."
    echo "   Usage: sudo $0 [--dev] [--user <username>]"
    exit 1
fi

# --- 2. Arguments & Directory Resolution ---
IS_DEV=false
CUSTOM_USER=""

while [[ "$#" -gt 0 ]]; do
    case $1 in
        --dev) IS_DEV=true ;;
        --user) CUSTOM_USER="$2"; shift ;;
        *) echo "❌ Unknown parameter: $1"; exit 1 ;;
    esac
    shift
done

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$PROJECT_DIR/server"
CLIENT_DIR="$PROJECT_DIR/client"

echo "🚀 Deploying B2B SaaS platform from $PROJECT_DIR..."

# --- 3. Resolve Owners and Users ---
INVOKING_USER=${SUDO_USER:-$(whoami)}
PROJECT_OWNER=$(stat -c '%U' "$PROJECT_DIR" 2>/dev/null || echo "$INVOKING_USER")
SERVICE_USER="${CUSTOM_USER:-$PROJECT_OWNER}"

if [ "$SERVICE_USER" = "root" ]; then
    echo "⚠️ Warning: Running systemd services as root is not recommended for production."
fi

# --- 4. Node & npm PATH Discovery ---
echo "🔍 Resolving Node & npm paths..."
paths_to_check=""

# Extract invoking user's home directory if possible
if [ -n "$INVOKING_USER" ]; then
    user_home=$(eval echo "~$INVOKING_USER" 2>/dev/null || echo "")
    if [ -n "$user_home" ]; then
        # Add common NVM / FNM / Node path locations
        if [ -d "$user_home/.nvm/versions/node" ]; then
            for v_dir in "$user_home"/.nvm/versions/node/*; do
                if [ -d "$v_dir/bin" ]; then
                    paths_to_check="$v_dir/bin:$paths_to_check"
                fi
            done
        fi
        [ -d "$user_home/.local/share/fnm/aliases-bin" ] && paths_to_check="$user_home/.local/share/fnm/aliases-bin:$paths_to_check"
        [ -d "$user_home/.fnm" ] && paths_to_check="$user_home/.fnm:$paths_to_check"
        [ -d "$user_home/.volta/bin" ] && paths_to_check="$user_home/.volta/bin:$paths_to_check"
        [ -d "$user_home/.npm-global/bin" ] && paths_to_check="$user_home/.npm-global/bin:$paths_to_check"
        [ -d "$user_home/.local/bin" ] && paths_to_check="$user_home/.local/bin:$paths_to_check"
    fi
fi

# Add current PATH and standard binaries
CLEAN_PATH="$PATH:$paths_to_check/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
# Deduplicate paths
CLEAN_PATH=$(echo "$CLEAN_PATH" | tr ':' '\n' | awk '!x[$0]++' | tr '\n' ':' | sed 's/:$//')

# Verify node & npm availability
if ! env PATH="$CLEAN_PATH" command -v node >/dev/null 2>&1; then
    echo "❌ Error: 'node' executable could not be resolved in the PATH."
    exit 1
fi
if ! env PATH="$CLEAN_PATH" command -v npm >/dev/null 2>&1; then
    echo "❌ Error: 'npm' executable could not be resolved in the PATH."
    exit 1
fi

NODE_VERSION=$(env PATH="$CLEAN_PATH" node -v)
echo "  Using Node $NODE_VERSION resolved from PATH."

# --- 5. Helper for Running Build Tasks as Project Owner ---
run_as_owner() {
    local cmd="$1"
    local dir="$2"
    # Execute commands under the project owner to preserve correct file permissions
    sudo -u "$PROJECT_OWNER" env PATH="$CLEAN_PATH" bash -c "cd '$dir' && $cmd"
}

# --- 6. Application Preparation & Compilation ---
echo "📦 Preparing backend application..."
run_as_owner "npm ci || npm install" "$SERVER_DIR"
run_as_owner "npm run db:generate" "$SERVER_DIR"

echo "🗄️ Provisioning databases (idempotent SQL DDL)..."
run_as_owner "npm run db:provision" "$SERVER_DIR" || echo "⚠️ Warning: DB provisioning failed. Check DB connection settings & superuser access."

echo "🔎 Verifying required databases are available (fail-fast preflight)..."
# Hard gate: abort the deploy before touching systemd if any required database
# (b2b / b2b_chat / b2b_ticketing / b2b_ticket) is unreachable or unprovisioned.
run_as_owner "npm run db:verify" "$SERVER_DIR"

if [ "$IS_DEV" = false ]; then
    echo "🏗️ Building server production bundle..."
    run_as_owner "npm run build" "$SERVER_DIR"
fi

echo "📦 Preparing frontend application..."
run_as_owner "npm ci || npm install" "$CLIENT_DIR"

if [ "$IS_DEV" = false ]; then
    echo "🏗️ Building client production bundle..."
    run_as_owner "npm run build" "$CLIENT_DIR"
fi

# --- 7. Ollama / Chatbot Preflight Checks ---
echo "🔍 Running chatbot backend preflight checks..."
if curl -s --connect-timeout 2 http://localhost:11435/api/tags >/dev/null; then
    echo "  ✨ Ollama is active."
else
    echo "  ⚠️ Warning: Ollama chatbot backend (http://localhost:11435) is unreachable. Chat may fail."
fi
if curl -s --connect-timeout 2 http://localhost:8050 >/dev/null; then
    echo "  ✨ Analytics Agent is active."
else
    echo "  ⚠️ Warning: Analytics Agent (http://localhost:8050) is unreachable. Chat may fail."
fi

# --- 8. Systemd Configuration & Setup ---
PROTECT_HOME="yes"
if [[ "$PROJECT_DIR" =~ ^/home/ ]] || [[ "$PROJECT_DIR" =~ ^/root/ ]]; then
    # Disable ProtectHome if deployed inside a user home directory to allow access
    PROTECT_HOME="no"
fi

echo "⚙️ Configuring systemd service files..."
echo "  Service user: $SERVICE_USER"
echo "  ProtectHome: $PROTECT_HOME"

# Clean legacy service file copies
rm -f /etc/systemd/system/b2b-api.service /etc/systemd/system/b2b-web.service

# Generate b2b-api.service
sed -e "s|\[Service\]|\[Service\]\nEnvironment=\"PATH=$CLEAN_PATH\"|g" \
    -e "s|/opt/B2B-Site|$PROJECT_DIR|g" \
    -e "s|User=b2bapp|User=$SERVICE_USER|g" \
    -e "s|ProtectHome=yes|ProtectHome=$PROTECT_HOME|g" \
    "$PROJECT_DIR/b2b-api.service" > /etc/systemd/system/b2b-api.service

# Generate b2b-web.service
sed -e "s|\[Service\]|\[Service\]\nEnvironment=\"PATH=$CLEAN_PATH\"|g" \
    -e "s|/opt/B2B-Site|$PROJECT_DIR|g" \
    -e "s|User=b2bapp|User=$SERVICE_USER|g" \
    -e "s|ProtectHome=yes|ProtectHome=$PROTECT_HOME|g" \
    "$PROJECT_DIR/b2b-web.service" > /etc/systemd/system/b2b-web.service

chmod 644 /etc/systemd/system/b2b-api.service
chmod 644 /etc/systemd/system/b2b-web.service

# --- 9. Enable and Start Services ---
echo "🔄 Reloading systemd configurations..."
systemctl daemon-reload

echo "🔌 Enabling services to start on boot..."
systemctl enable b2b-api.service b2b-web.service

echo "🟢 Restarting services..."
systemctl restart b2b-api.service b2b-web.service

# --- 10. Health Verification ---
sleep 2
echo "📊 Deployment Status Summary:"
if systemctl is-active --quiet b2b-api.service; then
    echo "  b2b-api: ACTIVE ✨"
else
    echo "  b2b-api: FAILED ❌ (Check logs with: journalctl -u b2b-api -n 50)"
fi

if systemctl is-active --quiet b2b-web.service; then
    echo "  b2b-web: ACTIVE ✨"
else
    echo "  b2b-web: FAILED ❌ (Check logs with: journalctl -u b2b-web -n 50)"
fi

echo "🎉 Native systemd deployment process completed successfully!"
