#!/usr/bin/env python3
"""
🛡️ Tech Platform — Linux systemd Service Deployment Utility
This utility automates the creation, installation, and management of systemd services 
for running both the frontend (Next.js client) and backend (Express API server) on Linux hosts.
"""

import os
import sys
import shutil
import subprocess
import argparse
import getpass

# ─── Service configuration defaults ──────────────────────────────────────────
DEFAULT_USER = getpass.getuser()
SYSTEMD_PATH = "/etc/systemd/system"

SERVER_SERVICE_TEMPLATE = """[Unit]
Description=Tech B2B SaaS Backend API Server
After=network.target postgresql.service
Documentation=https://github.com/Al-Ameen-BT/B2B-Site

[Service]
Type=simple
User={user}
WorkingDirectory={work_dir}
ExecStart={npm_cmd} run {run_mode}
Restart=always
RestartSec=5
Environment=NODE_ENV={env_mode} PORT={port}
StandardOutput=syslog
StandardError=syslog
SyslogIdentifier=tech-server

[Install]
WantedBy=multi-user.target
"""

CLIENT_SERVICE_TEMPLATE = """[Unit]
Description=Tech B2B SaaS Frontend Client Web App
After=network.target tech-server.service
Documentation=https://github.com/Al-Ameen-BT/B2B-Site

[Service]
Type=simple
User={user}
WorkingDirectory={work_dir}
ExecStart={npm_cmd} run {run_mode}
Restart=always
RestartSec=5
Environment=NODE_ENV={env_mode} PORT={port}
StandardOutput=syslog
StandardError=syslog
SyslogIdentifier=tech-client

[Install]
WantedBy=multi-user.target
"""

def check_privileges():
    """Verify script is run with sudo/root privileges for file writing."""
    return os.geteuid() == 0

def locate_npm():
    """Locate the path of the npm executable on the system."""
    npm_path = shutil.which("npm")
    if not npm_path:
        print("❌ Error: 'npm' command could not be located in your system PATH.")
        print("   Please ensure Node.js is installed and npm is available before deploying.")
        sys.exit(1)
    return npm_path

def generate_services(project_dir, user, npm_cmd, is_dev):
    """Generate configuration strings for both server and client systemd services."""
    server_dir = os.path.join(project_dir, "server")
    client_dir = os.path.join(project_dir, "client")

    env_mode = "development" if is_dev else "production"
    run_mode = "dev" if is_dev else "start"

    server_service = SERVER_SERVICE_TEMPLATE.format(
        user=user,
        work_dir=server_dir,
        npm_cmd=npm_cmd,
        run_mode=run_mode,
        env_mode=env_mode,
        port=3001
    )

    client_service = CLIENT_SERVICE_TEMPLATE.format(
        user=user,
        work_dir=client_dir,
        npm_cmd=npm_cmd,
        run_mode=run_mode,
        env_mode=env_mode,
        port=3000
    )

    return server_service, client_service

def install_service(name, content):
    """Write the systemd service file configuration to /etc/systemd/system/."""
    file_path = os.path.join(SYSTEMD_PATH, name)
    try:
        with open(file_path, "w") as f:
            f.write(content)
        os.chmod(file_path, 0o644)
        print(f"✅ Created service file: {file_path}")
    except IOError as e:
        print(f"❌ Failed to write service file {file_path}: {e}")
        sys.exit(1)

def run_sysctl(args):
    """Execute systemctl operations."""
    cmd = ["systemctl"] + args
    try:
        subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except subprocess.CalledProcessError as e:
        print(f"❌ systemctl failed on args {args}: {e.stderr.decode().strip()}")
        sys.exit(1)

def main():
    parser = argparse.ArgumentParser(
        description="Deploy Tech SaaS Client & Server as systemd services on Linux."
    )
    parser.add_argument(
        "--dev", action="store_true",
        help="Configure services to run in development mode (npm run dev) instead of production."
    )
    parser.add_argument(
        "--user", default=DEFAULT_USER,
        help=f"User account that should execute the services (defaults to: {DEFAULT_USER})."
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Generate and display the service configurations to stdout without writing them to disk."
    )
    
    args = parser.parse_args()
    
    # ─── Locate active directory structure ────────────────────────────────────
    script_dir = os.path.dirname(os.path.abspath(__file__))
    server_path = os.path.join(script_dir, "server")
    client_path = os.path.join(script_dir, "client")
    
    if not os.path.exists(server_path) or not os.path.exists(client_path):
        print(f"❌ Error: Could not locate 'server/' or 'client/' directories at: {script_dir}")
        print("   Please execute this script from the root workspace directory.")
        sys.exit(1)

    npm_cmd = locate_npm()
    server_conf, client_conf = generate_services(script_dir, args.user, npm_cmd, args.dev)

    if args.dry_run:
        print("🔍 --- DRY RUN MODE (Printing generated configurations) ---")
        print("\n=== tech-server.service ===")
        print(server_conf)
        print("\n=== tech-client.service ===")
        print(client_conf)
        print("===========================")
        sys.exit(0)

    # ─── Check root permissions ───────────────────────────────────────────────
    if not check_privileges():
        print("🔒 Privilege Check Failed!")
        print("   Writing configurations to /etc/systemd/system/ requires elevated privileges.")
        print(f"   Please run this script with sudo:\n   sudo python3 {os.path.basename(__file__)} " + " ".join(sys.argv[1:]))
        sys.exit(1)

    print("🚀 Installing systemd services...")
    install_service("tech-server.service", server_conf)
    install_service("tech-client.service", client_conf)

    print("🔄 Reloading systemd daemon...")
    run_sysctl(["daemon-reload"])

    print("🔌 Enabling services to start on boot...")
    run_sysctl(["enable", "tech-server.service"])
    run_sysctl(["enable", "tech-client.service"])

    print("🟢 Starting services...")
    run_sysctl(["start", "tech-server.service"])
    run_sysctl(["start", "tech-client.service"])

    print("\n🎉 Deployment Successful!")
    print("----------------------------------------------------------------------")
    print("Both client and server services are fully active and enabled on boot!")
    print("\nUseful monitoring commands:")
    print("  * Monitor backend logs:   journalctl -u tech-server.service -f -n 50")
    print("  * Monitor frontend logs:  journalctl -u tech-client.service -f -n 50")
    print("  * Check service status:   systemctl status tech-server.service tech-client.service")
    print("----------------------------------------------------------------------")

if __name__ == "__main__":
    main()
