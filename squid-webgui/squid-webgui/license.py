"""
BT Proxy - license verification (client side).
Keys are signed with Ed25519 by Banihal Technologies LLP. This file contains
ONLY the public key: it can verify keys but mathematically cannot create
them, so nothing on a customer system allows forging a license.

Key format:  BTP2.<base32 payload>.<base32 signature>
"""
import base64
import json
from datetime import date

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

# Banihal Technologies LLP license-signing public key (Ed25519)
PUBLIC_KEY_HEX = "9c50443b9c5b2690c74be3736c9afac99c5e9590be1feb5422fe858ef94a3136"

TRIAL_DAYS = 30


def _b32d(s):
    pad = (8 - len(s) % 8) % 8
    return base64.b32decode(s + "=" * pad)


def verify_key(key):
    """Return {'c','i','e','y'} if the key is authentic, else None."""
    try:
        prefix, p_enc, s_enc = key.strip().split(".")
        if prefix != "BTP2":
            return None
        payload = _b32d(p_enc)
        sig = _b32d(s_enc)
        pub = Ed25519PublicKey.from_public_bytes(bytes.fromhex(PUBLIC_KEY_HEX))
        pub.verify(sig, payload)          # raises InvalidSignature if forged
        info = json.loads(payload)
        date.fromisoformat(info["e"])     # sanity
        return info
    except (InvalidSignature, Exception):
        return None
