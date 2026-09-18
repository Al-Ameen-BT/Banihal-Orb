"""
BT Proxy - optional Active Directory (LDAP) authentication for GUI login.

Design rules:
  * AD is OPTIONAL. Local accounts always work, even when AD is disabled,
    misconfigured, or every domain controller is unreachable. The console
    that controls a bank's internet must never be lockable by a DC reboot.
  * Local accounts are checked FIRST. A username that exists locally never
    reaches the directory.
  * The caller must apply the login rate-limit BEFORE calling authenticate(),
    so a brute-force attempt against BT Proxy cannot lock the user's real
    domain account.
  * A directory that is unreachable is reported differently from a wrong
    password - conflating the two wastes hours during an incident.
  * MFA is unaffected: AD verifies the password, BT Proxy then verifies the
    TOTP code from its own database.

Returned status values from authenticate():
    "ok"          - credentials valid, role resolved
    "bad_creds"   - directory answered: wrong username or password
    "no_group"    - credentials valid but user is in no mapped role group
    "unreachable" - no domain controller answered (fall back to local)
    "disabled"    - AD integration is switched off
    "misconfig"   - settings incomplete
"""
import ssl as _ssl

import crypto_util

try:
    from ldap3 import ALL, Connection, NTLM, SIMPLE, Server, Tls
    from ldap3.core.exceptions import (LDAPBindError, LDAPException,
                                       LDAPSocketOpenError)
    HAVE_LDAP3 = True
except ImportError:                                    # pragma: no cover
    HAVE_LDAP3 = False

ROLES = ("admin", "operator", "viewer")
DEFAULTS = {
    "ad_enabled": False,
    "ad_host1": "",
    "ad_host2": "",
    "ad_port": 636,
    "ad_use_ssl": True,
    "ad_security": "ldaps",     # ldaps (636) | starttls (389) | none (389)
    "ad_verify_cert": True,
    "ad_ca_file": "",           # optional PEM for the domain CA
    "ad_domain": "",            # e.g. bank.local  -> user@bank.local
    "ad_base_dn": "",           # e.g. DC=bank,DC=local
    "ad_bind_user": "",         # read-only service account (UPN or DN)
    "ad_bind_password": "",     # stored encrypted
    "ad_group_admin": "",
    "ad_group_operator": "",
    "ad_group_viewer": "",
    "ad_timeout": 5,
}


def settings_with_defaults(s):
    out = dict(DEFAULTS)
    out.update({k: v for k, v in s.items() if k in DEFAULTS})
    return out


def is_configured(s):
    c = settings_with_defaults(s)
    return bool(c["ad_enabled"] and c["ad_host1"] and c["ad_base_dn"]
                and c["ad_domain"]
                and any(c[f"ad_group_{r}"] for r in ROLES))


def _tls(c):
    use_ssl, start_tls, _ = _security(c)
    if not (use_ssl or start_tls):
        return None
    validate = _ssl.CERT_REQUIRED if c["ad_verify_cert"] else _ssl.CERT_NONE
    kwargs = {"validate": validate}
    if c["ad_ca_file"]:
        kwargs["ca_certs_file"] = c["ad_ca_file"]
    return Tls(**kwargs)


def _servers(c):
    tls = _tls(c)
    use_ssl, _, port = _security(c)
    out = []
    for host in (c["ad_host1"], c["ad_host2"]):
        if host:
            out.append(Server(host, port=port,
                              use_ssl=use_ssl, tls=tls,
                              get_info=ALL, connect_timeout=int(c["ad_timeout"])))
    return out


def _security(c):
    """Effective (use_ssl, start_tls, port) from ad_security, with back-compat.

    Older configs only had ad_use_ssl (LDAPS on/off). If ad_security is absent,
    fall back to that so an upgrade never changes a working connection.
    """
    mode = (c.get("ad_security") or "").lower()
    if not mode:
        mode = "ldaps" if c.get("ad_use_ssl", True) else "none"
    if mode == "ldaps":
        return True, False, int(c.get("ad_port") or 636)
    if mode == "starttls":
        return False, True, int(c.get("ad_port") or 389)
    return False, False, int(c.get("ad_port") or 389)


def _connect(server, user, password, c):
    _, start_tls, _ = _security(c)
    conn = Connection(server, user=user, password=password,
                      authentication=SIMPLE, auto_bind=False,
                      receive_timeout=int(c["ad_timeout"]))
    if start_tls:
        conn.open()
        conn.start_tls()        # upgrade the plaintext 389 socket to TLS
    if not conn.bind():
        raise LDAPBindError(conn.result.get("description", "bind failed"))
    return conn


