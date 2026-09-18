"""
BT Proxy - encryption helper for secrets stored in settings.json
(currently the Active Directory bind password).

A random key is generated once at secret.key (mode 600, owned by the service
user). Losing it only means re-entering the AD bind password.
"""
import base64
import os

from cryptography.fernet import Fernet, InvalidToken

import config

KEY_PATH = os.path.join(config.BASE_DIR, "secret.key")
PREFIX = "enc:"


def _fernet():
    if not os.path.exists(KEY_PATH):
        key = Fernet.generate_key()
        old = os.umask(0o077)
        try:
            with open(KEY_PATH, "wb") as f:
                f.write(key)
        finally:
            os.umask(old)
    else:
        key = open(KEY_PATH, "rb").read().strip()
    try:
        os.chmod(KEY_PATH, 0o600)
    except OSError:
        pass
    return Fernet(key)


def encrypt(plaintext):
    """Encrypt a string for storage. Empty input stays empty."""
    if not plaintext:
        return ""
    return PREFIX + _fernet().encrypt(plaintext.encode()).decode()


def decrypt(stored):
    """Decrypt a value produced by encrypt(). Plain values pass through
    unchanged so an admin can hand-edit settings.json in an emergency."""
    if not stored:
        return ""
    if not stored.startswith(PREFIX):
        return stored
    try:
        return _fernet().decrypt(stored[len(PREFIX):].encode()).decode()
    except (InvalidToken, ValueError, base64.binascii.Error):
        return ""
