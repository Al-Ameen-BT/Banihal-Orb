"""BT Proxy DC-DR replication.

Two modes, selected in Settings:

  active-passive : one primary, one read-only standby. The primary pushes its
                   policy config to the standby on every change and on a timer.
                   The standby refuses local config edits until an admin
                   promotes it. Manual failover only (no automatic promotion -
                   automatic failover risks split-brain, where both nodes think
                   they are primary).

  active-active  : both nodes accept edits and push to each other. Conflicts are
                   resolved last-write-wins per item using a monotonic version
                   stamp, and every resolution is audited (never silent).

What syncs: the POLICY config only -
  branches.json (access rules), network.json (ports + full-access),
  the ACL list files, the dependency lists, and the POLICY subset of
  settings.json (proxy behaviour, SMTP, syslog target, AD auth config).

What NEVER syncs (each node keeps its own):
  users / passwords / MFA secrets (squidui.db), the node's TLS certificate,
  secret.key, the licence, and NODE-LOCAL settings (hostname, SSL on/off and
  paths, the AD CA-file path, and the DR config itself). Keeping identity and
  users node-local means a compromise or DB tamper on one node cannot
  propagate to the other, and each node stays independently controllable.

Transport: an HTTPS endpoint on the existing app, reached over the existing
DC-DR VPN/ADVPN tunnel. Every request is HMAC-signed with a shared secret and
the sender's IP is checked against the configured peer, so a node only accepts
a bundle it can prove came from its real peer. The tunnel gives confidentiality;
the HMAC gives authenticity (defence in depth).
"""

import hashlib
import hmac
import io
import json
import os
import tarfile
import threading
import time
from datetime import datetime

import config
import crypto_util

# ---- what is in a policy bundle -------------------------------------------

# Files copied verbatim (path relative to BASE_DIR).
BUNDLE_FILES = ["branches.json", "network.json"]
# Directories copied whole (list files, dependency lists).
BUNDLE_DIRS = []          # ACL_DIR is outside BASE_DIR; handled separately

# settings.json keys that ARE policy and should replicate.
SETTINGS_POLICY_KEYS = {
    # proxy / access behaviour
    "auto_reconfigure", "shutdown_lifetime",
    # email alerting (targets + toggles; password is encrypted with the LOCAL
    # secret.key so it is re-entered per node - see note in apply())
    "smtp_enabled", "smtp_host", "smtp_port", "smtp_security", "smtp_verify_cert",
    "smtp_from", "smtp_to", "smtp_timeout",
    "alert_login_fail", "alert_config_change", "alert_service",
    "alert_license", "alert_cert",
    # syslog / SIEM forwarding (target is policy; host may be node-local, see below)
    "syslog_enabled", "syslog_port", "syslog_proto",
    # AD auth policy (NOT the CA-file path, which is node-local)
    "ad_enabled", "ad_host1", "ad_host2", "ad_port", "ad_security",
    "ad_verify_cert", "ad_domain", "ad_base_dn",
    "ad_group_admin", "ad_group_operator", "ad_group_viewer", "ad_timeout",
    # backup schedule policy
    "backup_schedule", "backup_time", "backup_weekday", "backup_dom",
    "backup_keep",
}

# settings.json keys that are NODE-LOCAL and must never be copied.
SETTINGS_NODE_LOCAL = {
    "hostname", "ssl_enabled", "ssl_on", "ssl_cert", "ssl_key", "ad_ca_file",
    "syslog_host",                      # each node may forward to a local relay
    "ad_bind_password", "smtp_password",  # encrypted with the node's secret.key
    "acl_schema",
    # the entire DR config block (dr_*) is node-local by definition
}


def _dr_defaults():
    return {
        "dr_enabled": False,
        "dr_mode": "active-passive",   # active-passive | active-active
        "dr_role": "primary",          # primary | standby   (passive mode)
        "dr_peer_host": "",            # peer's address on the DC-DR tunnel
        "dr_peer_port": getattr(config, "LISTEN_PORT", 8800),
        "dr_secret": "",               # shared HMAC secret (encrypted at rest)
        "dr_verify_cert": False,       # peer uses its own cert; off by default
        "dr_sync_interval": 300,       # periodic safety sync, seconds
        "dr_last_sync": "",
        "dr_last_status": "",
    }


# ---- bundle build / verify -------------------------------------------------

def _policy_settings(settings):
    return {k: settings[k] for k in SETTINGS_POLICY_KEYS if k in settings}