def _role_from_groups(groups, c):
    """Most privileged matching group wins."""
    lowered = {g.lower() for g in groups}
    for role in ROLES:                       # admin, operator, viewer
        want = c[f"ad_group_{role}"].strip().lower()
        if want and want in lowered:
            return role
    return None


def _member_of(conn, username, c):
    """Return (dn, sam, group_dns) for a user.

    'sam' is the sAMAccountName exactly as AD stores it - the canonical, unique
    login name. We key BT Proxy's account on this so 'tbt001' and
    'tbt001@domain' (and any casing) resolve to ONE account, and MFA enrolled on
    one form applies to all of them.
    """
    conn.search(c["ad_base_dn"],
                f"(&(objectClass=user)(sAMAccountName={_escape(username)}))",
                attributes=["memberOf", "distinguishedName", "displayName",
                            "sAMAccountName"])
    if not conn.entries:
        return None, None, []
    entry = conn.entries[0]
    dn = str(entry.distinguishedName)
    sam = str(entry.sAMAccountName) if "sAMAccountName" in entry else username
    groups = [str(g) for g in entry.memberOf] if "memberOf" in entry else []
    # nested groups: LDAP_MATCHING_RULE_IN_CHAIN
    try:
        conn.search(c["ad_base_dn"],
                    f"(member:1.2.840.113556.1.4.1941:={dn})",
                    attributes=["distinguishedName"])
        groups += [str(e.distinguishedName) for e in conn.entries]
    except LDAPException:
        pass
    return dn, sam, groups


def _escape(v):
    for ch, rep in (("\\", r"\5c"), ("*", r"\2a"), ("(", r"\28"),
                    (")", r"\29"), ("\x00", r"\00")):
        v = v.replace(ch, rep)
    return v


def authenticate(username, password, settings):
    """Verify credentials against AD and resolve a BT Proxy role.

    Returns (status, role, message, canonical_username). canonical_username is
    the AD sAMAccountName when status == 'ok' (else None), so the caller keys the
    account on one stable name regardless of which login form was typed.
    """
    if not HAVE_LDAP3:
        return "misconfig", None, "ldap3 library is not installed on the server.", None
    c = settings_with_defaults(settings)
    if not c["ad_enabled"]:
        return "disabled", None, "", None
    if not is_configured(settings):
        return "misconfig", None, ("Active Directory settings are incomplete "
                                   "(host, domain, base DN and at least one "
                                   "group are required).", None)
    if not password:
        return "bad_creds", None, "", None

    c["ad_bind_password"] = crypto_util.decrypt(c["ad_bind_password"])
    upn = username if "@" in username else f"{username}@{c['ad_domain']}"

    reachable = False
    for server in _servers(c):
        try:
            user_conn = _connect(server, upn, password, c)
        except LDAPSocketOpenError:
            continue                       # try the next DC
        except LDAPBindError:
            reachable = True               # DC answered: credentials are wrong
            continue
        except LDAPException as e:
            reachable = True
            return "unreachable", None, f"Directory error: {e}", None

        reachable = True
        try:
            # Group lookup: use the service account if configured, else the
            # user's own (authenticated) connection.
            if c["ad_bind_user"] and c["ad_bind_password"]:
                try:
                    lookup = _connect(server, c["ad_bind_user"],
                                      c["ad_bind_password"], c)
                except LDAPException:
                    lookup = user_conn     # fall back to the user's connection
            else:
                lookup = user_conn
            dn, sam, groups = _member_of(lookup, username.split("@")[0], c)
            if dn is None:
                return "bad_creds", None, "User not found in the directory.", None
            role = _role_from_groups(groups, c)
            if not role:
                return "no_group", None, ("Your account is not a member of any "
                                          "BT Proxy access group.", None)[0], None
            # canonical login name = AD sAMAccountName, lowercased for a stable key
            return "ok", role, "", (sam or username.split("@")[0]).lower()
        finally:
            try:
                user_conn.unbind()
            except Exception:
                pass

    if reachable:
        return "bad_creds", None, "", None
    return "unreachable", None, ("No domain controller responded. Sign in with "
                                 "a local account."), None


