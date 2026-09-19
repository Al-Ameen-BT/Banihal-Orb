#!/usr/bin/env python3
"""squid-agent-telemetry.py — collect squid telemetry and push it to the platform.

Reads the squid access.log incrementally (state file tracks byte offset + inode,
surviving rotation), derives cumulative counters (requests/denied/bytes/clients),
keeps a rolling 10-minute session window for the Live UI, grabs host
cpu/mem/disk + squid version/uptime, and POSTs one signed snapshot to
`POST /api/proxy-agent/telemetry`.

Stdlib only (squid hosts already run the Python bot). Env:
    SQUID_PLATFORM        https://origin, no trailing slash        [required]
    SQUID_PROXY_ID        platform proxy id                        [required]
    SQUID_KEY_FILE        raw `pk_…` registration key       (default /etc/squid-agent/key)
    SQUID_ACCESS_LOG      squid access log                  (default /var/log/squid/access.log)
    SQUID_MANAGER_PID     squid master pid (pgrep -o squid) (default auto)
    SQUID_TELEMETRY_STATE state file                        (default /var/lib/squid-agent/telemetry.state)
    SQUID_HOME_DIR        disk metric target                (default /var/spool/squid)
    SQUID_BOT_SERVICE     slack bot systemd unit to monitor (default slack-squid-proxy)
    SQUID_MAIN_CONF       main squid config to snapshot     (default /etc/squid/squid.conf)
    SQUID_CONF_DIR        generated conf dir to snapshot    (default /etc/squid/acls)
"""
import hashlib
import hmac
import json
import os
import re
import sys
import time
import urllib.request

LOG_LINE = re.compile(
    r"^(?P<ts>\d+(?:\.\d+)?)\s+(?P<elapsed>-?\d+)\s+(?P<client>\S+)\s+"
    r"(?P<result>\S+)\s+(?P<bytes>\d+)\s+(?P<method>\S+)\s+(?P<url>\S+)"
)

WINDOW_SECONDS = 10 * 60
MAX_LINES = 500

def env(name, default):
    return os.environ.get(name, "").strip() or default

PLATFORM = env("SQUID_PLATFORM", "")
PROXY_ID = env("SQUID_PROXY_ID", "")
KEY_FILE = env("SQUID_KEY_FILE", "/etc/squid-agent/key")
ACCESS_LOG = env("SQUID_ACCESS_LOG", "/var/log/squid/access.log")
STATE_FILE = env("SQUID_TELEMETRY_STATE", "/var/lib/squid-agent/telemetry.state")
HOME_DIR = env("SQUID_HOME_DIR", "/var/spool/squid")
BOT_SERVICE = env("SQUID_BOT_SERVICE", "slack-squid-proxy")
MAIN_CONF = env("SQUID_MAIN_CONF", "/etc/squid/squid.conf")
CONF_DIR = env("SQUID_CONF_DIR", "/etc/squid/acls")


def fail(msg):
    print(f"telemetry: {msg}", file=sys.stderr)
    sys.exit(1)


if not PLATFORM or not PROXY_ID:
    fail("SQUID_PLATFORM and SQUID_PROXY_ID are required")
with open(KEY_FILE, "r") as f:
    KEY = f.read().strip().encode()


def slack_bot_status():
    """systemd state of the Slack bot companion service. Returns None when absent."""
    import subprocess
    out = subprocess.run(["systemctl", "is-active", BOT_SERVICE], capture_output=True, text=True, timeout=10)
    state = out.stdout.strip()
    if state not in ("active", "inactive", "failed"):
        return None
    last_error = None
    try:
        show = subprocess.run(["systemctl", "show", BOT_SERVICE, "-p", "ExecMainStatus"], capture_output=True, text=True, timeout=10)
        for line in show.stdout.splitlines():
            if line.startswith("ExecMainStatus="):
                code = line.split("=", 1)[1].strip()
                if code not in ("", "0"):
                    last_error = f"exit code {code}"
    except Exception:
        pass
    return {"table": BOT_SERVICE, "state": state, "lastError": last_error}


