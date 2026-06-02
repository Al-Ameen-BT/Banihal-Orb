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
import json
import urllib.request

SYSTEMD_PATH = "/etc/systemd/system"
SERVICE_NAME = "b2bweb.service"

# Defaults for the Ollama chatbot backend (kept in sync with server/src/config/env.ts).
# Overridable via OLLAMA_URL / OLLAMA_MODEL in server/.env.
DEFAULT_OLLAMA_URL = "http://localhost:11435"
DEFAULT_OLLAMA_MODEL = "qwen2.5:3b"


def read_env_value(env_path, key, default):
    """Reads a single KEY=value from a .env file (ignores quotes/comments). Returns default if absent."""
    try:
        with open(env_path, "r", encoding="utf-8") as f:
            for raw in f:
                line = raw.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                if k.strip() == key:
                    v = v.strip().strip('"').strip("'")
                    return v or default
    except Exception:
        pass
    return default

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

def prepare_applications(project_dir, is_dev):
    """
    Ensures dependencies are installed, database is migrated/pushed/seeded via Prisma,
    and both backend and frontend applications are built/compiled for production.
    """
    server_dir = os.path.join(project_dir, "server")
    client_dir = os.path.join(project_dir, "client")
    npm_bin = "npm.cmd" if os.name == "nt" else "npm"

    log("[Preparer]", "Starting application preparation and build pipeline...")

    # Helper function to run commands with streaming output
    def run_preparer_command(cmd, cwd, step_name):
        log("[Preparer]", f"Executing: {' '.join(cmd)} (cwd: {cwd})")
        try:
            p = subprocess.Popen(
                cmd,
                cwd=cwd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1
            )
            for line in iter(p.stdout.readline, ""):
                clean_line = line.strip()
                if clean_line:
                    log(f"[{step_name}]", clean_line)
            p.wait()
            if p.returncode != 0:
                raise subprocess.CalledProcessError(p.returncode, cmd)
        except Exception as e:
            log("[Preparer]", f"❌ Error during step '{step_name}': {e}")
            raise e

    # --- 1. SERVER PREPARATION ---
    # Dependencies
    log("[Preparer]", "Checking server dependencies...")
    node_modules_server = os.path.join(server_dir, "node_modules")
    if not os.path.exists(node_modules_server):
        run_preparer_command([npm_bin, "install"], server_dir, "Server-Install")
    else:
        log("[Preparer]", "server/node_modules already exists. Skipping npm install.")

    # Prisma Client Generation
    run_preparer_command([npm_bin, "run", "db:generate"], server_dir, "Server-Prisma-Gen")

    # Sync DB Schema
    log("[Preparer]", "Syncing database schema (prisma db push)...")
    try:
        run_preparer_command([npm_bin, "run", "db:push"], server_dir, "Server-Prisma-Push")
        log("[Preparer]", "Database schema synced successfully.")
    except Exception as e:
        log("[Preparer]", f"⚠️ Warning: Database schema sync failed. Ensure your Postgres database is running and DATABASE_URL in server/.env is correct: {e}")

    # Seed Database
    log("[Preparer]", "Seeding database...")
    try:
        run_preparer_command([npm_bin, "run", "db:seed"], server_dir, "Server-Prisma-Seed")
        log("[Preparer]", "Database seeded successfully.")
    except Exception as e:
        log("[Preparer]", f"⚠️ Warning: Database seeding failed (might be because seed data already exists or DB connection issue): {e}")

    # Build Server (Production mode only)
    if not is_dev:
        run_preparer_command([npm_bin, "run", "build"], server_dir, "Server-Build")
        log("[Preparer]", "Server compiled successfully.")

    # --- 2. CLIENT PREPARATION ---
    # Dependencies
    log("[Preparer]", "Checking client dependencies...")
    node_modules_client = os.path.join(client_dir, "node_modules")
    if not os.path.exists(node_modules_client):
        run_preparer_command([npm_bin, "install"], client_dir, "Client-Install")
    else:
        log("[Preparer]", "client/node_modules already exists. Skipping npm install.")

    # Build Client (Production mode only)
    if not is_dev:
        run_preparer_command([npm_bin, "run", "build"], client_dir, "Client-Build")
        log("[Preparer]", "Client compiled successfully.")

    # --- 3. OLLAMA CHATBOT BACKEND PREFLIGHT ---
    # The /chat feature proxies to a local Ollama server. Verify it's reachable and the
    # chat model is pulled. This is best-effort: failures warn but never block deployment.
    env_path = os.path.join(server_dir, ".env")
    ollama_url = read_env_value(env_path, "OLLAMA_URL", DEFAULT_OLLAMA_URL)
    ollama_model = read_env_value(env_path, "OLLAMA_MODEL", DEFAULT_OLLAMA_MODEL)
    log("[Preparer]", f"Checking Ollama chatbot backend at {ollama_url} (model: {ollama_model})...")

    model_present = False
    reachable = False
    try:
        with urllib.request.urlopen(ollama_url.rstrip("/") + "/api/tags", timeout=5) as resp:
            tags = json.loads(resp.read().decode("utf-8"))
        reachable = True
        available = [m.get("name", "") for m in tags.get("models", [])]
        model_present = ollama_model in available
        if model_present:
            log("[Preparer]", f"Ollama model '{ollama_model}' is available. ✨")
        else:
            log("[Preparer]", f"⚠️ Model '{ollama_model}' not found. Available: {available or 'none'}")
    except Exception as e:
        log("[Preparer]", f"⚠️ Warning: Could not reach Ollama at {ollama_url} ({e}). "
                          f"The chat assistant will be unavailable until Ollama is running.")

    # Attempt to pull the model if Ollama is up but the model is missing.
    if reachable and not model_present:
        ollama_bin = shutil.which("ollama")
        if not ollama_bin:
            log("[Preparer]", f"⚠️ 'ollama' CLI not found in PATH; cannot auto-pull. Run manually: ollama pull {ollama_model}")
        else:
            try:
                run_preparer_command([ollama_bin, "pull", ollama_model], project_dir, "Ollama-Pull")
                log("[Preparer]", f"Ollama model '{ollama_model}' pulled successfully.")
            except Exception as e:
                log("[Preparer]", f"⚠️ Warning: Failed to pull Ollama model '{ollama_model}': {e}")

    log("[Preparer]", "Application preparation and build pipeline completed successfully! ✨")


