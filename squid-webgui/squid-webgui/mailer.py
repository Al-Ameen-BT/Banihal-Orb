"""
BT Proxy - SMTP email alerting.

Sends operational and security alerts, and delivers scheduled configuration
backups. Designed for bank networks:

  * The SMTP password is stored ENCRYPTED (crypto_util / secret.key), never in
    plaintext in settings.json.
  * TLS (STARTTLS) or implicit SSL supported; certificate verification is on by
    default and can only be relaxed deliberately.
  * Sending is best-effort and MUST never break the request that triggered it -
    every send is wrapped and failures are logged, not raised.
  * No alert content includes passwords, license keys, or session tokens.
"""
import mimetypes
import os
import re
import smtplib
import socket
import ssl as _ssl
import threading
from email.message import EmailMessage
from email.utils import formatdate

import crypto_util

DEFAULTS = {
    "smtp_enabled": False,
    "smtp_host": "",
    "smtp_port": 587,
    "smtp_security": "starttls",     # starttls | ssl | none
    "smtp_verify_cert": True,
    "smtp_user": "",
    "smtp_password": "",             # stored encrypted
    "smtp_from": "",
    "smtp_to": "",                   # comma/space separated recipients
    "smtp_timeout": 15,
    # which events raise an email
    "alert_login_fail": True,        # brute force / lockout
    "alert_config_change": False,    # access list / network rule edits
    "alert_service": True,           # squid/service restart failures
    "alert_license": True,           # license expiry / tamper
    "alert_cert": True,              # certificate expiring
}

# Events that are ALWAYS security-critical and mailed when SMTP is on.
CRITICAL = {"login-locked", "license-tamper", "cert-expiring", "factory-reset"}


def settings_with_defaults(s):
    out = dict(DEFAULTS)
    out.update({k: v for k, v in s.items() if k in DEFAULTS})
    return out


def recipients(cfg):
    raw = (cfg.get("smtp_to") or "").replace(",", " ").split()
    return [r for r in raw if "@" in r]


def is_configured(s):
    c = settings_with_defaults(s)
    return bool(c["smtp_enabled"] and c["smtp_host"] and c["smtp_from"]
                and recipients(c))


def normalize_host(raw):
    """Clean an operator-entered SMTP host.

    Accepts pasted values like ' smtp.gmail.com ', 'smtp://smtp.gmail.com',
    'https://smtp.gmail.com/' or 'smtp.gmail.com:587' and returns
    (host, port_or_None). A hostname is never a URL - failing to strip this
    produces a DNS 'Name or service not known' that looks like a network fault.
    """
    h = (raw or "").strip()
    h = re.sub(r"^[a-zA-Z][a-zA-Z0-9+.-]*://", "", h)   # scheme
    h = h.split("/", 1)[0]                              # any path
    h = h.strip().strip(".")
    port = None
    # host:port  (but not a bare IPv6 literal)
    if ":" in h and h.count(":") == 1:
        left, right = h.split(":", 1)
        if right.isdigit():
            h, port = left, int(right)
    return h, port


def explain_auth_error(e):
    """Turn an SMTPAuthenticationError into something actionable."""
    raw = e.smtp_error
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8", "replace")
    raw = " ".join(str(raw).split())
    msg = f"SMTP authentication failed ({e.smtp_code}): {raw}"
    low = raw.lower()
    if "application-specific password" in low:
        hint = ("this account has 2-step verification - an App Password is "
                "required, not the account password")
    elif "badcredentials" in low or "not accepted" in low:
        hint = ("check the username is the FULL email address, and that the "
                "16-character App Password was entered with NO spaces")
    elif "disabled" in low or "not enabled" in low:
        hint = ("the mail provider has disabled password logins for this "
                "account - use an internal relay or an allowed method")
    else:
        hint = "check the username and password"
    return f"{msg} - {hint}."


