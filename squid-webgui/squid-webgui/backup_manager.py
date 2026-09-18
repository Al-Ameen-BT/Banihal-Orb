"""
BT Proxy - configuration backup, restore and factory reset.

A backup is a tar.gz containing the configuration and data that make a
deployment unique:

    branches.json      rules, access lists, sources, modes
    network.json       network rules
    settings.json      branding, AD, SMTP, HTTPS state  (secrets encrypted)
    squidui.db         users, MFA secrets, audit log
    secret.key         key that decrypts the AD/SMTP passwords
    deplists/          imported dependency-finder lists
    acls/              the branch whitelist/blacklist files
    manifest.json      version, hostname, timestamp, checksums

SECURITY NOTES (important):
  * A backup contains password hashes, MFA secrets and secret.key. It is
    equivalent to the server's identity - treat it as a secret. Files are
    written 0600, and the GUI warns before emailing one.
  * Restore validates the manifest and every checksum before writing anything,
    refuses path traversal, and takes a safety snapshot first so a bad restore
    can be undone.
  * Factory reset requires the admin's password to be re-entered, snapshots
    everything first, and is audit-logged.
"""
import hashlib
import io
import json
import os
import shutil
import socket
import tarfile
import time
from datetime import datetime

import config

BACKUP_DIR = os.path.join(config.BASE_DIR, "backups")
SNAPSHOT_DIR = os.path.join(BACKUP_DIR, "_snapshots")

# (path relative to BASE_DIR, required?)
DATA_FILES = [
    ("branches.json", False),
    ("network.json", False),
    ("settings.json", False),
    ("squidui.db", True),
    ("secret.key", False),
]
DATA_DIRS = ["deplists"]


def _acl_dir():
    return config.ACL_DIR


def _sha(data):
    return hashlib.sha256(data).hexdigest()


def _safe_name(name):
    """Reject anything that could escape the extraction root."""
    n = os.path.normpath(name)
    return not (n.startswith("..") or os.path.isabs(n) or n.startswith("/"))