def run_supervisor(project_dir, is_dev):
    """Spins up, supervises, and maintains both the server and client processes."""
    # Setup signal listeners for Linux systemd management
    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)

    server_dir = os.path.join(project_dir, "server")
    client_dir = os.path.join(project_dir, "client")

    # Auto-prepare if build folders or node_modules are missing
    server_dist = os.path.join(server_dir, "dist")
    client_next = os.path.join(client_dir, ".next")
    
    needs_prep = False
    if not is_dev:
        if not os.path.exists(os.path.join(server_dist, "server.js")) or not os.path.exists(client_next):
            needs_prep = True
    else:
        if not os.path.exists(os.path.join(server_dir, "node_modules")) or not os.path.exists(os.path.join(client_dir, "node_modules")):
            needs_prep = True

    if needs_prep:
        log("[Orchestrator]", "Detected missing build outputs or dependencies. Running auto-preparation/build flow...")
        try:
            prepare_applications(project_dir, is_dev)
        except Exception as e:
            log("[Orchestrator]", f"❌ Fatal: Auto-preparation failed: {e}")
            sys.exit(1)

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
    if os.name == 'nt':
        try:
            import ctypes
            return ctypes.windll.shell32.IsUserAnAdmin() != 0
        except Exception:
            return False
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
After=network.target postgresql.service ollama.service
Wants=ollama.service
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

    # Compile and prepare application files so they are ready BEFORE systemd starts the service
    print("\n📦 Preparing applications (installing dependencies, database sync/seeding, and compiling code)...")
    try:
        prepare_applications(project_dir, is_dev)
    except Exception as e:
        print(f"❌ Error preparing applications: {e}")
        print("   Service was installed but could not be built. Please fix the build error and re-run installation.")
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
    # Reconfigure stdout/stderr to use UTF-8 if possible to prevent emoji/unicode encoding crashes on legacy consoles (e.g., Windows CP1252)
    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(encoding="utf-8")
        except Exception:
            pass
    if hasattr(sys.stderr, "reconfigure"):
        try:
            sys.stderr.reconfigure(encoding="utf-8")
        except Exception:
            pass

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
