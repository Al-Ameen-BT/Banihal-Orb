"""
BT Proxy - SSL certificate management.
Self-signed generation and import of purchased/CA-issued certificates, with
validation, inspection and backup. The GUI serves HTTPS from:
    config.SSL_CERT  (certs/server.crt)
    config.SSL_KEY   (certs/server.key)
"""
import datetime

import ipaddress
import os
import shutil

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.serialization import (Encoding,
                                                          NoEncryption,
                                                          PrivateFormat)
from cryptography.x509.oid import ExtensionOID, NameOID

import config

CERT_DIR = os.path.dirname(config.SSL_CERT)
BACKUP_DIR = os.path.join(config.BASE_DIR, "certs", "backup")


def _ensure_dir():
    os.makedirs(CERT_DIR, exist_ok=True)


def _write(path, data, mode):
    old = os.umask(0o077)
    try:
        with open(path, "wb") as f:
            f.write(data)
        os.chmod(path, mode)
    finally:
        os.umask(old)


def _not_after(cert):
    try:
        return cert.not_valid_after_utc.replace(tzinfo=None)
    except AttributeError:
        return cert.not_valid_after


def _not_before(cert):
    try:
        return cert.not_valid_before_utc.replace(tzinfo=None)
    except AttributeError:
        return cert.not_valid_before


def _san_entry(value):
    value = value.strip()
    try:
        return x509.IPAddress(ipaddress.ip_address(value))
    except ValueError:
        return x509.DNSName(value)


def generate_self_signed(common_name, sans, years):
    """Create a self-signed cert+key. sans is a list of hostnames/IPs.
    Returns (cert_pem, key_pem)."""
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, common_name)])

    san_values = list(dict.fromkeys([common_name] + [s for s in sans if s.strip()]))
    san = x509.SubjectAlternativeName([_san_entry(v) for v in san_values])

    now = datetime.datetime.utcnow()
    cert = (x509.CertificateBuilder()
            .subject_name(name)
            .issuer_name(name)
            .public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - datetime.timedelta(minutes=5))
            .not_valid_after(now + datetime.timedelta(days=365 * int(years)))
            .add_extension(san, critical=False)
            .add_extension(x509.BasicConstraints(ca=False, path_length=None),
                           critical=True)
            .sign(key, hashes.SHA256()))

    cert_pem = cert.public_bytes(Encoding.PEM)
    key_pem = key.private_bytes(Encoding.PEM, PrivateFormat.TraditionalOpenSSL,
                                NoEncryption())
    return cert_pem, key_pem


def _load_cert(cert_pem):
    return x509.load_pem_x509_certificate(cert_pem)


def _load_key(key_pem, passphrase=None):
    return serialization.load_pem_private_key(
        key_pem, password=passphrase.encode() if passphrase else None)


