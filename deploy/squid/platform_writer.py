"""Single managed-file writer, shared with the Squid WebUI process.

Install in the WebUI Python path. Managed mode must block its local mutations
and regeneration; see the integration patch and runbook beside this module.
"""
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
from cryptography.hazmat.primitives.serialization import load_pem_public_key
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

MANAGED_PATH = re.compile(r'^/etc/squid/acls/(webgui_generated\.conf|[A-Za-z0-9_-]{2,32}_(?:white|black)list\.txt)$')


def atomic_write(path, content, mode=0o640, uid=None, gid=None):
    fd, name = tempfile.mkstemp(prefix='.platform-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as output:
            if uid is not None or gid is not None:
                os.fchown(output.fileno(), -1 if uid is None else uid, -1 if gid is None else gid)
            os.fchmod(output.fileno(), mode)
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        os.replace(name, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def atomic_state(path, value):
    atomic_write(path, json.dumps(value, separators=(',', ':')).encode(), 0o600)


def validate_bundle(bundle, public_key, proxy_id):
    if bundle.get('protocol') != 2 or bundle.get('proxyId') != proxy_id:
        raise ValueError('Bundle belongs to a different proxy or protocol')
    if type(bundle.get('seq')) is not int or bundle['seq'] < 0 or bundle.get('collection') != 'squid-conf':
        raise ValueError('Invalid bundle identity')
    files = bundle.get('files')
    if not isinstance(files, list) or not 1 <= len(files) <= 200:
        raise ValueError('Invalid bundle file count')
    seen = set()
    for file in files:
        if not isinstance(file, dict) or set(file) != {'path', 'content'} or not isinstance(file['content'], str):
            raise ValueError('Invalid bundle file')
        if not isinstance(file['path'], str) or not MANAGED_PATH.fullmatch(file['path']) or file['path'] in seen:
            raise ValueError('Invalid managed path')
        seen.add(file['path'])
    if '/etc/squid/acls/webgui_generated.conf' not in seen:
        raise ValueError('Generated include is required')
    canonical = json.dumps({'protocol': 2, 'proxyId': proxy_id, 'seq': bundle['seq'], 'files': files}, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode()
    if len(canonical) > 1_000_000:
        raise ValueError('Bundle too large')
    key = load_pem_public_key(Path(public_key).read_bytes())
    if not isinstance(key, Ed25519PublicKey):
        raise ValueError('Ed25519 platform key is required')
    key.verify(base64.b64decode(bundle['signature'], validate=True), canonical)
    return hashlib.sha256(canonical).hexdigest()


def _run(command):
    result = subprocess.run(command, capture_output=True, timeout=30, check=False)
    if result.returncode:
        raise RuntimeError('Squid validation, reload or health check failed')


def apply_bundle(bundle, config):
    digest = validate_bundle(bundle, config['bundle_public_key'], config['proxy_id'])
    state_dir = Path(config['state_dir'])
    state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    managed_dir = Path(config.get('managed_dir', '/etc/squid/acls'))
    if managed_dir.is_symlink() or managed_dir.resolve() != managed_dir.absolute():
        raise ValueError('Managed directory must not contain symlinks')
    state_path, journal_path = state_dir / 'applied.json', state_dir / 'apply-journal.json'
    parse = config.get('parse_cmd', ['/usr/sbin/squid', '-k', 'parse'])
    reload = config.get('reload_cmd', ['/usr/sbin/squid', '-k', 'reconfigure'])
    health = config.get('health_cmd', ['/usr/bin/systemctl', 'is-active', '--quiet', 'squid'])

    def destination(name):
        if not MANAGED_PATH.fullmatch('/etc/squid/acls/' + name):
            raise ValueError('Invalid journal path')
        path = managed_dir / name
        if path.is_symlink() or (path.exists() and not path.is_file()):
            raise ValueError('Managed target must be a regular file')
        return path

    def restore(journal):
        for name, old in journal['before'].items():
            path = destination(name)
            if old is None:
                path.unlink(missing_ok=True)
            else:
                atomic_write(path, base64.b64decode(old['content']), old['mode'], old['uid'], old['gid'])
        _run(parse)
        _run(reload)
        _run(health)
        journal_path.unlink()

    with open(state_dir / 'writer.lock', 'a', encoding='ascii') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        previous = json.loads(state_path.read_text()) if state_path.exists() else {'seq': -1}
        if journal_path.exists():
            journal = json.loads(journal_path.read_text())
            if previous.get('seq') == journal['seq'] and previous.get('digest') == journal['digest']:
                journal_path.unlink()
            else:
                restore(journal)
        if bundle['seq'] < previous['seq']:
            raise ValueError('Stale bundle')
        if bundle['seq'] == previous['seq']:
            if previous.get('digest') != digest:
                raise ValueError('Revision content changed')
            return {'seq': bundle['seq'], 'duplicate': True}
        if (state_dir / 'overload-paused').exists():
            raise RuntimeError('Local automation is paused')
        before = {}
        for file in bundle['files']:
            path = destination(Path(file['path']).name)
            before[path.name] = {'content': base64.b64encode(path.read_bytes()).decode(), 'mode': path.stat().st_mode & 0o777, 'uid': path.stat().st_uid, 'gid': path.stat().st_gid} if path.exists() else None
        journal = {'seq': bundle['seq'], 'digest': digest, 'before': before}
        atomic_state(journal_path, journal)
        try:
            for file in bundle['files']:
                path = destination(Path(file['path']).name)
                old = before[path.name]
                atomic_write(path, file['content'].encode(), old['mode'] if old else 0o640,
                             old['uid'] if old else os.geteuid(), old['gid'] if old else config.get('squid_gid', managed_dir.stat().st_gid))
            _run(parse)
            _run(reload)
            _run(health)
            atomic_state(state_path, {'seq': bundle['seq'], 'digest': digest})
            journal_path.unlink()
        except BaseException:
            try:
                restore(journal)
            except BaseException:
                (state_dir / 'overload-paused').touch(mode=0o600)
            raise
    return {'seq': bundle['seq'], 'duplicate': False}