def read_conf_snapshot():
    """Read-only snapshot of the host squid config for the org/platform view.

    Ships the MAIN squid.conf plus each generated `include` file, but only the
    main conf when the acls dir is empty. Returns None if nothing readable —
    the caller compares a hash so unchanged config pushes nothing.
    """
    main = ""
    try:
        with open(MAIN_CONF) as f:
            main = f.read()[:200_000]
    except OSError:
        return None
    files = [{"path": MAIN_CONF, "content": main}]
    try:
        if os.path.isdir(CONF_DIR):
            for name in sorted(os.listdir(CONF_DIR)):
                if not name.endswith(".conf"):
                    continue
                p = os.path.join(CONF_DIR, name)
                try:
                    with open(p) as f:
                        files.append({"path": p, "content": f.read()[:200_000]})
                except OSError:
                    continue
    except OSError:
        pass
    h = hashlib.sha256("\n".join(f["path"] + f["content"] for f in files).encode()).hexdigest()
    return {"hash": h, "capturedAt": int(time.time() * 1000), "files": files}


def log_vfs(dirpath):
    """cpu/disk/mem from /proc + statvfs; None when unavailable."""
    percent = None
    try:
        st = os.statvfs(dirpath)
        percent = round(100.0 * (1 - st.f_bavail / st.f_blocks), 1) if st.f_blocks else None
    except OSError:
        pass
    return percent

def total_mem_kb():
    try:
        with open("/proc/meminfo") as f:
            for line in f:
                if line.startswith("MemTotal:"):
                    return int(line.split()[1])
    except OSError:
        pass
    return None

def squid_pid():
    path = env("SQUID_MANAGER_PID", "")
    if path:
        try:
            return int(path)
        except ValueError:
            pass
    try:
        import subprocess
        out = subprocess.run(["pgrep", "-o", "squid"], capture_output=True, text=True, timeout=5)
        return int(out.stdout.strip()) if out.stdout.strip().isdigit() else None
    except Exception:
        return None

def read_times(pid):
    try:
        with open(f"/proc/{pid}/stat") as f:
            parts = f.read().split()
        return int(parts[11]) + int(parts[12]), int(parts[13]) + int(parts[14])
    except (OSError, IndexError, ValueError):
        return None, None

def caller_metrics(pid):
    """cpu/mem/uptime/version for the squid master process; None pieces degrade."""
    cpu = mem = uptime = version = None
    import subprocess
    def sc(args):
        try:
            return subprocess.run(args, capture_output=True, text=True, timeout=10).stdout.strip()
        except Exception:
            return None

    t0, s0 = read_times(pid)
    if t0 is not None:
        time.sleep(1.0)
        t1, s1 = read_times(pid)
        hz = os.sysconf("SC_CLK_TCK")
        if s1 is not None:
            cpu = round(100.0 * (t1 - t0) / hz, 1)
        mem_total_kb = total_mem_kb()
        rss_kb = None
        try:
            with open(f"/proc/{pid}/status") as f:
                for line in f:
                    if line.startswith("VmRSS:"):
                        rss_kb = int(line.split()[1])
                        break
        except OSError:
            pass
        if rss_kb and mem_total_kb:
            mem = round(100.0 * rss_kb / mem_total_kb, 1)

    et = sc(["ps", "-o", "etimes=", "-p", str(pid)])
    if et is not None:
        try:
            uptime = int(et)
        except ValueError:
            pass
    v = sc(["squid", "-v"])
    if v:
        version = v.splitlines()[0].strip()
    return cpu, mem, uptime, version


def load_state():
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {"offset": 0, "ino": None, "counters": {"requests": 0, "denied": 0, "bytes": 0, "clients": 0}, "seq": 0, "window": []}


def save_state(state):
    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f)
    os.replace(tmp, STATE_FILE)


