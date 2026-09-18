"""
Gunicorn configuration - reads everything from _cfg.py so the port and
SSL settings live in ONE place. Used by the systemd unit:
    gunicorn -c gunicorn_conf.py app:app
"""
import os
import config as _cfg

bind = f"{_cfg.LISTEN_HOST}:{_cfg.LISTEN_PORT}"
workers = 2
timeout = 60
# gunicorn needs a writable HOME; systemd sets it, this is a fallback
os.environ.setdefault("HOME", _cfg.BASE_DIR)

def _ssl_enabled():
    try:
        import json
        s = json.load(open(_cfg.SETTINGS_FILE))
        if "ssl_enabled" in s:
            return bool(s["ssl_enabled"])
    except Exception:
        pass
    return _cfg.SSL_ENABLED


if _ssl_enabled():
    if not (os.path.exists(_cfg.SSL_CERT) and os.path.exists(_cfg.SSL_KEY)):
        raise SystemExit(
            f"SSL_ENABLED is True but cert/key not found:\n"
            f"  {_cfg.SSL_CERT}\n  {_cfg.SSL_KEY}\n"
            f"Create them (see README 'SSL' section) or set SSL_ENABLED = False.")
    certfile = _cfg.SSL_CERT
    keyfile = _cfg.SSL_KEY