def validate_pair(cert_pem, key_pem, passphrase=None):
    """Validate a cert+key before installing. Returns (ok, messages, warnings).
    Raises nothing - all problems come back as messages."""
    errors, warnings = [], []
    try:
        cert = _load_cert(cert_pem)
    except Exception as e:
        return False, [f"Certificate is not valid PEM: {e}"], []
    try:
        key = _load_key(key_pem, passphrase)
    except TypeError:
        return False, ["The private key is encrypted - provide its passphrase."], []
    except Exception as e:
        return False, [f"Private key is not valid PEM: {e}"], []

    # key must match cert
    cert_pub = cert.public_key().public_bytes(
        Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
    key_pub = key.public_key().public_bytes(
        Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
    if cert_pub != key_pub:
        errors.append("The private key does NOT match the certificate.")

    now = datetime.datetime.utcnow()
    if _not_after(cert) < now:
        errors.append(f"Certificate expired on {cert.not_valid_after:%Y-%m-%d}.")
    if _not_before(cert) > now:
        warnings.append(f"Certificate is not valid until "
                        f"{cert.not_valid_before:%Y-%m-%d}.")
    days = (_not_after(cert) - now).days
    if 0 <= days <= 30:
        warnings.append(f"Certificate expires in {days} day(s).")

    return (not errors), errors, warnings


def build_chain(cert_pem, bundle_pem=None):
    """Return leaf-first PEM chain (leaf + intermediates)."""
    chain = cert_pem.strip()
    if bundle_pem and bundle_pem.strip():
        chain += b"\n" + bundle_pem.strip()
    return chain + b"\n"


def _backup_current():
    if os.path.exists(config.SSL_CERT) or os.path.exists(config.SSL_KEY):
        ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        dest = os.path.join(BACKUP_DIR, ts)
        os.makedirs(dest, exist_ok=True)
        for src in (config.SSL_CERT, config.SSL_KEY):
            if os.path.exists(src):
                shutil.copy2(src, os.path.join(dest, os.path.basename(src)))
        return dest
    return None


def install(cert_chain_pem, key_pem, passphrase=None):
    """Validate then write the cert/key, backing up the previous pair.
    If the key was passphrase-protected it is stored decrypted (gunicorn
    cannot prompt at startup). Returns (ok, message)."""
    ok, errors, _ = validate_pair(cert_chain_pem, key_pem, passphrase)
    if not ok:
        return False, " ".join(errors)
    _ensure_dir()
    _backup_current()
    # normalise key to unencrypted PEM
    key = _load_key(key_pem, passphrase)
    key_out = key.private_bytes(Encoding.PEM, PrivateFormat.TraditionalOpenSSL,
                                NoEncryption())
    _write(config.SSL_CERT, cert_chain_pem, 0o644)
    _write(config.SSL_KEY, key_out, 0o600)
    return True, "Certificate installed."


def generate_csr(common_name, sans, org="", locality="", state="",
                 country="", email=""):
    """Generate a key + CSR. Key is written to certs/pending.key; CSR PEM
    is returned for the customer to submit to a CA."""
    _ensure_dir()
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    attrs = [x509.NameAttribute(NameOID.COMMON_NAME, common_name)]
    if org:
        attrs.append(x509.NameAttribute(NameOID.ORGANIZATION_NAME, org))
    if locality:
        attrs.append(x509.NameAttribute(NameOID.LOCALITY_NAME, locality))
    if state:
        attrs.append(x509.NameAttribute(NameOID.STATE_OR_PROVINCE_NAME, state))
    if country:
        attrs.append(x509.NameAttribute(NameOID.COUNTRY_NAME, country[:2].upper()))
    if email:
        attrs.append(x509.NameAttribute(NameOID.EMAIL_ADDRESS, email))

    san_values = list(dict.fromkeys([common_name] + [s for s in sans if s.strip()]))
    builder = (x509.CertificateSigningRequestBuilder()
               .subject_name(x509.Name(attrs))
               .add_extension(x509.SubjectAlternativeName(
                   [_san_entry(v) for v in san_values]), critical=False))
    csr = builder.sign(key, hashes.SHA256())

    key_pem = key.private_bytes(Encoding.PEM, PrivateFormat.TraditionalOpenSSL,
                                NoEncryption())
    _write(os.path.join(CERT_DIR, "pending.key"), key_pem, 0o600)
    return csr.public_bytes(Encoding.PEM)


def pending_key():
    p = os.path.join(CERT_DIR, "pending.key")
    return open(p, "rb").read() if os.path.exists(p) else None


def inspect_current():
    """Summarise the installed certificate for display. Returns dict or None."""
    if not os.path.exists(config.SSL_CERT):
        return None
    try:
        cert = _load_cert(open(config.SSL_CERT, "rb").read())
    except Exception:
        return None
    try:
        cn = cert.subject.get_attributes_for_oid(NameOID.COMMON_NAME)[0].value
    except IndexError:
        cn = "(none)"
    try:
        issuer = cert.issuer.get_attributes_for_oid(NameOID.COMMON_NAME)[0].value
    except IndexError:
        issuer = "(unknown)"
    sans = []
    try:
        ext = cert.extensions.get_extension_for_oid(
            ExtensionOID.SUBJECT_ALTERNATIVE_NAME)
        for g in ext.value:
            sans.append(g.value if isinstance(g.value, str) else str(g.value))
    except x509.ExtensionNotFound:
        pass
    now = datetime.datetime.utcnow()
    days = (_not_after(cert) - now).days
    self_signed = (cert.issuer == cert.subject)
    return {
        "cn": cn,
        "issuer": issuer,
        "sans": sans,
        "not_before": _not_before(cert).strftime("%Y-%m-%d"),
        "not_after": _not_after(cert).strftime("%Y-%m-%d"),
        "days_left": days,
        "expired": days < 0,
        "self_signed": self_signed,
        "type": "Self-signed" if self_signed else "CA-issued",
    }


def restore_backup(name=None):
    """Restore the most recent (or named) backup. Returns (ok, message)."""
    if not os.path.isdir(BACKUP_DIR):
        return False, "No backups exist."
    names = sorted(os.listdir(BACKUP_DIR), reverse=True)
    if not names:
        return False, "No backups exist."
    pick = name or names[0]
    src = os.path.join(BACKUP_DIR, pick)
    if not os.path.isdir(src):
        return False, f"Backup {pick} not found."
    for base, mode in ((os.path.basename(config.SSL_CERT), 0o644),
                       (os.path.basename(config.SSL_KEY), 0o600)):
        p = os.path.join(src, base)
        if os.path.exists(p):
            _write(os.path.join(CERT_DIR, base), open(p, "rb").read(), mode)
    return True, f"Restored certificate from backup {pick}."


def list_backups():
    if not os.path.isdir(BACKUP_DIR):
        return []
    return sorted(os.listdir(BACKUP_DIR), reverse=True)
