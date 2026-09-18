"""
BT Proxy - software update engine (client side).
Applies signed .btpkg packages built by deploy/build_update.py, verifying the
Ed25519 signature (same public key as licenses) before touching any file.

Safety model:
  1. Verify package signature and payload hash -> reject if tampered
  2. Check min_version requirement
  3. Snapshot every file that will be overwritten into updates/backup_<ts>/
  4. Write new files
  5. On any error, restore from the snapshot (automatic rollback)
Config files and data (config.py, *.json, *.db, certs/) are never inside a
package, so customer settings are untouched.
"""
import base64
import hashlib
import io
import json
import os
import shutil
import tarfile
from datetime import datetime

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

import config
import license as lic

UPDATE_DIR = os.path.join(config.BASE_DIR, "updates")
# Files a package must never write, even if it tries (defense in depth)
PROTECTED = {"config.py", "squidui.db", "branches.json", "network.json",
             "settings.json"}


def _ver_tuple(v):
    parts = (v or "0").split(".")
    return tuple(int(x) if x.isdigit() else 0 for x in (parts + ["0", "0", "0"])[:3])


def read_manifest(pkg_path):
    """Return (manifest, payload_bytes) or raise ValueError."""
    try:
        with tarfile.open(pkg_path, "r:gz") as tf:
            m = tf.extractfile("manifest.json").read()
            payload = tf.extractfile("payload.tar").read()
    except (tarfile.TarError, KeyError, OSError) as e:
        raise ValueError(f"Not a valid .btpkg file ({e})")
    manifest = json.loads(m)
    return manifest, payload


def verify_package(manifest, payload):
    """Raise ValueError if signature or payload hash is invalid."""
    if hashlib.sha256(payload).hexdigest() != manifest.get("payload_sha256"):
        raise ValueError("Payload hash mismatch - package is corrupt.")
    core = {k: manifest[k] for k in
            ("version", "min_version", "built", "notes", "files", "payload_sha256")}
    signed_blob = json.dumps(core, sort_keys=True, separators=(",", ":")).encode()
    try:
        pub = Ed25519PublicKey.from_public_bytes(bytes.fromhex(lic.PUBLIC_KEY_HEX))
        pub.verify(base64.b64decode(manifest["sig"]), signed_blob)
    except (InvalidSignature, KeyError, ValueError):
        raise ValueError("Invalid signature - package is not from Banihal "
                         "Technologies LLP or has been altered.")


def inspect(pkg_path):
    """Verify and return a summary dict for display, without applying."""
    manifest, payload = read_manifest(pkg_path)
    verify_package(manifest, payload)
    cur = config.APP_VERSION
    return {
        "version": manifest["version"],
        "min_version": manifest["min_version"],
        "built": manifest["built"],
        "notes": manifest["notes"],
        "file_count": len(manifest["files"]),
        "current": cur,
        "meets_min": _ver_tuple(cur) >= _ver_tuple(manifest["min_version"]),
        "is_newer": _ver_tuple(manifest["version"]) > _ver_tuple(cur),
    }


def apply_package(pkg_path):
    """Verify, back up, and apply. Returns (ok, message)."""
    manifest, payload = read_manifest(pkg_path)
    verify_package(manifest, payload)

    if _ver_tuple(config.APP_VERSION) < _ver_tuple(manifest["min_version"]):
        return False, (f"This package needs version {manifest['min_version']} "
                       f"or newer; you have {config.APP_VERSION}. Apply the "
                       f"intermediate update first.")

    os.makedirs(UPDATE_DIR, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup = os.path.join(UPDATE_DIR, f"backup_{ts}")
    os.makedirs(backup, exist_ok=True)

    # Extract payload members
    members = []
    with tarfile.open(fileobj=io.BytesIO(payload), mode="r") as pt:
        for member in pt.getmembers():
            if not member.isfile():
                continue
            rel = member.name
            if rel.startswith("payload/"):
                rel = rel[len("payload/"):]
            # security: no path traversal, no protected files
            norm = os.path.normpath(rel)
            if norm.startswith("..") or os.path.isabs(norm):
                return False, f"Package tried an unsafe path: {rel}"
            if norm in PROTECTED:
                continue  # silently skip - never overwrite config/data
            members.append((norm, pt.extractfile(member).read()))

    if not members:
        return False, "Package contains no installable files."

    written = []
    try:
        for rel, data in members:
            dest = os.path.join(config.BASE_DIR, rel)
            # verify hash matches manifest
            want = manifest["files"].get("payload/" + rel) or \
                   manifest["files"].get(rel)
            if want and hashlib.sha256(data).hexdigest() != want:
                raise ValueError(f"Hash mismatch for {rel}")
            # backup existing file
            if os.path.exists(dest):
                bpath = os.path.join(backup, rel)
                os.makedirs(os.path.dirname(bpath), exist_ok=True)
                shutil.copy2(dest, bpath)
            else:
                # record that this file was newly created (for rollback delete)
                written.append((dest, True))
                continue
            written.append((dest, False))
        # second pass: actually write
        for rel, data in members:
            dest = os.path.join(config.BASE_DIR, rel)
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with open(dest, "wb") as f:
                f.write(data)
        # write manifest record of this update
        with open(os.path.join(backup, "applied_manifest.json"), "w") as f:
            json.dump({k: manifest[k] for k in
                       ("version", "min_version", "built", "notes")}, f, indent=2)
        # refresh in-process version (VERSION file was just replaced)
        try:
            config.APP_VERSION = config._read_version()
        except Exception:
            pass
        return True, (f"Updated to version {manifest['version']}. "
                      f"Backup saved. Restart the service to load the new code.")
    except Exception as e:
        # rollback
        for dest, was_new in written:
            try:
                if was_new:
                    if os.path.exists(dest):
                        os.remove(dest)
                else:
                    rel = os.path.relpath(dest, config.BASE_DIR)
                    bpath = os.path.join(backup, rel)
                    if os.path.exists(bpath):
                        shutil.copy2(bpath, dest)
            except Exception:
                pass
        return False, f"Update failed and was rolled back: {e}"


def list_backups():
    if not os.path.isdir(UPDATE_DIR):
        return []
    out = []
    for d in sorted(os.listdir(UPDATE_DIR), reverse=True):
        p = os.path.join(UPDATE_DIR, d, "applied_manifest.json")
        if os.path.exists(p):
            try:
                info = json.load(open(p))
                out.append({"dir": d, "version": info.get("version", "?"),
                            "built": info.get("built", ""),
                            "notes": info.get("notes", "")})
            except Exception:
                pass
    return out