def read_log(state):
    """Parse new access.log lines since the last offset. Handles rotation by inode."""
    entries = []
    try:
        st = os.stat(ACCESS_LOG)
        ino = st.st_ino
        if state.get("ino") and state["ino"] != ino:
            state["offset"] = 0  # rotated — restart from top of new file
        with open(ACCESS_LOG, "r") as f:
            f.seek(max(0, st.st_size - 2_000_000))  # don't read more than ~2MB of old tail on rotation
            f.seek(0, 1)
            f.seek(state["offset"])
            for line in f:
                m = LOG_LINE.match(line)
                if not m:
                    continue
                d = m.groupdict()
                entries.append({
                    "ts": int(float(d["ts"])),
                    "ip": d["client"],
                    "method": d["method"][:16],
                    "action": "denied" if "DENIED" in d["result"] else "allowed",
                    "url": d["url"][:2048],
                    "bytes": int(d["bytes"]),
                })
            state["offset"] = f.tell()
        state["ino"] = ino
    except OSError:
        pass
    return entries


def send_snapshot(state, caller, peers, disk, conf=None):
    body = {
        "seq": state["seq"] + 1,
        "observedAt": int(time.time() * 1000),
        "counters": state["counters"],
        "sessions": peers,
        "logLines": state["window"][-MAX_LINES:],
    }
    if conf:
        body["confSnapshot"] = conf
    if caller["version"]:
        body["squidVersion"] = caller["version"]
    if caller["uptime"] is not None:
        body["uptimeSeconds"] = caller["uptime"]
    if caller["cpu"] is not None:
        body["cpuPercent"] = caller["cpu"]
    if caller["mem"] is not None:
        body["memPercent"] = caller["mem"]
    if disk is not None:
        body["diskPercent"] = disk

    bot = slack_bot_status()
    if bot:
        body["slackBot"] = bot

    if state.get("conf_hash"):
        body["confHash"] = state["conf_hash"]

    raw = json.dumps(body, separators=(",", ":"), default=lambda _: None).encode()
    ts = int(time.time() * 1000)
    path = "/api/proxy-agent/telemetry"
    canonical = f"{ts}\nPOST\n{path}\n{hashlib.sha256(raw).hexdigest()}".encode()
    sig = hmac.new(KEY, canonical, hashlib.sha256).hexdigest()

    req = urllib.request.Request(
        PLATFORM + path, data=raw, method="POST",
        headers={
            "Content-Type": "application/json",
            "X-Proxy-Id": PROXY_ID,
            "X-Proxy-Timestamp": str(ts),
            "Authorization": f"Bearer {sig}",
        },
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        resp.read()
    state["seq"] += 1
    return True


def main():
    state = load_state()
    entries = read_log(state)
    now = int(time.time())

    for e in entries:
        c = state["counters"]
        c["requests"] += 1
        c["bytes"] += e["bytes"]
        if e["action"] == "denied":
            c["denied"] += 1
    new_clients = {e["ip"] for e in entries}
    if new_clients:
        seen = set(state.get("counter_clients_seen", []))
        seen |= new_clients
        state["counter_clients_seen"] = sorted(seen)
    state["counters"]["clients"] = len(state.get("counter_clients_seen", []))

    # Rolling window: keep lines from the last 10 minutes (Live Activity + sessions).
    window = [e for e in state["window"] if now - e["ts"] <= WINDOW_SECONDS] + entries
    state["window"] = window[-MAX_LINES:]
    peers = sorted({e["ip"] for e in window})

    pid = squid_pid()
    cpu, mem, uptime, version = None, None, None, None
    if pid:
        cpu, mem, uptime, version = caller_metrics(pid)
    disk = log_vfs(HOME_DIR)

    caller = {"cpu": cpu, "mem": mem, "uptime": uptime, "version": version}
    conf = read_conf_snapshot()
    if conf and state.get("conf_hash") != conf["hash"]:
        send_snapshot(state, caller, peers, disk, conf)   # config changed — ship the files
        state["conf_hash"] = conf["hash"]
    else:
        send_snapshot(state, caller, peers, disk)          # unchanged — hash only (conf_hash in body below)
    save_state(state)
    print(f"telemetry: pushed seq={state['seq']} lines={len(entries)} sessions={len(peers)}")


if __name__ == "__main__":
    main()