def create(note=""):
    """Create a backup archive. Returns (path, filename)."""
    os.makedirs(BACKUP_DIR, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    host = socket.gethostname()
    fname = f"btproxy-backup-{host}-{ts}.tar.gz"
    path = os.path.join(BACKUP_DIR, fname)

    members = []          # (arcname, bytes)
    checksums = {}

    for rel, _req in DATA_FILES:
        p = os.path.join(config.BASE_DIR, rel)
        if os.path.exists(p):
            with open(p, "rb") as f:
                data = f.read()
            members.append((f"data/{rel}", data))
            checksums[f"data/{rel}"] = _sha(data)

    for d in DATA_DIRS:
        base = os.path.join(config.BASE_DIR, d)
        if not os.path.isdir(base):
            continue
        for root, _, names in os.walk(base):
            for n in names:
                p = os.path.join(root, n)
                rel = os.path.relpath(p, config.BASE_DIR)
                with open(p, "rb") as f:
                    data = f.read()
                members.append((f"data/{rel}", data))
                checksums[f"data/{rel}"] = _sha(data)

    # ACL files (may live outside BASE_DIR, e.g. /etc/squid/acls)
    ad = _acl_dir()
    if os.path.isdir(ad):
        for n in sorted(os.listdir(ad)):
            p = os.path.join(ad, n)
            if not os.path.isfile(p):
                continue
            with open(p, "rb") as f:
                data = f.read()
            members.append((f"acls/{n}", data))
            checksums[f"acls/{n}"] = _sha(data)

    manifest = {
        "format": 1,
        "product": "BT Proxy",
        "version": config.APP_VERSION,
        "hostname": host,
        "created": datetime.now().isoformat(timespec="seconds"),
        "note": note[:200],
        "acl_dir": ad,
        "files": checksums,
    }
    mdata = json.dumps(manifest, indent=2).encode()

    old = os.umask(0o077)          # backups contain secrets -> 0600
    try:
        with tarfile.open(path, "w:gz") as tf:
            info = tarfile.TarInfo("manifest.json")
            info.size = len(mdata)
            info.mtime = int(time.time())
            tf.addfile(info, io.BytesIO(mdata))
            for arc, data in members:
                info = tarfile.TarInfo(arc)
                info.size = len(data)
                info.mtime = int(time.time())
                info.mode = 0o600
                tf.addfile(info, io.BytesIO(data))
    finally:
        os.umask(old)
    os.chmod(path, 0o600)
    return path, fname


def read_manifest(path):
    """Return the manifest of a backup file, or raise ValueError."""
    try:
        with tarfile.open(path, "r:gz") as tf:
            m = tf.extractfile("manifest.json")
            if m is None:
                raise ValueError("Not a BT Proxy backup (no manifest).")
            manifest = json.load(m)
    except (tarfile.TarError, KeyError, OSError, json.JSONDecodeError) as e:
        raise ValueError(f"Not a valid backup archive ({e})")
    if manifest.get("product") != "BT Proxy":
        raise ValueError("This file is not a BT Proxy backup.")
    return manifest


def inspect(path):
    """Summarise a backup for display before restoring."""
    m = read_manifest(path)
    return {
        "version": m.get("version", "?"),
        "hostname": m.get("hostname", "?"),
        "created": m.get("created", "?"),
        "note": m.get("note", ""),
        "file_count": len(m.get("files", {})),
        "current_version": config.APP_VERSION,
        "acl_dir": m.get("acl_dir", ""),
    }


def _snapshot(tag):
    """Copy current config/data aside so a restore or reset can be undone."""
    os.makedirs(SNAPSHOT_DIR, exist_ok=True)
    dest = os.path.join(SNAPSHOT_DIR,
                        f"{tag}_{datetime.now().strftime('%Y%m%d_%H%M%S')}")
    os.makedirs(dest, exist_ok=True)
    for rel, _ in DATA_FILES:
        p = os.path.join(config.BASE_DIR, rel)
        if os.path.exists(p):
            shutil.copy2(p, os.path.join(dest, os.path.basename(rel)))
    ad = _acl_dir()
    if os.path.isdir(ad):
        shutil.copytree(ad, os.path.join(dest, "acls"), dirs_exist_ok=True)
    for d in DATA_DIRS:
        src = os.path.join(config.BASE_DIR, d)
        if os.path.isdir(src):
            shutil.copytree(src, os.path.join(dest, d), dirs_exist_ok=True)
    return dest


def restore(path):
    """Validate then restore a backup. Returns (ok, message).
    Takes a safety snapshot first."""
    try:
        manifest = read_manifest(path)
    except ValueError as e:
        return False, str(e)

    checksums = manifest.get("files", {})
    # read + verify EVERYTHING before writing anything
    staged = []
    try:
        with tarfile.open(path, "r:gz") as tf:
            for member in tf.getmembers():
                if not member.isfile() or member.name == "manifest.json":
                    continue
                if not _safe_name(member.name):
                    return False, f"Unsafe path in backup: {member.name}"
                f = tf.extractfile(member)
                if f is None:
                    continue
                data = f.read()
                want = checksums.get(member.name)
                if want and _sha(data) != want:
                    return False, f"Checksum mismatch for {member.name} - " \
                                  f"the backup is corrupt."
                staged.append((member.name, data))
    except tarfile.TarError as e:
        return False, f"Could not read the backup ({e})"

    if not staged:
        return False, "Backup contains no data."

    snap = _snapshot("pre-restore")

    try:
        for arc, data in staged:
            if arc.startswith("data/"):
                rel = arc[len("data/"):]
                dest = os.path.join(config.BASE_DIR, rel)
            elif arc.startswith("acls/"):
                dest = os.path.join(_acl_dir(), os.path.basename(arc))
            else:
                continue
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            old = os.umask(0o077)
            try:
                with open(dest, "wb") as f:
                    f.write(data)
            finally:
                os.umask(old)
        return True, (f"Restored {len(staged)} file(s) from the backup taken on "
                      f"{manifest.get('created','?')}. A snapshot of the previous "
                      f"configuration was saved. Restart the service, then click "
                      f"Reload Squid.")
    except Exception as e:
        return False, (f"Restore failed: {e}. Your previous configuration is "
                       f"snapshotted at {snap}.")


def factory_reset(keep_admin_username=None):
    """Erase configuration and data, returning the install to first-run state.
    A snapshot is taken first. The caller MUST have re-verified the admin's
    password before calling this. Returns (ok, message, snapshot_path)."""
    snap = _snapshot("pre-factory-reset")
    removed = []
    try:
        # data files
        for rel, _ in DATA_FILES:
            p = os.path.join(config.BASE_DIR, rel)
            if os.path.exists(p):
                os.remove(p)
                removed.append(rel)
        # imported lists
        for d in DATA_DIRS:
            p = os.path.join(config.BASE_DIR, d)
            if os.path.isdir(p):
                shutil.rmtree(p, ignore_errors=True)
                os.makedirs(p, exist_ok=True)
                removed.append(d + "/")
        # generated + branch ACL files (leave squid.conf alone - not ours)
        ad = _acl_dir()
        if os.path.isdir(ad):
            for n in os.listdir(ad):
                p = os.path.join(ad, n)
                if os.path.isfile(p):
                    os.remove(p)
                    removed.append(f"acls/{n}")
        # certificates
        cert_dir = os.path.join(config.BASE_DIR, "certs")
        for n in ("server.crt", "server.key", "pending.key"):
            p = os.path.join(cert_dir, n)
            if os.path.exists(p):
                os.remove(p)
                removed.append(f"certs/{n}")
        return True, (f"Factory reset complete - {len(removed)} item(s) erased. "
                      f"A snapshot was saved to {snap}. Restart the service; the "
                      f"console will return to first-run setup "
                      f"(admin / admin@123)."), snap
    except Exception as e:
        return False, f"Factory reset failed: {e}. Snapshot at {snap}.", snap


def list_backups():
    """Existing backup archives, newest first."""
    if not os.path.isdir(BACKUP_DIR):
        return []
    out = []
    for n in sorted(os.listdir(BACKUP_DIR), reverse=True):
        p = os.path.join(BACKUP_DIR, n)
        if os.path.isfile(p) and n.endswith(".tar.gz"):
            st = os.stat(p)
            out.append({
                "name": n,
                "size_kb": round(st.st_size / 1024, 1),
                "created": datetime.fromtimestamp(st.st_mtime)
                                    .strftime("%Y-%m-%d %H:%M"),
            })
    return out


def prune(keep=10):
    """Keep only the newest N backups on disk."""
    items = list_backups()
    for b in items[keep:]:
        try:
            os.remove(os.path.join(BACKUP_DIR, b["name"]))
        except OSError:
            pass
