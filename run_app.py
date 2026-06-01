#!/usr/bin/env python3
"""
🚀 Tech Platform Orchestrator — Unified Client & Server Process Supervisor
This script concurrently executes and supervises the Express API backend and Next.js frontend.
It captures process streams, aggregates logs with prefixes, handles graceful shutdowns, 
and is specifically designed to be executed as a systemd service.
"""

import os
import sys
import signal
import subprocess
import threading
import time

# ─── Configuration & Context ──────────────────────────────────────────────────
PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))
SERVER_DIR = os.path.join(PROJECT_DIR, "server")
CLIENT_DIR = os.path.join(PROJECT_DIR, "client")

# Detect running environment (development vs production)
RUN_MODE = "dev" if "--dev" in sys.argv or os.environ.get("NODE_ENV") == "development" else "start"
ENV_MODE = "development" if RUN_MODE == "dev" else "production"

# Track running child processes
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
                # On Unix, terminate the subprocess and its children
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

def launch_subprocess(cwd, run_mode, port, prefix):
    """Spins up a Node subprocess in the designated directory."""
    # Find npm binary
    npm_bin = "npm.cmd" if os.name == "nt" else "npm"
    cmd = [npm_bin, "run", run_mode]
    
    env = os.environ.copy()
    env["PORT"] = str(port)
    env["NODE_ENV"] = ENV_MODE

    log("[Orchestrator]", f"Launching {prefix} ({' '.join(cmd)}) on port {port}...")
    
    # Run the subprocess in a new process group (so signals sent to parent aren't automatically sent to child)
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
        
        # Start background threads to stream output streams
        threading.Thread(target=stream_output, args=(p.stdout, prefix), daemon=True).start()
        threading.Thread(target=stream_output, args=(p.stderr, f"{prefix}-Err"), daemon=True).start()
        return p
    except Exception as e:
        log("[Orchestrator]", f"Failed to start {prefix}: {e}")
        kill_child_processes()
        sys.exit(1)

def main():
    # Setup signal listeners for Linux systemd management
    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)

    log("[Orchestrator]", f"Platform booting in {ENV_MODE.upper()} mode...")
    
    # 1. Start Server on port 3001
    server_process = launch_subprocess(SERVER_DIR, RUN_MODE, 3001, "[Server]")
    
    # Wait briefly for database validation and server setup
    time.sleep(1.5)
    
    # 2. Start Client on port 3000
    client_process = launch_subprocess(CLIENT_DIR, RUN_MODE, 3000, "[Client]")

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

if __name__ == "__main__":
    main()
