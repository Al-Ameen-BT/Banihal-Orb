#!/usr/bin/env python3
"""
🛡️ Tech Platform Unified Deployer & Supervisor Wizard
This single, self-contained Python program operates in two modes:
1. Installer Mode (Default/--install): Generates, writes, enables, and starts a systemd 
   service ('b2bweb.service') on Linux that executes *this same file* in Supervisor mode.
2. Supervisor Mode (--run): Concurrently launches, streams logs for, and supervises the 
   Express backend API (port 3001) and Next.js frontend client (port 3000).
"""

import os
import sys
import shutil
import subprocess
import argparse
import getpass
import signal
import threading
import time

SYSTEMD_PATH = "/etc/systemd/system"
SERVICE_NAME = "b2bweb.service"

# ==============================================================================
# ─── PART 1: SUPERVISOR & PROCESS ORCHESTRATOR MODE (--run) ──────────────────
# ==============================================================================

processes = []
shutting_down = False

def log(prefix, text):
    """Outputs a formatted, timestamped log line with a clean prefix."""
    timestamp = time.strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{timestamp}] {prefix} {text}", flush=True)

def stream_output(pipe, prefix):
    """Streams stdout/stderr of a child process directly to parent output."""
    try:
        with pipe:
            for line in iter(pipe.readline, ""):
                clean_line = line.strip()
                if clean_line:
                    log(prefix, clean_line)
    except Exception as e:
        log("[Monitor]", f"Stream monitoring exception for {prefix}: {e}")

def kill_child_processes():
    """Forces child processes to shut down gracefully, then kills them if needed."""
    global shutting_down
    if shutting_down:
        return
    shutting_down = True
    
    log("[Orchestrator]", "Shutting down supervised B2B applications...")
    for p in processes:
        if p.poll() is None:
            log("[Orchestrator]", f"Sending termination signal (SIGTERM) to subprocess {p.pid}...")
            try:
                if os.name != 'nt':
                    os.killpg(os.getpgid(p.pid), signal.SIGTERM)
                else:
                    p.terminate()
            except Exception as e:
                log("[Orchestrator]", f"Error terminating process {p.pid}: {e}")

    # Wait briefly for graceful shutdown, then force kill survivors
    time.sleep(2)
    for p in processes:
        if p.poll() is None:
            log("[Orchestrator]", f"Force killing unresponsive process {p.pid}...")
            try:
                if os.name != 'nt':
                    os.killpg(os.getpgid(p.pid), signal.SIGKILL)
                else:
                    p.kill()
            except Exception:
                pass

def signal_handler(signum, frame):
    """Signal handler callback to intercept systemd kill signals (SIGTERM/SIGINT)."""
    log("[Orchestrator]", f"Received system signal: {signal.Signals(signum).name}")
    kill_child_processes()
    sys.exit(0)

def launch_subprocess(cwd, run_mode, port, prefix, env_mode):
    """Spins up a Node subprocess in the designated directory."""
    npm_bin = "npm.cmd" if os.name == "nt" else "npm"
    cmd = [npm_bin, "run", run_mode]
    
    env = os.environ.copy()
    env["PORT"] = str(port)
    env["NODE_ENV"] = env_mode

    log("[Orchestrator]", f"Launching {prefix} ({' '.join(cmd)}) on port {port}...")
    
    kwargs = {}
    if os.name != 'nt':
        kwargs['preexec_fn'] = os.setsid

    try:
        p = subprocess.Popen(
            cmd,
            cwd=cwd,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            **kwargs
        )
        processes.append(p)
        
        # Start background threads to stream outputs
        threading.Thread(target=stream_output, args=(p.stdout, prefix), daemon=True).start()
        threading.Thread(target=stream_output, args=(p.stderr, f"{prefix}-Err"), daemon=True).start()
        return p
    except Exception as e:
        log("[Orchestrator]", f"Failed to start {prefix}: {e}")
        kill_child_processes()
        sys.exit(1)

def run_supervisor(project_dir, is_dev):
    """Spins up, supervises, and maintains both the server and client processes."""
    # Setup signal listeners for Linux systemd management
    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)

    server_dir = os.path.join(project_dir, "server")
    client_dir = os.path.join(project_dir, "client")

    run_mode = "dev" if is_dev else "start"
    env_mode = "development" if is_dev else "production"

    log("[Orchestrator]", f"Platform booting in {env_mode.upper()} mode...")
    
    # 1. Start Server on port 3001
    server_process = launch_subprocess(server_dir, run_mode, 3001, "[Server]", env_mode)
    
    # Wait briefly for database validation and server setup
    time.sleep(1.5)
    
    # 2. Start Client on port 3000
    client_process = launch_subprocess(client_dir, run_mode, 3000, "[Client]", env_mode)

    # 3. Supervise processes
    while not shutting_down:
        server_exit = server_process.poll()
        client_exit = client_process.poll()

        if server_exit is not None:
            log("[Orchestrator]", f"Backend Server terminated unexpectedly with exit code: {server_exit}")
            break
        if client_exit is not None:
            log("[Orchestrator]", f"Frontend Client terminated unexpectedly with exit code: {client_exit}")
            break
            
        time.sleep(1)

    # Clean up and exit
    kill_child_processes()
    sys.exit(1)


