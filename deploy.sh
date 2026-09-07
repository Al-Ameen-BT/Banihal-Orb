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
run_as_owner "npm run db:provision" "$SERVER_DIR" || echo "⚠️ Warning: DB provisioning reported an error. NOT fatal here — the db:verify gate below is the authority and will abort the deploy if any schema is actually behind."

echo "🔎 Verifying required databases are available (fail-fast preflight)..."
# Hard gate: abort the deploy before touching systemd if any required database
# (b2b / b2b_chat / b2b_ticketing / b2b_ticket) is unreachable, unprovisioned, or
# BEHIND its Prisma datamodel. That last check is why this gate exists: provisioning
# above is best-effort, so drift must be caught here rather than at runtime, where a
# missing column surfaces as a 500 on every authenticated request.
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

# --- 7. Chatbot Backend Preflight Check ---
# The Analytics Agent is the ONLY chat backend. (Ollama used to be checked here too;
# nothing has called it since the agent took over managing its own model, so the
# warning only ever sent people chasing a dependency that no longer exists.)
echo "🔍 Running chatbot backend preflight checks..."
if curl -s --connect-timeout 2 http://localhost:8001 >/dev/null; then
    echo "  ✨ Analytics Agent is active."
else
    echo "  ⚠️ Warning: Analytics Agent (http://localhost:8001) is unreachable. Chat may fail."
fi

# --- 8. Systemd Configuration & Setup ---
PROTECT_HOME="yes"
if [[ "$PROJECT_DIR" =~ ^/home/ ]] || [[ "$PROJECT_DIR" =~ ^/root/ ]]; then
    # Disable ProtectHome if deployed inside a user home directory to allow access
    PROTECT_HOME="no"
fi

echo "⚙️ Configuring systemd service (single unit: API + Web)..."
echo "  Service user: $SERVICE_USER"
echo "  ProtectHome: $PROTECT_HOME"

# Migrate off the legacy split units (b2b-api / b2b-web) if they exist.
if systemctl list-unit-files 2>/dev/null | grep -qE '^b2b-(api|web)\.service'; then
    echo "  Removing legacy b2b-api / b2b-web units..."
    systemctl disable --now b2b-api.service b2b-web.service 2>/dev/null || true
fi
rm -f /etc/systemd/system/b2b-api.service /etc/systemd/system/b2b-web.service

# Generate the combined b2b.service (runs the API and the Next server under one unit)
sed -e "s|\[Service\]|\[Service\]\nEnvironment=\"PATH=$CLEAN_PATH\"|g" \
    -e "s|/opt/B2B-Site|$PROJECT_DIR|g" \
    -e "s|User=b2bapp|User=$SERVICE_USER|g" \
    -e "s|ProtectHome=yes|ProtectHome=$PROTECT_HOME|g" \
    "$PROJECT_DIR/b2b.service" > /etc/systemd/system/b2b.service

chmod 644 /etc/systemd/system/b2b.service

# --- 9. Enable and Start Service ---
echo "🔄 Reloading systemd configurations..."
systemctl daemon-reload

echo "🔌 Enabling service to start on boot..."
systemctl enable b2b.service

echo "🟢 Restarting service..."
systemctl restart b2b.service

# --- 10. Health Verification ---
sleep 3
echo "📊 Deployment Status Summary:"
if systemctl is-active --quiet b2b.service; then
    echo "  b2b (API + Web): ACTIVE ✨"
else
    echo "  b2b (API + Web): FAILED ❌ (Check logs with: journalctl -u b2b -n 50)"
fi

echo "🎉 Native systemd deployment process completed successfully!"