def _connect(c):
    """Open an SMTP connection per the configured security mode."""
    host, port = c["smtp_host"], int(c["smtp_port"])
    timeout = int(c["smtp_timeout"])
    if c["smtp_security"] == "ssl":
        ctx = _ssl.create_default_context()
        if not c["smtp_verify_cert"]:
            ctx.check_hostname = False
            ctx.verify_mode = _ssl.CERT_NONE
        srv = smtplib.SMTP_SSL(host, port, timeout=timeout, context=ctx)
    else:
        srv = smtplib.SMTP(host, port, timeout=timeout)
        if c["smtp_security"] == "starttls":
            ctx = _ssl.create_default_context()
            if not c["smtp_verify_cert"]:
                ctx.check_hostname = False
                ctx.verify_mode = _ssl.CERT_NONE
            srv.starttls(context=ctx)
    pw = crypto_util.decrypt(c.get("smtp_password", ""))
    if c["smtp_user"] and pw:
        srv.login(c["smtp_user"], pw)
    return srv


def _build(c, subject, body, attachment=None):
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = c["smtp_from"]
    msg["To"] = ", ".join(recipients(c))
    msg["Date"] = formatdate(localtime=True)
    msg.set_content(body)
    if attachment:
        path, name = attachment
        ctype, _ = mimetypes.guess_type(name)
        maintype, subtype = (ctype or "application/octet-stream").split("/", 1)
        with open(path, "rb") as f:
            msg.add_attachment(f.read(), maintype=maintype, subtype=subtype,
                               filename=name)
    return msg


def send(settings, subject, body, attachment=None):
    """Send an email. Returns (ok, message). Never raises."""
    c = settings_with_defaults(settings)
    if not is_configured(settings):
        return False, "SMTP is not configured."
    try:
        srv = _connect(c)
        try:
            srv.send_message(_build(c, subject, body, attachment))
        finally:
            try:
                srv.quit()
            except Exception:
                pass
        return True, "Sent."
    except smtplib.SMTPAuthenticationError as e:
        return False, explain_auth_error(e)
    except smtplib.SMTPException as e:
        return False, f"SMTP error: {e}"
    except socket.gaierror as e:
        return False, (f"Cannot resolve the mail server name "
                       f"'{c['smtp_host']}' ({e}) - check the hostname is "
                       f"correct (no http:// or port) and that this server's "
                       f"DNS can resolve it.")
    except OSError as e:
        return False, (f"Resolved '{c['smtp_host']}' but could not connect on "
                       f"port {c['smtp_port']} ({e}) - check the port, the "
                       f"security mode, and any firewall between here and the "
                       f"mail server.")
    except Exception as e:                       # never propagate
        return False, f"Mail failed: {e}"


def send_async(settings, subject, body, attachment=None, on_done=None):
    """Fire-and-forget send on a worker thread so a slow mail server can never
    stall a web request."""
    def _run():
        ok, msg = send(settings, subject, body, attachment)
        if on_done:
            try:
                on_done(ok, msg)
            except Exception:
                pass
    t = threading.Thread(target=_run, daemon=True)
    t.start()
    return t


def should_alert(settings, action):
    """Decide whether an audit action warrants an email."""
    c = settings_with_defaults(settings)
    if not c["smtp_enabled"]:
        return False
    if action in CRITICAL:
        return True
    if action in ("login-fail",) and c["alert_login_fail"]:
        return False          # single failures are noise; lockout is critical
    if action.startswith(("branch-", "network-", "acl-", "depfind-approve")) \
            and c["alert_config_change"]:
        return True
    if action.startswith(("squid-restart", "service-")) and c["alert_service"]:
        return "FAILED" in action or False
    if action.startswith("license-") and c["alert_license"]:
        return True
    if action.startswith("cert-") and c["alert_cert"]:
        return True
    return False


def alert_body(host, action, detail, username, when):
    """Plain-text alert body. Deliberately contains no secrets."""
    return (
        f"BT Proxy alert\n"
        f"{'-' * 50}\n"
        f"Server : {host}\n"
        f"Time   : {when}\n"
        f"User   : {username}\n"
        f"Event  : {action}\n"
        f"Detail : {detail}\n"
        f"{'-' * 50}\n"
        f"This is an automated message from the BT Proxy management console.\n"
    )