def _diagnose_socket_error(c, host, err):
    """Turn a raw LDAPSocketOpenError into an actionable hint.

    The most confusing case: TCP connects but the TLS handshake is reset
    ('Connection reset by peer' during ssl wrapping). That is not a network
    block - it means the DC is answering on the port but will not complete
    LDAPS, almost always because it has no server-auth certificate installed,
    or because the client is talking LDAPS to a plain-LDAP port (or vice versa).
    """
    text = str(err).lower()
    use_ssl, start_tls, port = _security(c)
    secure = use_ssl or start_tls
    tls_reset = ("ssl" in text or "wrap" in text) and \
                ("reset" in text or "eof" in text or "handshake" in text
                 or "unexpected" in text)
    if secure and tls_reset:
        return (f"{host}: reached port {port} but the TLS/LDAPS handshake was "
                f"refused. The domain controller usually needs a server "
                f"certificate for LDAPS, or you are using LDAPS against a "
                f"plain-LDAP port. Check: `openssl s_client -connect "
                f"{host}:{port}`. If that also fails, LDAPS is not being served "
                f"- either install a DC certificate, or switch this connection "
                f"to StartTLS on port 389.")
    if "reset" in text or "refused" in text:
        return (f"{host}: connection to port {port} was refused/reset. Check "
                f"the port is correct ({port}) and reachable: "
                f"`nc -vz {host} {port}`.")
    if "timed out" in text or "timeout" in text:
        return (f"{host}: no response from port {port} before timeout - a "
                f"firewall is likely dropping the connection, or the host/port "
                f"is wrong.")
    if "name or service not known" in text or "getaddrinfo" in text:
        return (f"{host}: name could not be resolved - check the hostname and "
                f"this server's DNS.")
    return f"{host}: NOT reachable ({err})"


def _probe_port(host, port, timeout, want_tls):
    """Localise a failure using only the standard library.

    Returns 'closed' (TCP refused/timeout), 'tcp_only' (TCP opens but the TLS
    handshake fails - the LDAPS-with-no-cert case), or 'ok'. Works even when
    openssl is not installed on the proxy.
    """
    import socket
    try:
        sock = socket.create_connection((host, port), timeout=timeout)
    except OSError:
        return "closed"
    if not want_tls:
        sock.close()
        return "ok"
    try:
        ctx = _ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = _ssl.CERT_NONE
        with ctx.wrap_socket(sock, server_hostname=host) as ss:
            ss.version()
        return "ok"
    except (_ssl.SSLError, OSError):
        return "tcp_only"
    finally:
        try:
            sock.close()
        except OSError:
            pass


def test_connection(settings, test_user=None, test_password=None):
    """Used by the Settings 'Test' button. Returns (ok, list_of_lines)."""
    if not HAVE_LDAP3:
        return False, ["ldap3 library is not installed on the server."]
    c = settings_with_defaults(settings)
    lines = []
    if not c["ad_host1"]:
        return False, ["No domain controller configured."]
    c["ad_bind_password"] = crypto_util.decrypt(c["ad_bind_password"])

    any_up = False
    for host, server in zip((c["ad_host1"], c["ad_host2"]), _servers(c)):
        try:
            if c["ad_bind_user"] and c["ad_bind_password"]:
                conn = _connect(server, c["ad_bind_user"], c["ad_bind_password"], c)
                conn.unbind()
                lines.append(f"{host}: reachable, service account bind OK")
            else:
                _ussl, _stls, _port = _security(c)
                Server(host, port=_port, use_ssl=_ussl,
                       connect_timeout=int(c["ad_timeout"]))
                conn = Connection(server, receive_timeout=int(c["ad_timeout"]))
                conn.bind()
                conn.unbind()
                lines.append(f"{host}: reachable (anonymous check)")
            any_up = True
        except LDAPSocketOpenError as e:
            msg = _diagnose_socket_error(c, host, e)
            # Confirm which layer actually failed, with a direct probe.
            _ussl, _stls, _port = _security(c)
            probe = _probe_port(host, _port, int(c["ad_timeout"]),
                                _ussl or _stls)
            if probe == "tcp_only" and (_ussl or _stls):
                msg += (f"  [probe: port {c['ad_port']} accepts TCP but the TLS "
                        f"handshake fails - confirms LDAPS is not usable here]")
            elif probe == "closed":
                msg += (f"  [probe: port {_port} is not accepting "
                        f"connections at all]")
            lines.append(msg)
        except LDAPBindError:
            any_up = True
            lines.append(f"{host}: reachable, but the service account "
                         f"credentials were rejected")
        except LDAPException as e:
            lines.append(f"{host}: error - {e}")

    if not any_up:
        return False, lines
    _ussl, _stls, _ = _security(c)
    if not (_ussl or _stls):
        lines.append("WARNING: neither LDAPS nor StartTLS is enabled - "
                     "passwords cross the network unencrypted.")

    if test_user and test_password:
        status, role, msg, canon = authenticate(test_user, test_password, settings)
        if status == "ok":
            note = f" (account: {canon})" if canon else ""
            lines.append(f"Test login '{test_user}': SUCCESS - mapped to role "
                         f"'{role}'{note}")
        elif status == "no_group":
            lines.append(f"Test login '{test_user}': password OK, but no mapped "
                         f"group - check the group DNs")
            return False, lines
        else:
            lines.append(f"Test login '{test_user}': FAILED ({status}) "
                         f"{msg}".strip())
            return False, lines
    return True, lines