# ==============================================================================
# ─── PART 2: DYNAMIC INSTALLER & WIZARD MODE (--install) ─────────────────────
# ==============================================================================

def check_privileges():
    """Verify script is run with sudo/root privileges for file writing."""
    return os.geteuid() == 0

def locate_python():
    """Locate the path of the python3 executable on the system."""
    py_path = shutil.which("python3")
    if not py_path:
        print("❌ Error: 'python3' command could not be located in your system PATH.")
        sys.exit(1)
    return py_path

def run_sysctl(args):
    """Execute systemctl operations."""
    cmd = ["systemctl"] + args
    try:
        subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except subprocess.CalledProcessError as e:
        print(f"❌ systemctl failed on args {args}: {e.stderr.decode().strip()}")
        sys.exit(1)

def run_installer(project_dir, user, py_cmd, script_path, is_dev, dry_run):
    """Generates, installs, and registers the unified b2bweb.service unit on Linux."""
    
    env_mode = "development" if is_dev else "production"
    dev_flag = " --dev" if is_dev else ""

    # Dynamically generate service content pointing back to THIS script with --run
    service_content = f"""[Unit]
Description=Tech B2B SaaS Unified Platform Service (Client & Server)
After=network.target postgresql.service
Documentation=https://github.com/Al-Ameen-BT/B2B-Site

[Service]
Type=simple
User={user}
WorkingDirectory={project_dir}
ExecStart={py_cmd} {script_path} --run{dev_flag}
Restart=always
RestartSec=5
Environment=NODE_ENV={env_mode}
StandardOutput=syslog
StandardError=syslog
SyslogIdentifier=b2bweb

[Install]
WantedBy=multi-user.target
"""

    if dry_run:
        print("🔍 --- DRY RUN MODE (Printing dynamically resolved configuration) ---")
        print(f"\n=== {SERVICE_NAME} ===")
        print(service_content)
        print("==========================")
        sys.exit(0)

    # Check root privileges
    if not check_privileges():
        print("🔒 Privilege Check Failed!")
        print("   Registering systemd services requires root privileges.")
        print(f"   Please run this script with sudo:\n   sudo python3 {os.path.basename(script_path)} " + " ".join(sys.argv[1:]))
        sys.exit(1)

    print(f"🚀 Deploying Tech SaaS platform as {SERVICE_NAME}...")

    # Write service file to /etc/systemd/system/
    dest_path = os.path.join(SYSTEMD_PATH, SERVICE_NAME)
    try:
        with open(dest_path, "w") as f:
            f.write(service_content)
        os.chmod(dest_path, 0o644)
        print(f"✅ Installed service unit file: {dest_path}")
    except IOError as e:
        print(f"❌ Failed to write systemd service file: {e}")
        sys.exit(1)

    print("🔄 Reloading systemd daemon...")
    run_sysctl(["daemon-reload"])

    print("🔌 Enabling service to start on boot...")
    run_sysctl(["enable", SERVICE_NAME])

    print("🟢 Starting service...")
    run_sysctl(["start", SERVICE_NAME])

    print("\n🎉 Deployment Successful!")
    print("----------------------------------------------------------------------")
    print(f"The unified platform is now active and running under systemd!")
    print("\nUseful monitoring commands:")
    print("  * Monitor logs:           journalctl -u b2bweb.service -f -n 100")
    print("  * Check service status:   systemctl status b2bweb.service")
    print("  * Restart service:        systemctl restart b2bweb.service")
    print("----------------------------------------------------------------------")


# ==============================================================================
# ─── PART 3: MAIN ROUTER / ARGUMENT PARSING ──────────────────────────────────
# ==============================================================================

def main():
    parser = argparse.ArgumentParser(
        description="Unified Deployer & Supervisor for the Tech B2B SaaS platform."
    )
    
    # Execution mode toggles
    group = parser.add_mutually_exclusive_group()
    group.add_argument(
        "--run", action="store_true",
        help="Supervisor Mode: Launch and monitor both client and server subprocesses (used by systemd)."
    )
    group.add_argument(
        "--install", action="store_true",
        help="Installer Mode (Default): Generate and install b2bweb.service in systemd."
    )

    # Configuration flags
    parser.add_argument(
        "--dev", action="store_true",
        help="Configure services/subprocesses to run in development mode (npm run dev) instead of production."
    )
    parser.add_argument(
        "--user", default="root",
        help="Installer Mode: User account that systemd should use to run the applications (defaults to: root)."
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Installer Mode: Print the dynamically generated service configurations without executing system writes."
    )
    
    args = parser.parse_args()

    # ─── Locate Workspace Details ─────────────────────────────────────────────
    script_path = os.path.abspath(__file__)
    project_dir = os.path.dirname(script_path)
    
    # Basic directory check
    server_path = os.path.join(project_dir, "server")
    client_path = os.path.join(project_dir, "client")
    if not os.path.exists(server_path) or not os.path.exists(client_path):
        print(f"❌ Error: Could not locate 'server/' or 'client/' directories relative to: {project_dir}")
        sys.exit(1)

    # ─── Route to Supervisor vs Installer ────────────────────────────────────
    if args.run:
        run_supervisor(project_dir, args.dev)
    else:
        py_cmd = locate_python()
        run_installer(project_dir, args.user, py_cmd, script_path, args.dev, args.dry_run)

if __name__ == "__main__":
    main()