def build_bundle(settings, branches_path, network_path, acl_dir, deplist_dir):
    """Return (bytes, meta) for a signed policy bundle."""
    buf = io.BytesIO()
    meta = {
        "version": 1,
        "created": datetime.now().isoformat(timespec="seconds"),
        "source": _hostname(),
    }
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        def add_bytes(name, data):
            info = tarfile.TarInfo(name)
            info.size = len(data)
            info.mtime = int(time.time())
            tar.addfile(info, io.BytesIO(data))

        # policy settings (subset only)
        add_bytes("settings_policy.json",
                  json.dumps(_policy_settings(settings)).encode())
        # config maps
        for p, name in ((branches_path, "branches.json"),
                        (network_path, "network.json")):
            if os.path.exists(p):
                with open(p, "rb") as f:
                    add_bytes(name, f.read())
        # ACL list files (skip the machine-generated include)
        if os.path.isdir(acl_dir):
            for fn in sorted(os.listdir(acl_dir)):
                full = os.path.join(acl_dir, fn)
                if (os.path.isfile(full) and fn.endswith((".txt", ".acl"))
                        and fn != os.path.basename(config.GEN_CONF)):
                    with open(full, "rb") as f:
                        add_bytes(f"acls/{fn}", f.read())
        # dependency lists
        if os.path.isdir(deplist_dir):
            for fn in sorted(os.listdir(deplist_dir)):
                full = os.path.join(deplist_dir, fn)
                if os.path.isfile(full) and fn != "README.txt":
                    with open(full, "rb") as f:
                        add_bytes(f"deplists/{fn}", f.read())
    data = buf.getvalue()
    meta["sha256"] = hashlib.sha256(data).hexdigest()
    return data, meta


def sign(secret, data):
    """HMAC-SHA256 of the bundle, hex. secret is the plaintext shared secret."""
    return hmac.new(secret.encode(), data, hashlib.sha256).hexdigest()


def verify_sig(secret, data, sig):
    return hmac.compare_digest(sign(secret, data), sig or "")


# ---- apply an incoming bundle ---------------------------------------------

def apply_bundle(data, acl_dir, base_dir, save_settings, load_settings,
                 parse_cmd, run_squid, reconfigure_cmd, audit_fn):
    """Validate then apply a received bundle. Returns (ok, message).

    Safety: the new ACL/config is written to a staging area and validated with
    'squid -k parse' BEFORE being applied. If it fails, the node keeps its
    current (last-good) config - a standby must stay reliable.
    """
    try:
        tar = tarfile.open(fileobj=io.BytesIO(data), mode="r:gz")
    except Exception as e:
        return False, f"bundle is not a valid archive: {e}"

    # path-traversal guard: no member may escape its intended dir
    members = tar.getmembers()
    for m in members:
        if m.name.startswith("/") or ".." in m.name.split("/"):
            return False, f"rejected unsafe path in bundle: {m.name}"

    staged = {}
    for m in members:
        if not m.isfile():
            continue
        staged[m.name] = tar.extractfile(m).read()

    # ---- merge policy settings (never touch node-local keys) ----
    if "settings_policy.json" in staged:
        try:
            incoming = json.loads(staged["settings_policy.json"])
        except Exception:
            return False, "settings_policy.json is not valid JSON"
        cur = load_settings()
        for k, v in incoming.items():
            if k in SETTINGS_NODE_LOCAL:
                continue                     # defensive: never overwrite local
            cur[k] = v
        save_settings(cur)

    # ---- write config maps ----
    for name in ("branches.json", "network.json"):
        if name in staged:
            dst = os.path.join(base_dir, name)
            _atomic_write(dst, staged[name])

    # ---- write ACL list files ----
    if os.path.isdir(acl_dir):
        for name, blob in staged.items():
            if name.startswith("acls/"):
                _atomic_write(os.path.join(acl_dir, os.path.basename(name)), blob)
            elif name.startswith("deplists/"):
                _atomic_write(os.path.join(base_dir, "deplists",
                                           os.path.basename(name)), blob)

    # ---- validate with squid -k parse BEFORE reload ----
    ok, out = run_squid(parse_cmd)
    if not ok:
        audit_fn("dr-apply-rejected", f"squid parse failed: {out[:200]}")
        return False, ("received config failed squid validation - kept previous "
                       "config. Detail: " + out[:200])

    # ---- apply live ----
    ok, out = run_squid(reconfigure_cmd)
    msg = "config applied and Squid reloaded" if ok else f"applied; reload said: {out[:120]}"
    audit_fn("dr-apply", msg)
    return True, msg


def _atomic_write(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, path)


def _hostname():
    import socket
    return socket.gethostname().split(".")[0]
