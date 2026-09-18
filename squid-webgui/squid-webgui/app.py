#!/usr/bin/env python3
"""
Squid Web GUI
A web front-end for managing Squid whitelists/blacklists per branch,
viewing live access logs and active proxy sessions.

Features in this version:
  1. Login screen (SQLite-backed local accounts)
  2. User creation / password reset (admin role)
  3. Concurrent proxy session list (cache-manager, log fallback)
  4. Live access.log viewer with filters
  5. Branch-wise whitelist / blacklist display + add/remove URLs
"""
import csv as _csv
import glob
import gzip
import ipaddress
import json
import logging
import logging.handlers
import socket
import os
import fcntl
import secrets
import threading
import re
import subprocess
import sqlite3
import time
from collections import OrderedDict
from datetime import datetime, timedelta
from functools import wraps

import base64
import io as _io

import pyotp
import qrcode
import requests
from flask import (Flask, Response, abort, flash, g, jsonify, redirect,
                   render_template, request, send_file, session,
                   stream_with_context, url_for)
from werkzeug.security import check_password_hash, generate_password_hash

import config
import ad_auth
import backup_manager
import dr_sync
import cert_manager
import dep_classify
import dep_finder
import crypto_util
import license as lic
import mailer
import scheduler
import update_engine

app = Flask(__name__)
app.secret_key = config.SECRET_KEY
app.permanent_session_lifetime = timedelta(hours=config.SESSION_HOURS)

DOMAIN_RE = re.compile(r"^\.?([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$")
BRANCH_RE = re.compile(r"^[A-Za-z0-9_-]{2,32}$")

# Prefix reserved for machine-generated companion ACL files. Operator-owned
# files and access-rule names must never use it: a rule called 'gen_ho' would
# own the file gen_ho_whitelist.txt, which is exactly the companion file the
# 'ho' rule rewrites on every Apply.
GEN_PREFIX = "gen_"

# Bulk list import limits. A whitelist is a security control: an unbounded
# upload should not be able to exhaust memory, fill the disk, or bury a
# malicious entry in 100k lines nobody will read.
BULK_MAX_BYTES = 1024 * 1024        # 1 MB of text
BULK_MAX_ENTRIES = 5000

# --------------------------------------------------------------------------- db
def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(config.DB_PATH)
        g.db.row_factory = sqlite3.Row
    return g.db


@app.teardown_appcontext
def close_db(exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    db = sqlite3.connect(config.DB_PATH)
    db.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            pw_hash TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'viewer',
            must_change INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS login_fails (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts TEXT NOT NULL,
            username TEXT NOT NULL,
            ip TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS audit (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts TEXT NOT NULL,
            username TEXT NOT NULL,
            action TEXT NOT NULL,
            detail TEXT NOT NULL
        );
    """)
    db.executescript("""
        CREATE TABLE IF NOT EXISTS pw_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            pw_hash TEXT NOT NULL,
            ts TEXT NOT NULL
        );
    """)
    cols = [r[1] for r in db.execute("PRAGMA table_info(users)")]
    if "totp_secret" not in cols:
        db.execute("ALTER TABLE users ADD COLUMN totp_secret TEXT")
        db.execute("ALTER TABLE users ADD COLUMN mfa_enabled INTEGER NOT NULL DEFAULT 0")
    if "pw_changed_at" not in cols:
        db.execute("ALTER TABLE users ADD COLUMN pw_changed_at TEXT")
    if "is_ad" not in cols:
        db.execute("ALTER TABLE users ADD COLUMN is_ad INTEGER NOT NULL DEFAULT 0")
    cur = db.execute("SELECT COUNT(*) c FROM users")
    if cur.fetchone()[0] == 0:
        db.execute(
            "INSERT INTO users (username, pw_hash, role, must_change, created_at) "
            "VALUES (?,?,?,1,?)",
            (config.DEFAULT_ADMIN_USER,
             generate_password_hash(config.DEFAULT_ADMIN_PASS),
             "admin", datetime.now().isoformat(timespec="seconds")))
        print(f"[init] created default admin "
              f"'{config.DEFAULT_ADMIN_USER}' / '{config.DEFAULT_ADMIN_PASS}' "
              f"(password change forced on first login)")
    db.commit()
    db.close()
    try:
        os.chmod(config.DB_PATH, 0o600)
    except OSError:
        pass


_syslog = {"key": None, "logger": None}


def syslog_send(msg):
    """Forward one line to the configured syslog server. Never raises.

    Emits RFC3164 format: '<PRI>Mmm dd HH:MM:SS hostname btproxy[pid]: <msg>'.
    Python's SysLogHandler adds only the <PRI> priority, not the timestamp and
    hostname that follow it. Without those, a syslog collector's pre-decoder
    (e.g. Wazuh) cannot parse the line and the program tag never matches - the
    symptom is 'decoder configured but nothing decodes'. So we build the header
    into the formatter ourselves.
    """
    try:
        s = load_settings()
        if not s.get("syslog_enabled"):
            return
        key = (s.get("syslog_host", ""), int(s.get("syslog_port", 514) or 514),
               s.get("syslog_proto", "udp"))
        if not key[0]:
            return
        if _syslog["key"] != key or _syslog["logger"] is None:
            lg = logging.getLogger("btproxy_syslog")
            for h in list(lg.handlers):
                lg.removeHandler(h)
            st = socket.SOCK_STREAM if key[2] == "tcp" else socket.SOCK_DGRAM
            h = logging.handlers.SysLogHandler(
                address=(key[0], key[1]), socktype=st,
                facility=logging.handlers.SysLogHandler.LOG_LOCAL1)
            hostname = socket.gethostname().split(".")[0]
            pid = os.getpid()
            # RFC3164 header: 'Mmm dd HH:MM:SS hostname btproxy[pid]: message'.
            # The day is space-padded to two chars per the RFC (e.g. 'Aug  5').
            class _RFC3164(logging.Formatter):
                def format(self, record):
                    ts = datetime.now().strftime("%b %e %H:%M:%S")
                    return f"{ts} {hostname} btproxy[{pid}]: {record.getMessage()}"
            h.setFormatter(_RFC3164())
            lg.addHandler(h)
            lg.setLevel(logging.INFO)
            lg.propagate = False
            _syslog["key"] = key
            _syslog["logger"] = lg
        _syslog["logger"].info(msg)
    except Exception:
        pass


def audit_anon(action, detail):
    db = get_db()
    db.execute("INSERT INTO audit (ts, username, action, detail) VALUES (?,?,?,?)",
               (datetime.now().isoformat(timespec="seconds"), "-", action, detail))
    db.commit()
    syslog_send(f"user=- action={action} detail={detail}")
    maybe_email_alert(action, detail, "-")


def maybe_email_alert(action, detail, username="-"):
    """Fire an email alert if this event warrants one. Best-effort: never
    raises, never blocks the request (sent on a worker thread)."""
    try:
        s = load_settings()
        if not mailer.should_alert(s, action):
            return
        when = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        host = socket.gethostname()
        body = mailer.alert_body(host, action, detail, username, when)
        subject = f"[BT Proxy] {action} on {host}"
        mailer.send_async(s, subject, body)
    except Exception:
        pass          # alerting must never break the operation it reports


def audit(action, detail):
    db = get_db()
    db.execute("INSERT INTO audit (ts, username, action, detail) VALUES (?,?,?,?)",
               (datetime.now().isoformat(timespec="seconds"),
                session.get("username", "-"), action, detail))
    db.commit()
    syslog_send(f"user={session.get('username','-')} action={action} detail={detail}")
    maybe_email_alert(action, detail, session.get("username", "-"))
    _maybe_dr_push(action)


# Config-changing action prefixes that should replicate to the DR peer.
# DR-internal actions (dr-*) are excluded so a received sync never re-pushes
# (no replication loop), and read-only actions (login, report, depfind-search)
# are excluded as they change no config.
_DR_PUSH_PREFIXES = ("acl-", "branch-", "port-", "fullaccess-", "depfind-approve",
                     "deplist-", "settings", "user-")


def _maybe_dr_push(action):
    try:
        if action.startswith("dr-"):
            return
        if any(action.startswith(p) for p in _DR_PUSH_PREFIXES):
            dr_push(f"change:{action}")
    except Exception:
        pass


# --------------------------------------------------------------------- license
def _effective_today(s):
    """Anti-rollback: track the highest time ever seen; if the system clock
    is rolled back to extend a license, expiry math keeps using the
    high-water mark and the tampering is logged (Wazuh rule 110213)."""
    now = time.time()
    hw = float(s.get("time_highwater", 0))
    if now > hw + 3600:          # advance high-water mark hourly
        s["time_highwater"] = now
        try:
            save_settings(s)
        except OSError:
            pass
        return datetime.fromtimestamp(now).date()
    if now < hw - 86400:         # clock moved back more than a day
        last = float(s.get("tamper_logged_at", 0))
        if now - last > 3600 or last > now:   # log at most hourly
            s["tamper_logged_at"] = now
            try:
                save_settings(s)
            except OSError:
                pass
            audit_system("license-tamper",
                         f"system clock rollback detected: now="
                         f"{datetime.fromtimestamp(now):%Y-%m-%d %H:%M} but last seen "
                         f"{datetime.fromtimestamp(hw):%Y-%m-%d %H:%M}")
        return datetime.fromtimestamp(hw).date()
    return datetime.fromtimestamp(max(now, hw)).date()


def license_status():
    s = load_settings()
    if not s.get("install_date"):
        s["install_date"] = datetime.now().date().isoformat()
        try:
            save_settings(s)
        except OSError:
            pass
    key = s.get("license_key")
    today = _effective_today(s)
    if key:
        info = lic.verify_key(key)
        if info:
            exp = datetime.strptime(info["e"], "%Y-%m-%d").date()
            days = (exp - today).days
            return {"trial": False, "customer": info["c"], "issued": info["i"],
                    "expires": info["e"], "years": info.get("y"),
                    "days_left": days, "expired": days < 0}
    inst = datetime.strptime(s["install_date"], "%Y-%m-%d").date()
    exp = inst + timedelta(days=lic.TRIAL_DAYS)
    days = (exp - today).days
    return {"trial": True, "customer": "Trial", "issued": s["install_date"],
            "expires": exp.isoformat(), "years": None,
            "days_left": days, "expired": days < 0}


def license_ok():
    return not license_status()["expired"]


def config_license_required(fn):
    """Blocks Access List / Network Rule configuration when the license
    (or trial) has expired. Viewing, logs, sessions, reports stay available."""
    @wraps(fn)
    def wrapper(*a, **kw):
        if not license_ok():
            flash("License expired - Access Lists and Network Rules are locked "
                  "(read-only). Enter a valid license key in Settings, or "
                  "contact Banihal Technologies LLP.", "error")
            return redirect(url_for("settings")
                            if session.get("role") == "admin" else url_for("dashboard"))
        return fn(*a, **kw)
    return wrapper


# --------------------------------------------------------------------- security
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=False,  # set per-request below
    MAX_CONTENT_LENGTH=2 * 1024 * 1024,   # 2 MB cap (logo uploads)
)


@app.before_request
def security_gate():
    if request.endpoint == "static":
        return
    # HMAC signature over the request body (see dr_receive), not by a browser
    # session, so it is exempt from session-CSRF here. It is NOT unauthenticated
    # - dr_receive verifies the HMAC and the peer IP before doing anything.
    if request.endpoint == "dr_receive":
        return
    # CSRF token: create for every session, verify on every POST
    if "csrf" not in session:
        session["csrf"] = secrets.token_hex(16)
    if request.method == "POST":
        sent = request.form.get("_csrf") or request.headers.get("X-CSRF")
        if not sent or sent != session["csrf"]:
            abort(400, "CSRF token missing or invalid - reload the page and retry.")
    # DR standby is READ-ONLY for config: block every config-changing POST in
    # one place so a forgotten route cannot cause DC/DR drift. The allowlist is
    # the set of POSTs that must still work on a standby - auth, the DR config
    # page itself (to promote/reconfigure), and the machine sync endpoint.
    _STANDBY_ALLOWED = {
        "login", "logout", "do_logout", "mfa", "mfa_setup", "password",
        "settings_dr", "dr_promote", "dr_sync_now", "dr_receive",
    }
    if (request.method == "POST" and request.endpoint not in _STANDBY_ALLOWED
            and is_standby()):
        abort(403, "This node is the DR standby - configuration is read-only "
                   "until it is promoted to primary.")
    # idle timeout
    if session.get("uid"):
        last = session.get("last_seen", 0)
        if time.time() - last > config.IDLE_TIMEOUT_MIN * 60:
            session.clear()
            flash("Session expired due to inactivity. Please sign in again.", "error")
            return redirect(url_for("login"))
        session["last_seen"] = time.time()


@app.after_request
def security_headers(resp):
    if ssl_on():
        app.config["SESSION_COOKIE_SECURE"] = True
    resp.headers["X-Frame-Options"] = "DENY"
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Referrer-Policy"] = "same-origin"
    resp.headers["Content-Security-Policy"] = (
        "default-src 'self'; script-src 'self' 'unsafe-inline'; "
        "style-src 'self' 'unsafe-inline'; img-src 'self' data:")
    if ssl_on():
        resp.headers["Strict-Transport-Security"] = "max-age=31536000"
    return resp


def login_locked(username, ip):
    """True if this username or IP has too many recent failures."""
    since = (datetime.now() - timedelta(minutes=config.LOGIN_LOCK_MIN)
             ).isoformat(timespec="seconds")
    row = get_db().execute(
        "SELECT COUNT(*) c FROM login_fails WHERE ts > ? AND (username=? OR ip=?)",
        (since, username, ip)).fetchone()
    return row["c"] >= config.LOGIN_MAX_FAILS


def record_fail(username, ip):
    db = get_db()
    db.execute("INSERT INTO login_fails (ts, username, ip) VALUES (?,?,?)",
               (datetime.now().isoformat(timespec="seconds"), username, ip))
    db.execute("DELETE FROM login_fails WHERE ts < ?",
               ((datetime.now() - timedelta(hours=24)).isoformat(timespec="seconds"),))
    db.commit()


def clear_fails(username, ip):
    db = get_db()
    db.execute("DELETE FROM login_fails WHERE username=? OR ip=?", (username, ip))
    db.commit()


# ---------------------------------------------------------------- password policy
def validate_password(pw, uid=None):
    """Return an error string if pw violates the configured policy, else None."""
    s = load_settings()
    n = int(s.get("pw_min_length", 8))
    if len(pw) < n:
        return f"Password must be at least {n} characters."
    mode = s.get("pw_complexity", "off")
    if mode in ("medium", "strong"):
        if not (re.search(r"[A-Za-z]", pw) and re.search(r"\d", pw)):
            return "Password must contain both letters and numbers."
    if mode == "strong":
        if not (re.search(r"[a-z]", pw) and re.search(r"[A-Z]", pw)
                and re.search(r"[^A-Za-z0-9]", pw)):
            return ("Password must contain an upper-case letter, a lower-case "
                    "letter, a number and a special character.")
    hist = int(s.get("pw_history", 0))
    if uid and hist > 0:
        rows = get_db().execute(
            "SELECT pw_hash FROM pw_history WHERE user_id=? ORDER BY id DESC LIMIT ?",
            (uid, hist)).fetchall()
        for r in rows:
            if check_password_hash(r["pw_hash"], pw):
                return f"Password was used recently - the last {hist} passwords cannot be reused."
    return None


def set_password(uid, pw, must_change=False):
    """Update a user's password, record history, stamp change date."""
    db = get_db()
    h = generate_password_hash(pw)
    now = datetime.now().isoformat(timespec="seconds")
    db.execute("UPDATE users SET pw_hash=?, must_change=?, pw_changed_at=? WHERE id=?",
               (h, 1 if must_change else 0, now, uid))
    db.execute("INSERT INTO pw_history (user_id, pw_hash, ts) VALUES (?,?,?)",
               (uid, h, now))
    db.execute("DELETE FROM pw_history WHERE user_id=? AND id NOT IN "
               "(SELECT id FROM pw_history WHERE user_id=? ORDER BY id DESC LIMIT 10)",
               (uid, uid))
    db.commit()


def get_or_create_ad_user(username, role):
    """Ensure a shadow local record exists for an AD user; keep role in sync.
    AD users have an empty pw_hash so they can never log in via local path.

    'username' must be the canonical sAMAccountName (lowercased). If an older
    duplicate exists under a UPN form ('user@domain'), it is merged in here so
    the person has a single account and MFA is not silently bypassable.
    """
    db = get_db()
    username = (username or "").lower()
    now = datetime.now().isoformat(timespec="seconds")

    # Merge a legacy UPN-form duplicate (created before canonicalisation).
    if "@" not in username:
        dupes = db.execute(
            "SELECT * FROM users WHERE is_ad=1 AND lower(username) LIKE ? "
            "AND lower(username) != ?",
            (username + "@%", username)).fetchall()
        canon_row = db.execute("SELECT * FROM users WHERE lower(username)=?",
                               (username,)).fetchone()
        for dup in dupes:
            # Preserve MFA from whichever record has it enrolled.
            if dup["mfa_enabled"] and (not canon_row or not canon_row["mfa_enabled"]):
                if not canon_row:
                    db.execute("INSERT INTO users (username,pw_hash,role,must_change,"
                               "created_at,pw_changed_at,is_ad,mfa_enabled,totp_secret) "
                               "VALUES (?,?,?,0,?,?,1,?,?)",
                               (username, "", role, now, now,
                                dup["mfa_enabled"], dup["totp_secret"]))
                    canon_row = db.execute("SELECT * FROM users WHERE lower(username)=?",
                                           (username,)).fetchone()
                else:
                    db.execute("UPDATE users SET mfa_enabled=?, totp_secret=? WHERE id=?",
                               (dup["mfa_enabled"], dup["totp_secret"], canon_row["id"]))
            db.execute("DELETE FROM users WHERE id=?", (dup["id"],))
            audit_anon("ad-user-merged",
                       f"merged {dup['username']} into {username}")
        db.commit()

    row = db.execute("SELECT * FROM users WHERE lower(username)=?",
                     (username,)).fetchone()
    if row:
        updates = []
        params = []
        if row["role"] != role:
            updates.append("role=?"); params.append(role)
        # Heal a shadow record that a pre-fix password reset corrupted: an AD
        # user must have no local password and no forced local change.
        if row["pw_hash"]:
            updates.append("pw_hash=''")
        if row["must_change"]:
            updates.append("must_change=0")
        if updates:
            params.append(row["id"])
            db.execute(f"UPDATE users SET {', '.join(updates)} WHERE id=?", params)
            db.commit()
        return db.execute("SELECT * FROM users WHERE id=?", (row["id"],)).fetchone()
    db.execute("INSERT INTO users (username, pw_hash, role, must_change, "
               "created_at, pw_changed_at, is_ad) VALUES (?,?,?,0,?,?,1)",
               (username, "", role, now, now))
    db.commit()
    audit_anon("ad-user-created", f"{username} ({role})")
    return db.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()


def password_expired(row):
    s = load_settings()
    days = int(s.get("pw_expire_days", 0))
    if days <= 0:
        return False
    changed = row["pw_changed_at"] or row["created_at"]
    try:
        age = datetime.now() - datetime.fromisoformat(changed)
        return age.days >= days
    except ValueError:
        return False


# ------------------------------------------------------------------------- auth
def login_required(fn):
    @wraps(fn)
    def wrapper(*a, **kw):
        if not session.get("uid"):
            return redirect(url_for("login", next=request.path))
        if session.get("must_change") and request.endpoint not in ("change_password", "logout", "static"):
            return redirect(url_for("change_password"))
        return fn(*a, **kw)
    return wrapper


def admin_required(fn):
    @wraps(fn)
    def wrapper(*a, **kw):
        if session.get("role") != "admin":
            abort(403)
        return fn(*a, **kw)
    return wrapper


@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "POST":
        u = request.form.get("username", "").strip()
        p = request.form.get("password", "")
        ip = request.remote_addr or "-"
        if login_locked(u, ip):
            audit_anon("login-locked", f"{u} from {ip}")
            flash(f"Too many failed attempts. Locked for {config.LOGIN_LOCK_MIN} minutes.", "error")
            return render_template("login.html")
        row = get_db().execute("SELECT * FROM users WHERE username=?", (u,)).fetchone()
        local_ok = bool(row and row["pw_hash"] and check_password_hash(row["pw_hash"], p))

        # If no local password match, try Active Directory (if enabled)
        ad_role = None
        if not local_ok:
            st = load_settings()
            if st.get("ad_enabled"):
                status, ad_role, admsg, canon = ad_auth.authenticate(u, p, st)
                if status == "ok":
                    # Key the account on AD's canonical name, not the typed form,
                    # so 'tbt001' and 'tbt001@domain' are ONE account (and MFA
                    # enrolled on one applies to both).
                    row = get_or_create_ad_user(canon or u.split("@")[0].lower(),
                                                ad_role)
                    local_ok = True
                elif status == "unreachable":
                    record_fail(u, ip)
                    audit_anon("login-ad-unreachable", f"{u} from {ip}")
                    flash("Directory unreachable. If you have a local account, "
                          "check the username; otherwise try again shortly.", "error")
                    return render_template("login.html")
                elif status in ("no_group",):
                    record_fail(u, ip)
                    audit_anon("login-ad-nogroup", f"{u} from {ip}")
                    flash(admsg or "Your account has no BT Proxy access.", "error")
                    return render_template("login.html")
                # bad_creds / disabled / misconfig fall through to the failure path
        if local_ok and row:
            if not row["is_ad"] and password_expired(row) and not row["must_change"]:
                db = get_db()
                db.execute("UPDATE users SET must_change=1 WHERE id=?", (row["id"],))
                db.commit()
                row = db.execute("SELECT * FROM users WHERE id=?", (row["id"],)).fetchone()
                flash("Your password has expired per policy - please set a new one.", "error")
            if row["mfa_enabled"]:
                # password OK - not logged in yet, ask for the 6-digit code
                session["pending_uid"] = row["id"]
                session["pending_since"] = time.time()
                return redirect(url_for("mfa_verify"))
            clear_fails(u, ip)
            session.permanent = True
            session["uid"] = row["id"]
            session["username"] = row["username"]
            session["role"] = row["role"]
            session["must_change"] = bool(row["must_change"])
            session["last_seen"] = time.time()
            audit("login", f"login from {request.remote_addr}")
            if row["must_change"]:
                return redirect(url_for("change_password"))
            return redirect(request.args.get("next") or url_for("dashboard"))
        record_fail(u, ip)
        audit_anon("login-fail", f"{u} from {ip}")
        flash("Wrong username or password.", "error")
    return render_template("login.html")


@app.route("/logout")
def logout():
    if session.get("username"):
        audit("logout", "")
    session.clear()
    return redirect(url_for("login"))


@app.route("/password", methods=["GET", "POST"])
@login_required
def change_password():
    urow = get_db().execute("SELECT is_ad FROM users WHERE id=?",
                            (session["uid"],)).fetchone()
    if urow and urow["is_ad"]:
        flash("Your password is managed by Active Directory - change it through "
              "Windows, not here.", "error")
        return redirect(url_for("dashboard"))
    if request.method == "POST":
        cur = request.form.get("current", "")
        new = request.form.get("new", "")
        again = request.form.get("again", "")
        row = get_db().execute("SELECT * FROM users WHERE id=?", (session["uid"],)).fetchone()
        err = validate_password(new, session["uid"])
        if not check_password_hash(row["pw_hash"], cur):
            flash("Current password is wrong.", "error")
        elif err:
            flash(err, "error")
        elif new != again:
            flash("New passwords do not match.", "error")
        else:
            set_password(session["uid"], new, must_change=False)
            session["must_change"] = False
            audit("password", "changed own password")
            flash("Password updated.", "ok")
            return redirect(url_for("dashboard"))
    return render_template("change_password.html",
                           forced=session.get("must_change", False))


# ------------------------------------------------------------------------- MFA
def complete_login(row):
    session.pop("pending_uid", None)
    session.pop("pending_since", None)
    session.permanent = True
    session["uid"] = row["id"]
    session["username"] = row["username"]
    session["role"] = row["role"]
    session["must_change"] = bool(row["must_change"])
    session["last_seen"] = time.time()


@app.route("/mfa", methods=["GET", "POST"])
def mfa_verify():
    uid = session.get("pending_uid")
    if not uid or time.time() - session.get("pending_since", 0) > 300:
        session.pop("pending_uid", None)
        return redirect(url_for("login"))
    row = get_db().execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    if not row or not row["mfa_enabled"]:
        return redirect(url_for("login"))
    if request.method == "POST":
        ip = request.remote_addr or "-"
        if login_locked(row["username"], ip):
            flash(f"Too many failed attempts. Locked for {config.LOGIN_LOCK_MIN} minutes.", "error")
            return render_template("mfa.html")
        code = request.form.get("code", "").strip().replace(" ", "")
        if pyotp.TOTP(row["totp_secret"]).verify(code, valid_window=1):
            clear_fails(row["username"], ip)
            complete_login(row)
            audit("login", f"login+MFA from {ip}")
            if row["must_change"]:
                return redirect(url_for("change_password"))
            return redirect(url_for("dashboard"))
        record_fail(row["username"], ip)
        audit_anon("mfa-fail", f"{row['username']} from {ip}")
        flash("Wrong code. Check the time on your phone and try again.", "error")
    return render_template("mfa.html")


def qr_data_uri(uri):
    img = qrcode.make(uri, box_size=6, border=2)
    buf = _io.BytesIO()
    img.save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


@app.route("/mfa/setup", methods=["GET", "POST"])
@login_required
def mfa_setup():
    db = get_db()
    row = db.execute("SELECT * FROM users WHERE id=?", (session["uid"],)).fetchone()
    if row["mfa_enabled"]:
        return render_template("mfa_setup.html", enabled=True)
    if request.method == "POST" and request.form.get("action") == "confirm":
        secret = session.get("mfa_tmp")
        code = request.form.get("code", "").strip().replace(" ", "")
        if secret and pyotp.TOTP(secret).verify(code, valid_window=1):
            db.execute("UPDATE users SET totp_secret=?, mfa_enabled=1 WHERE id=?",
                       (secret, session["uid"]))
            db.commit()
            session.pop("mfa_tmp", None)
            audit("mfa", "enabled two-factor authentication")
            flash("Two-factor authentication is now ON for your account.", "ok")
            return redirect(url_for("mfa_setup"))
        flash("Code did not match. Scan the QR again and enter the current code.", "error")
    secret = session.get("mfa_tmp")
    if not secret:
        secret = pyotp.random_base32()
        session["mfa_tmp"] = secret
    s = load_settings()
    uri = pyotp.TOTP(secret).provisioning_uri(
        name=session["username"], issuer_name=s["app_title"])
    return render_template("mfa_setup.html", enabled=False,
                           qr=qr_data_uri(uri), secret=secret)


@app.route("/mfa/disable", methods=["POST"])
@login_required
def mfa_disable():
    row = get_db().execute("SELECT * FROM users WHERE id=?", (session["uid"],)).fetchone()
    if not check_password_hash(row["pw_hash"], request.form.get("password", "")):
        flash("Password is wrong - MFA not disabled.", "error")
        return redirect(url_for("mfa_setup"))
    db = get_db()
    db.execute("UPDATE users SET totp_secret=NULL, mfa_enabled=0 WHERE id=?", (session["uid"],))
    db.commit()
    audit("mfa", "disabled two-factor authentication")
    flash("Two-factor authentication is OFF for your account.", "ok")
    return redirect(url_for("mfa_setup"))


# --------------------------------------------------------------- user management
@app.route("/users", methods=["GET", "POST"])
@login_required
@admin_required
def users():
    db = get_db()
    if request.method == "POST":
        action = request.form.get("action")
        if action == "create":
            u = request.form.get("username", "").strip()
            p = request.form.get("password", "")
            role = request.form.get("role", "viewer")
            err = validate_password(p)
            if not re.match(r"^[A-Za-z0-9_.-]{3,32}$", u):
                flash("Username: 3-32 chars, letters/numbers/._- only.", "error")
            elif err:
                flash(err, "error")
            elif role not in ("admin", "operator", "viewer"):
                flash("Invalid role.", "error")
            else:
                try:
                    db.execute("INSERT INTO users (username, pw_hash, role, must_change, created_at) "
                               "VALUES (?,?,?,1,?)",
                               (u, generate_password_hash(p), role,
                                datetime.now().isoformat(timespec="seconds")))
                    db.commit()
                    audit("user-create", f"created {u} ({role})")
                    flash(f"User {u} created. They must change password on first login.", "ok")
                except sqlite3.IntegrityError:
                    flash("Username already exists.", "error")
        elif action == "reset":
            uid = request.form.get("uid")
            row = db.execute("SELECT username, is_ad FROM users WHERE id=?",
                             (uid,)).fetchone()
            if row and row["is_ad"]:
                # An AD user's password lives in Active Directory. BT Proxy
                # cannot change it, and writing a local password here does
                # nothing except break the shadow record - the login path for an
                # AD user goes to AD, not the local hash.
                flash(f"{row['username']} signs in with Active Directory - "
                      f"reset the password in AD, not here.", "error")
            else:
                p = request.form.get("password", "")
                err = validate_password(p, int(uid))
                if err:
                    flash(err, "error")
                elif row:
                    set_password(int(uid), p, must_change=True)
                    audit("user-reset", f"reset password for {row['username']}")
                    flash(f"Password reset for {row['username']}.", "ok")
        elif action == "reset_mfa":
            uid = request.form.get("uid")
            row = db.execute("SELECT username FROM users WHERE id=?", (uid,)).fetchone()
            if row:
                db.execute("UPDATE users SET totp_secret=NULL, mfa_enabled=0 WHERE id=?", (uid,))
                db.commit()
                audit("mfa-reset", f"reset MFA for {row['username']}")
                flash(f"MFA reset for {row['username']} - they can log in with password only "
                      f"and re-enroll from the Two-factor page.", "ok")
        elif action == "delete":
            uid = request.form.get("uid")
            if int(uid) == session["uid"]:
                flash("You cannot delete your own account.", "error")
            else:
                row = db.execute("SELECT username FROM users WHERE id=?", (uid,)).fetchone()
                if row:
                    db.execute("DELETE FROM users WHERE id=?", (uid,))
                    db.commit()
                    audit("user-delete", f"deleted {row['username']}")
                    flash(f"User {row['username']} deleted.", "ok")
        return redirect(url_for("users"))

    rows = db.execute("SELECT * FROM users ORDER BY username").fetchall()
    recent = db.execute("SELECT * FROM audit ORDER BY id DESC LIMIT 30").fetchall()
    return render_template("users.html", users=rows, audit=recent)


# ------------------------------------------------------------- branch ACL logic
def load_branches():
    if not os.path.exists(config.BRANCH_MAP):
        return OrderedDict()
    with open(config.BRANCH_MAP) as f:
        return json.load(f, object_pairs_hook=OrderedDict)


def save_branches(data):
    with open(config.BRANCH_MAP, "w") as f:
        json.dump(data, f, indent=2)


PORT_RE = re.compile(r"^\d{1,5}(-\d{1,5})?$")
TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
DAY_ORDER = "MTWHFAS"  # squid day codes Mon..Fri, A=Sat, S=Sun
DAY_LABELS = [("M","Mon"),("T","Tue"),("W","Wed"),("H","Thu"),
              ("F","Fri"),("A","Sat"),("S","Sun")]


def load_network():
    if not os.path.exists(config.NETWORK_MAP):
        return {"safe_ports": [], "ssl_ports": [], "full_access": []}
    with open(config.NETWORK_MAP) as f:
        return json.load(f)


def save_network(data):
    with open(config.NETWORK_MAP, "w") as f:
        json.dump(data, f, indent=2)


def valid_port(v):
    if not PORT_RE.match(v):
        return False
    parts = [int(x) for x in v.split("-")]
    return all(1 <= p <= 65535 for p in parts) and parts == sorted(parts)


def valid_src(v):
    try:
        ipaddress.ip_network(v, strict=False)
        return True
    except ValueError:
        return False


def expand_domain(d, subdomains=True):
    """Return the Squid dstdomain form for an operator-entered domain.

    Squid dstdomain semantics (Squid 2.3+):
      * '.google.com' matches google.com AND every subdomain.
      * 'google.com'  matches ONLY google.com exactly.
      * Both forms in the SAME acl is FATAL - Squid reports "'.google.com' is a
        subdomain of 'google.com'" and refuses to start. On a bank proxy that
        means the whole thing is down, so _dedupe_domains must always run: it
        keeps the broader dot form and drops the redundant bare one.

    subdomains=True  -> '.google.com' (the domain and everything under it)
    subdomains=False -> 'google.com'  (that exact host only)
    """
    d = d.strip().lower().rstrip(".")
    if not d:
        return []
    bare = d.lstrip(".")
    if d.startswith("."):
        return [d]                     # operator typed the dot form explicitly
    return ["." + bare] if subdomains else [bare]


def _dedupe_domains(domains):
    """Remove entries that are already covered by a broader '.parent' entry, to
    avoid Squid's 'subdomain of another entry' warning. E.g. if '.google.com'
    is present, '.mail.google.com' and 'google.com' are redundant."""
    dot_roots = sorted((d for d in domains if d.startswith(".")), key=len)
    kept = []
    for d in domains:
        bare = d.lstrip(".")
        covered = False
        for root in dot_roots:
            root_bare = root.lstrip(".")
            if d == root:
                break
            # covered if d is root_bare itself, or ends with .root_bare
            if bare == root_bare or bare.endswith("." + root_bare):
                covered = True
                break
        if not covered:
            kept.append(d)
    # stable order: keep first-seen order of survivors
    seen = set()
    out = []
    for d in domains:
        if d in kept and d not in seen:
            seen.add(d)
            out.append(d)
    return out


def split_entries(entries, force_subdomains=False):
    """Separate a site list into (domains, ips). IPs/CIDRs get dst ACLs.

    Entries are kept in the form they are stored in - '.google.com' (domain and
    subdomains) or 'google.com' (exact host) - because that choice is the
    operator's. Redundant entries are removed so Squid never sees both forms of
    the same domain, which is FATAL.

    force_subdomains=True is the one-time legacy migration: lists written before
    v1.12.6 stored bare domains that MEANT "and subdomains" (the dot was added
    at generation time), so they must be converted, not reinterpreted.
    """
    domains, ips = [], []
    for e in entries:
        try:
            ipaddress.ip_network(e, strict=False)
            ips.append(e)
        except ValueError:
            for form in expand_domain(e, subdomains=True if force_subdomains
                                      else e.strip().startswith(".")):
                if form not in domains:
                    domains.append(form)
    return _dedupe_domains(domains), ips


def acl_name(branch):
    return re.sub(r"[^a-z0-9_]", "_", branch.lower())


def _prefix_span(src):
    """Return (prefixlen, is_ipv6) for a source; higher prefixlen = narrower."""
    net = ipaddress.ip_network(src, strict=False)
    return net.prefixlen, net.version == 6


def branch_specificity(b):
    """Most-specific prefix among a branch's sources. A /32 host is the most
    specific; a /24 subnet less so; no sources = least. Used to order rules so
    narrow (per-PC / per-department) rules are evaluated before the broad
    subnet rules that contain them."""
    srcs = b.get("sources", [])
    if not srcs:
        return -1
    best = -1
    for s in srcs:
        try:
            plen, _ = _prefix_span(s)
            best = max(best, plen)
        except ValueError:
            continue
    return best


def generate_conf():
    """Write the single squid include file with all GUI-managed rules.

    ORDERING GUARANTEE (security-critical): rules are emitted most-specific
    source first. Squid evaluates http_access top-to-bottom and stops at the
    first match, so a /32 host rule or a small department range is matched
    before the /24 subnet that contains it. This makes per-PC and per-department
    rules reliable even when their IPs sit inside a broader branch's subnet.

    Per-branch 'mode':
      * 'exclusive' (whitelist-only): the sources may reach ONLY the whitelist;
        everything else is denied for them right here (a scoped deny that cannot
        affect other sources, because it is guarded by this rule's own src ACL).
      * 'additive'  (default): allow the whitelist / deny the blacklist for
        these sources, then FALL THROUGH so they also get whatever broader
        rules (their subnet, global) would grant. Used when a department needs
        its special sites PLUS normal access.
    """
    net = load_network()
    branches = load_branches()
    L = ["# ============================================================",
         "# Generated by BT Proxy - DO NOT EDIT BY HAND",
         f"# Last update: {datetime.now().isoformat(timespec='seconds')}",
         "# squid.conf needs one line, just above 'http_access deny all':",
         f"#     include {config.GEN_CONF}",
         "# Rules are ordered most-specific-source-first (see BT Proxy docs).",
         "# ============================================================", ""]

    if net["safe_ports"] or net["ssl_ports"]:
        L.append("# ---- Extra allowed ports (extend the default ACLs) ----")
        for p in net["safe_ports"]:
            L.append(f"acl Safe_ports port {p}")
        for p in net["ssl_ports"]:
            L.append(f"acl SSL_ports port {p}")
        L.append("")

    if net["full_access"]:
        L.append("# ---- Full internet access hosts ----")
        for i, fa in enumerate(net["full_access"], 1):
            if fa.get("expires") and fa["expires"] <= time.time():
                continue
            tag = f"fullaccess_{i}"
            desc = fa.get("desc", "")
            L.append(f"# {desc or fa['src']}")
            L.append(f"acl {tag} src {fa['src']}")
            t = fa.get("time")
            if t:
                L.append(f"acl {tag}_time time {t['days']} {t['start']}-{t['end']}")
                L.append(f"http_access allow {tag} {tag}_time")
            else:
                L.append(f"http_access allow {tag}")
            L.append("")

    def emit_list(n, kind, b, verb):
        """Emit dstdomain (the list file) + dst (stored IPs) for one site list.

        The .txt file is already canonical - normalised dot forms, no IPs, no
        redundant subdomains - so Squid can read it directly and the config
        stays readable no matter how long the list grows.
        """
        path = b.get(kind)
        domains = read_acl(path)
        ips = site_ips(b, kind)
        if domains:
            L.append(f'acl {n}_{kind} dstdomain "{path}"')
            L.append(f"http_access {verb} {n}_net {n}_{kind}")
        if ips:
            for i in range(0, len(ips), 8):
                L.append(f"acl {n}_{kind}_ips dst " + " ".join(ips[i:i + 8]))
            L.append(f"http_access {verb} {n}_net {n}_{kind}_ips")

    # Most-specific source first. Stable secondary sort by name for determinism.
    ordered = sorted(branches.items(),
                     key=lambda kv: (branch_specificity(kv[1]), kv[0]),
                     reverse=True)

    for name, b in ordered:
        n = acl_name(name)
        srcs = b.get("sources", [])
        # 'mode' supersedes the legacy 'whitelist_only' boolean if present
        mode = b.get("mode")
        if not mode:
            mode = "exclusive" if b.get("whitelist_only") else "additive"
        label = "exclusive/whitelist-only" if mode == "exclusive" else "additive"
        L.append(f"# ---- Rule: {name}  [{label}] ----")
        if not srcs:
            L.append("#  (no source subnets/IPs defined - rules skipped)")
            L.append("")
            continue
        # validate sources at generation time; skip bad ones defensively
        good_srcs = [s for s in srcs if valid_src(s)]
        if not good_srcs:
            L.append("#  (no valid sources - rules skipped)")
            L.append("")
            continue
        has_rules = (site_entries(b, "blacklist") or site_entries(b, "whitelist")
                     or mode == "exclusive")
        if not has_rules:
            L.append("#  (empty lists, additive fall-through - no rules needed)")
            L.append("")
            continue
        L.append(f"acl {n}_net src {' '.join(good_srcs)}")
        # blacklist first (deny wins), then whitelist (allow)
        emit_list(n, "blacklist", b, "deny")
        emit_list(n, "whitelist", b, "allow")
        if mode == "exclusive":
            # scoped deny: only affects THIS rule's sources, and because this
            # rule is emitted before any broader overlapping rule, the broader
            # rule never gets to widen this department's access.
            L.append(f"http_access deny {n}_net")
        L.append("")

    os.makedirs(os.path.dirname(config.GEN_CONF), exist_ok=True)
    tmp = config.GEN_CONF + ".tmp"
    with open(tmp, "w") as f:
        f.write("\n".join(L) + "\n")
    os.replace(tmp, config.GEN_CONF)   # atomic - never leave a half-written ACL
    prune_generated_lists()


def prune_generated_lists():
    """Remove obsolete 'gen_*' companion list files (pre-1.12.4).

    The list file itself is now the canonical Squid dstdomain file, so these
    companions are dead weight and confuse operators browsing the ACL
    directory. Only ever removes
    files carrying the reserved prefix, and only inside ACL_DIR - never a file
    a rule actually points at.
    """
    removed = []
    if not os.path.isdir(config.ACL_DIR):
        return removed
    in_use = set()
    for b in load_branches().values():
        for kind in ("whitelist", "blacklist"):
            if b.get(kind):
                in_use.add(os.path.abspath(b[kind]))
    for fn in os.listdir(config.ACL_DIR):
        if not fn.startswith(GEN_PREFIX) or not fn.endswith((".txt", ".acl")):
            continue
        full = os.path.abspath(os.path.join(config.ACL_DIR, fn))
        if full in in_use:          # defensive: never delete a referenced list
            continue
        try:
            os.remove(full)
            removed.append(fn)
        except OSError:
            pass
    return removed


def resolve_acl_path(branch_name, kind, stored):
    """Return a usable ACL file path for a branch list.
    Repairs branches whose stored path is missing or points nowhere by looking
    for conventionally-named files in ACL_DIR. This recovers lists that were
    imported or hand-created before the GUI tracked their paths."""
    if stored and os.path.exists(stored):
        return stored
    # candidate filenames we may have written or imported
    safe = re.sub(r"[^A-Za-z0-9_-]", "_", branch_name)
    suffix = "whitelist" if kind == "whitelist" else "blacklist"
    candidates = [
        stored,
        os.path.join(config.ACL_DIR, f"{safe}_{suffix}.acl"),
        os.path.join(config.ACL_DIR, f"{safe}-{suffix}.acl"),
        os.path.join(config.ACL_DIR, f"{safe}.{suffix}.acl"),
        os.path.join(config.ACL_DIR, f"{safe}_{suffix}.txt"),
        os.path.join(config.ACL_DIR, f"{branch_name}_{suffix}.acl"),
    ]
    for c in candidates:
        if c and os.path.exists(c):
            return c
    # default target if nothing exists yet
    return os.path.join(config.ACL_DIR, f"{safe}_{suffix}.acl")


def phantom_gen_branches(data):
    """Branches that can only have come from the pre-1.12.3 rescan bug.

    Deliberately narrow: the name must use the reserved generated prefix, the
    branch must have no sources (so it produces no Squid rules), and every
    list path it holds must point at a machine-generated companion file. A
    real operator rule can never satisfy all three.
    """
    out = []
    for name, b in data.items():
        if not name.lower().startswith(GEN_PREFIX):
            continue
        if b.get("sources"):
            continue
        paths = [b.get(k) for k in ("whitelist", "blacklist") if b.get(k)]
        if paths and all(os.path.basename(p).startswith(GEN_PREFIX) for p in paths):
            out.append(name)
    return out


ACL_SCHEMA = 2          # 2 = list files store the operator's chosen match form


def migrate_site_lists(data):
    """Bring lists into the canonical layout.

    The .txt is what Squid reads, so it must hold exactly the intended match
    forms and no IPs. Any IPs found are moved to branches.json, not dropped.

    One-time (schema < 2): lists written by older versions stored bare domains
    that meant "and subdomains" - the dot was added during generation. Those are
    converted to the dot form once. Doing this on every load would silently
    upgrade an operator's deliberate exact-match entry into a wildcard, so it is
    gated behind the schema marker and never repeats.
    """
    s = load_settings()
    legacy = int(s.get("acl_schema", 1) or 1) < ACL_SCHEMA
    changed = False
    for name, b in data.items():
        for kind in ("whitelist", "blacklist"):
            path = b.get(kind)
            if not path or not os.path.exists(path):
                continue
            raw = read_acl(path)
            if not raw:
                continue
            domains, ips = split_entries(raw, force_subdomains=legacy)
            known_ips = site_ips(b, kind)
            merged_ips = known_ips + [i for i in ips if i not in known_ips]
            if domains != raw:
                write_acl(path, domains)
                changed = True
            if merged_ips != known_ips:
                b[f"{kind}_ips"] = merged_ips
                changed = True
    if legacy:
        s["acl_schema"] = ACL_SCHEMA
        save_settings(s)
    return changed


def heal_branches(data):
    """Ensure every branch has valid whitelist/blacklist paths. Persists fixes."""
    changed = False
    for name in phantom_gen_branches(data):
        del data[name]
        changed = True
    for name, b in data.items():
        for kind in ("whitelist", "blacklist"):
            cur = b.get(kind)
            fixed = resolve_acl_path(name, kind, cur)
            if fixed != cur:
                b[kind] = fixed
                changed = True
    if migrate_site_lists(data):
        changed = True
    if changed:
        save_branches(data)
    return data


def read_acl(path):
    if not path or not os.path.exists(path):
        return []
    out = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#"):
                out.append(line)
    return out


def write_acl(path, entries):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write("# Managed by Squid Web GUI - do not edit by hand\n")
        f.write(f"# Last update: {datetime.now().isoformat(timespec='seconds')}\n")
        for e in sorted(set(entries)):
            f.write(e + "\n")


def write_site_list(path, domains):
    """Write a site list as the canonical Squid dstdomain file.

    The file IS what Squid reads, so it holds normalised leading-dot forms with
    redundant subdomains removed, and never IPs (an IP inside dstdomain makes
    Squid reverse-resolve at runtime - IPs are kept in branches.json and
    emitted as 'dst' ACLs instead).
    """
    canon, _ = split_entries(domains)          # expand + dedupe, drop any IPs
    write_acl(path, canon)
    return canon


def site_ips(b, kind):
    """IP/CIDR entries for a list. Stored in branches.json, not the .txt."""
    return list(b.get(f"{kind}_ips", []) or [])


def site_entries(b, kind):
    """Everything in a list, for display: file domains + stored IPs."""
    return read_acl(b.get(kind)) + site_ips(b, kind)


def run_squid(cmd):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True,
                           timeout=config.SQUID_CMD_TIMEOUT)
        return r.returncode == 0, (r.stdout + r.stderr).strip()
    except subprocess.TimeoutExpired:
        return False, (f"command took longer than {config.SQUID_CMD_TIMEOUT}s and was "
                       f"abandoned. It may still have completed - check the service "
                       f"status on the dashboard.")
    except Exception as e:
        return False, str(e)


def wait_for_squid(seconds=None):
    """Poll systemctl until squid reports active. Returns (ok, state)."""
    deadline = time.time() + (seconds or config.RESTART_WAIT)
    state = "unknown"
    while time.time() < deadline:
        try:
            r = subprocess.run(config.IS_ACTIVE_CMD, capture_output=True,
                               text=True, timeout=5)
            state = r.stdout.strip() or "unknown"
            if state == "active":
                return True, state
            if state in ("failed", "inactive"):
                time.sleep(1)
                continue
        except Exception:
            pass
        time.sleep(1)
    return False, state


@app.route("/branches", methods=["GET"])
@login_required
def branches():
    data = heal_branches(load_branches())
    sel = request.args.get("branch") or (next(iter(data)) if data else None)
    wl, bl = [], []
    if sel and sel in data:
        wl = site_entries(data[sel], "whitelist")
        bl = site_entries(data[sel], "blacklist")
    return render_template("branches.html", branches=data, sel=sel,
                           whitelist=wl, blacklist=bl,
                           auto=config.AUTO_RECONFIGURE,
                           acl_dir=config.ACL_DIR)


@app.route("/branches/rescan", methods=["POST"])
@login_required
@admin_required
def branches_rescan():
    """Discover .acl files in ACL_DIR not linked to any branch and report them.
    Also re-heals existing branch paths."""
    data = heal_branches(load_branches())
    known = set()
    for b in data.values():
        for kind in ("whitelist", "blacklist"):
            if b.get(kind):
                known.add(os.path.abspath(b[kind]))
    adopted = []
    if os.path.isdir(config.ACL_DIR):
        for fn in sorted(os.listdir(config.ACL_DIR)):
            if not fn.endswith((".acl", ".txt")):
                continue
            if fn == os.path.basename(config.GEN_CONF):
                continue
            # 'gen_*' files are machine-generated companions of an operator
            # list (see generate_conf). Adopting one would create a phantom
            # branch whose "source list" is overwritten on every Apply,
            # silently discarding anything the operator typed into it.
            if fn.startswith(GEN_PREFIX):
                continue
            full = os.path.abspath(os.path.join(config.ACL_DIR, fn))
            if full in known:
                continue
            # derive a branch name + kind from the filename
            base = re.sub(r"\.(acl|txt)$", "", fn)
            m = re.match(r"(.+?)[_.-](whitelist|blacklist|allow|deny|sites)$", base, re.I)
            if m:
                bname, tag = m.group(1), m.group(2).lower()
                kind = "blacklist" if tag in ("blacklist", "deny") else "whitelist"
            else:
                bname, kind = base, "whitelist"
            bname = bname.strip("_-. ")
            if bname not in data:
                data[bname] = {"whitelist": "", "blacklist": "", "mode": "normal"}
            if not data[bname].get(kind):
                data[bname][kind] = full
                adopted.append(f"{fn} -> {bname} ({kind})")
    data = heal_branches(data)
    save_branches(data)
    audit("branches-rescan", f"{len(adopted)} adopted")
    if adopted:
        flash(f"Adopted {len(adopted)} existing ACL file(s): " +
              "; ".join(adopted[:8]) + ("…" if len(adopted) > 8 else ""), "ok")
    else:
        flash("Rescan complete. No new ACL files found; existing branch links "
              "were re-verified.", "ok")
    return redirect(url_for("branches"))


@app.route("/branches/add-url", methods=["POST"])
@login_required
@config_license_required
def add_url():
    if session.get("role") == "viewer":
        abort(403)
    data = load_branches()
    branch = request.form.get("branch", "")
    kind = request.form.get("kind", "")
    raw = request.form.get("domains", "")
    if branch not in data or kind not in ("whitelist", "blacklist"):
        abort(400)
    path = data[branch][kind]
    domains = read_acl(path)
    ips = site_ips(data[branch], kind)
    want_subs = bool(request.form.get("subdomains"))
    added, bad = [], []
    for token in re.split(r"[\s,]+", raw.strip()):
        if not token:
            continue
        token = token.lower()
        token = re.sub(r"^https?://", "", token).split("/")[0]  # tolerate pasted URLs
        is_ip = False
        try:
            ipaddress.ip_network(token, strict=False)
            is_ip = True
        except ValueError:
            pass
        if is_ip:
            # IPs never go in the dstdomain file - they become dst ACLs.
            if token not in ips:
                ips.append(token)
                added.append(token)
        elif DOMAIN_RE.match(token):
            for form in expand_domain(token, subdomains=want_subs):
                if form not in domains:
                    domains.append(form)
                    added.append(form)
        else:
            bad.append(token)
    if added:
        kept = write_site_list(path, domains)
        dropped = [a for a in added if a not in kept and a not in ips]
        data[branch][f"{kind}_ips"] = ips
        save_branches(data)
        generate_conf()
        audit("acl-add", f"{branch}/{kind}: {', '.join(added)}")
        msg = f"Added {len(added)} entr{'y' if len(added)==1 else 'ies'} to {branch} {kind}."
        if config.AUTO_RECONFIGURE:
            ok, out = run_squid(config.RECONFIGURE_CMD)
            msg += " Squid reloaded." if ok else f" Squid reload FAILED: {out}"
        flash(msg, "ok")
        if dropped:
            flash("Already covered by a broader entry, so not added separately: "
                  + ", ".join(dropped), "ok")
    if bad:
        flash("Rejected (not valid domains): " + ", ".join(bad), "error")
    return redirect(url_for("branches", branch=branch))


@app.route("/branches/bulk-upload", methods=["POST"])
@login_required
@config_license_required
def bulk_upload():
    """Import a plain-text list of domains/IPs into a site list.

    One entry per line; blank lines and '#' comments ignored. Every entry goes
    through exactly the same validation as a typed one - a file is not a reason
    to trust its contents. Bounded in size so an upload cannot exhaust memory or
    fill the disk.
    """
    if session.get("role") == "viewer":
        abort(403)
    data = load_branches()
    branch = request.form.get("branch", "")
    kind = request.form.get("kind", "")
    if branch not in data or kind not in ("whitelist", "blacklist"):
        abort(400)
    f = request.files.get("listfile")
    if not f or not f.filename:
        flash("Choose a file to upload.", "error")
        return redirect(url_for("branches", branch=branch))

    blob = f.read(BULK_MAX_BYTES + 1)
    if len(blob) > BULK_MAX_BYTES:
        flash(f"File too large (limit {BULK_MAX_BYTES // 1024} KB).", "error")
        audit("acl-bulk-reject", f"{branch}/{kind}: oversize {f.filename}")
        return redirect(url_for("branches", branch=branch))
    try:
        text = blob.decode("utf-8")
    except UnicodeDecodeError:
        flash("File must be plain text (UTF-8).", "error")
        return redirect(url_for("branches", branch=branch))

    want_subs = bool(request.form.get("subdomains"))
    path = data[branch][kind]
    domains = read_acl(path)
    ips = site_ips(data[branch], kind)
    added, bad, skipped = [], [], 0

    for line in text.splitlines():
        line = line.split("#", 1)[0].strip().lower()
        if not line:
            continue
        for token in re.split(r"[\s,]+", line):
            if not token:
                continue
            if len(added) >= BULK_MAX_ENTRIES:
                skipped += 1
                continue
            token = re.sub(r"^https?://", "", token).split("/")[0]
            try:
                ipaddress.ip_network(token, strict=False)
                if token not in ips:
                    ips.append(token)
                    added.append(token)
                continue
            except ValueError:
                pass
            if DOMAIN_RE.match(token):
                for form in expand_domain(token, subdomains=want_subs):
                    if form not in domains:
                        domains.append(form)
                        added.append(form)
            else:
                bad.append(token)

    if added:
        kept = write_site_list(path, domains)
        data[branch][f"{kind}_ips"] = ips
        save_branches(data)
        generate_conf()
        audit("acl-bulk-upload",
              f"{branch}/{kind}: {len(added)} from {f.filename[:80]}")
        msg = f"Imported {len(added)} entries into {branch} {kind}."
        if config.AUTO_RECONFIGURE:
            ok, out = run_squid(config.RECONFIGURE_CMD)
            msg += " Squid reloaded." if ok else f" Squid reload FAILED: {out}"
        flash(msg, "ok")
    else:
        flash("Nothing imported - no valid entries found in the file.", "error")
    if skipped:
        flash(f"Stopped at {BULK_MAX_ENTRIES} entries; {skipped} more were "
              f"ignored. Split the file and import again.", "error")
    if bad:
        shown = ", ".join(bad[:10]) + ("…" if len(bad) > 10 else "")
        flash(f"Rejected {len(bad)} invalid entr"
              f"{'y' if len(bad)==1 else 'ies'}: {shown}", "error")
    return redirect(url_for("branches", branch=branch))


@app.route("/branches/remove-urls", methods=["POST"])
@login_required
@config_license_required
def remove_urls():
    """Remove several entries from a site list in one action."""
    if session.get("role") == "viewer":
        abort(403)
    data = load_branches()
    branch = request.form.get("branch", "")
    kind = request.form.get("kind", "")
    picked = request.form.getlist("selected")
    if branch not in data or kind not in ("whitelist", "blacklist"):
        abort(400)
    if not picked:
        flash("Nothing selected.", "error")
        return redirect(url_for("branches", branch=branch))

    targets = set()
    for p in picked:
        p = p.strip().lower()
        targets |= {p, p.lstrip("."), "." + p.lstrip(".")}
    path = data[branch][kind]
    before = read_acl(path)
    domains = [e for e in before if e not in targets]
    ips_before = site_ips(data[branch], kind)
    ips = [e for e in ips_before if e not in targets]
    gone = (len(before) - len(domains)) + (len(ips_before) - len(ips))

    write_site_list(path, domains)
    data[branch][f"{kind}_ips"] = ips
    save_branches(data)
    generate_conf()
    audit("acl-remove-bulk",
          f"{branch}/{kind}: {gone} removed: {', '.join(picked[:20])}")
    msg = f"Removed {gone} entr{'y' if gone == 1 else 'ies'} from {branch} {kind}."
    if config.AUTO_RECONFIGURE:
        ok, out = run_squid(config.RECONFIGURE_CMD)
        msg += " Squid reloaded." if ok else f" Squid reload FAILED: {out}"
    flash(msg, "ok")
    return redirect(url_for("branches", branch=branch))


@app.route("/branches/find-deps", methods=["POST"])
@login_required
@config_license_required
def find_deps():
    """Dependency Finder: fetch an operator-supplied URL (SSRF-safe, static,
    no code execution) and return referenced domains for MANUAL approval.
    Advisory only - nothing is allowed here."""
    if session.get("role") == "viewer":
        abort(403)
    data = load_branches()
    branch = request.form.get("branch", "")
    url = request.form.get("url", "").strip()
    if branch not in data:
        abort(400)
    # audit the search itself - fetching arbitrary URLs is a watched capability
    audit("depfind-search", f"{branch}: {url[:200]}")
    result = dep_finder.find(url)
    if not result.get("ok"):
        flash("Dependency finder: " + result.get("error", "failed"), "error")
        return redirect(url_for("branches", branch=branch))
    labeled = dep_classify.label_domains(result["domains"])
    # what's already in this branch's whitelist, so we can mark them
    existing = set(read_acl(data[branch].get("whitelist")))
    def already(dom):
        return dom in existing or ("." + dom) in existing or \
               any(dom.endswith(e.lstrip(".")) for e in existing if e.startswith("."))
    for d in labeled:
        d["already"] = already(d["domain"])
    wl, bl = site_entries(data[branch], "whitelist"), site_entries(data[branch], "blacklist")
    return render_template("branches.html", branches=data, sel=branch,
                           whitelist=wl, blacklist=bl,
                           auto=config.AUTO_RECONFIGURE, acl_dir=config.ACL_DIR,
                           dep_results=labeled, dep_url=result["final_url"],
                           dep_base=result["base_host"])


@app.route("/branches/approve-deps", methods=["POST"])
@login_required
@config_license_required
def approve_deps():
    """Write ONLY the domains the operator individually ticked into the
    branch whitelist. Every approved domain is validated and audit-logged."""
    if session.get("role") == "viewer":
        abort(403)
    data = load_branches()
    branch = request.form.get("branch", "")
    if branch not in data:
        abort(400)
    picked = request.form.getlist("approve")      # only ticked checkboxes
    path = data[branch]["whitelist"]
    entries = read_acl(path)
    added, bad = [], []
    for token in picked:
        token = token.strip().lower()
        token = re.sub(r"^https?://", "", token).split("/")[0]
        if not token:
            continue
        if DOMAIN_RE.match(token):
            # store as a suffix match so the domain + its subdomains resolve
            entry = token if token.startswith(".") else token
            if entry not in entries:
                entries.append(entry)
                added.append(entry)
        else:
            bad.append(token)
    if added:
        write_site_list(path, entries)
        generate_conf()
        audit("depfind-approve", f"{branch}: {', '.join(added)}")
        msg = f"Approved and added {len(added)} domain(s) to {branch} whitelist."
        if config.AUTO_RECONFIGURE:
            ok, out = run_squid(config.RECONFIGURE_CMD)
            msg += " Squid reloaded." if ok else f" Squid reload FAILED: {out}"
        flash(msg, "ok")
    else:
        flash("No domains were selected to approve.", "error")
    if bad:
        flash("Rejected (not valid domains): " + ", ".join(bad), "error")
    return redirect(url_for("branches", branch=branch))


@app.route("/settings/deplists", methods=["POST"])
@login_required
@admin_required
def deplists_import():
    """Import/extend a dependency-finder category list."""
    category = request.form.get("category", "")
    text = request.form.get("domains", "")
    f = request.files.get("file")
    if f and f.filename:
        text += "\n" + f.read().decode("utf-8", errors="replace")
    try:
        added, total = dep_classify.import_list(category, text)
        audit("deplist-import", f"{category}: +{added} (total {total})")
        flash(f"Imported {added} domain(s) into '{category}' list "
              f"({total} total).", "ok")
    except ValueError as e:
        flash(str(e), "error")
    return redirect(url_for("settings") + "#deplists")


@app.route("/branches/remove-url", methods=["POST"])
@login_required
@config_license_required
def remove_url():
    if session.get("role") == "viewer":
        abort(403)
    data = load_branches()
    branch = request.form.get("branch", "")
    kind = request.form.get("kind", "")
    domain = request.form.get("domain", "")
    if branch not in data or kind not in ("whitelist", "blacklist"):
        abort(400)
    path = data[branch][kind]
    # The stored form is canonical ('.google.com'); accept either form here so
    # a Remove click works whatever the row was rendered from.
    variants = {domain, domain.lstrip("."), "." + domain.lstrip(".")}
    domains = [e for e in read_acl(path) if e not in variants]
    ips = [e for e in site_ips(data[branch], kind) if e != domain]
    write_site_list(path, domains)
    data[branch][f"{kind}_ips"] = ips
    save_branches(data)
    generate_conf()
    audit("acl-remove", f"{branch}/{kind}: {domain}")
    msg = f"Removed {domain} from {branch} {kind}."
    if config.AUTO_RECONFIGURE:
        ok, out = run_squid(config.RECONFIGURE_CMD)
        msg += " Squid reloaded." if ok else f" Squid reload FAILED: {out}"
    flash(msg, "ok")
    return redirect(url_for("branches", branch=branch))


@app.route("/branches/new", methods=["POST"])
@login_required
@admin_required
@config_license_required
def new_branch():
    name = request.form.get("name", "").strip()
    desc = request.form.get("description", "").strip()
    if not BRANCH_RE.match(name):
        flash("Branch name: 2-32 chars, letters/numbers/_/- only.", "error")
        return redirect(url_for("branches"))
    if name.lower().startswith(GEN_PREFIX):
        flash(f"'{GEN_PREFIX}' is reserved for BT Proxy's generated files - "
              f"please choose another name.", "error")
        return redirect(url_for("branches"))
    data = load_branches()
    if name in data:
        flash("Branch already exists.", "error")
        return redirect(url_for("branches", branch=name))
    wl = os.path.join(config.ACL_DIR, f"{name.lower()}_whitelist.txt")
    bl = os.path.join(config.ACL_DIR, f"{name.lower()}_blacklist.txt")
    write_acl(wl, [])
    write_acl(bl, [])
    data[name] = {"whitelist": wl, "blacklist": bl, "description": desc,
                  "sources": [], "whitelist_only": True, "mode": "exclusive"}
    save_branches(data)
    generate_conf()
    audit("branch-create", name)
    flash(f"Branch {name} created. Add the ACL lines shown below to squid.conf once.", "ok")
    return redirect(url_for("branches", branch=name))


@app.route("/branches/delete", methods=["POST"])
@login_required
@admin_required
@config_license_required
def delete_branch():
    data = load_branches()
    branch = request.form.get("branch", "")
    if branch not in data:
        abort(400)
    b = data.pop(branch)
    # remove list files only if they live inside the GUI-managed ACL_DIR
    removed_files = []
    for key in ("whitelist", "blacklist"):
        p = b.get(key)
        if p and os.path.realpath(p).startswith(os.path.realpath(config.ACL_DIR)):
            for path in (p, os.path.join(os.path.dirname(p),
                                         GEN_PREFIX + os.path.basename(p))):
                if os.path.exists(path):
                    os.remove(path)
                    removed_files.append(os.path.basename(path))
    save_branches(data)
    generate_conf()
    audit("branch-delete", f"{branch} (files: {', '.join(removed_files) or 'kept'})")
    flash(f"Branch {branch} deleted."
          + (" Click Apply to Squid to activate." if not config.AUTO_RECONFIGURE else ""), "ok")
    if config.AUTO_RECONFIGURE:
        run_squid(config.RECONFIGURE_CMD)
    return redirect(url_for("branches"))


@app.route("/branches/sources", methods=["POST"])
@login_required
@config_license_required
def branch_sources():
    if session.get("role") == "viewer":
        abort(403)
    data = load_branches()
    branch = request.form.get("branch", "")
    if branch not in data:
        abort(400)
    action = request.form.get("action")
    data[branch].setdefault("sources", [])
    if action == "add":
        raw = request.form.get("sources", "")
        added, bad = [], []
        for tok in re.split(r"[\s,]+", raw.strip()):
            if not tok:
                continue
            if valid_src(tok):
                new_net = ipaddress.ip_network(tok, strict=False)
                overlap = None
                for ex in data[branch]["sources"]:
                    ex_net = ipaddress.ip_network(ex, strict=False)
                    if new_net.subnet_of(ex_net) or ex_net.subnet_of(new_net):
                        overlap = ex
                        break
                if overlap:
                    flash(f"{tok} overlaps existing entry {overlap} - not added. "
                          f"Remove the narrower one first if you want to change it.", "error")
                elif tok not in data[branch]["sources"]:
                    data[branch]["sources"].append(tok)
                    added.append(tok)
            else:
                bad.append(tok)
        if added:
            save_branches(data)
            generate_conf()
            audit("branch-src-add", f"{branch}: {', '.join(added)}")
            flash(f"Added source(s) to {branch}: {', '.join(added)}", "ok")
        if bad:
            flash("Rejected (not valid IP/subnet): " + ", ".join(bad), "error")
    elif action == "remove":
        srcv = request.form.get("source", "")
        if srcv in data[branch]["sources"]:
            data[branch]["sources"].remove(srcv)
            save_branches(data)
            generate_conf()
            audit("branch-src-remove", f"{branch}: {srcv}")
            flash(f"Removed {srcv} from {branch}.", "ok")
    elif action == "mode":
        # explicit mode select (additive | exclusive); keep legacy bool in sync
        m = request.form.get("access_mode")
        if m in ("additive", "exclusive"):
            data[branch]["mode"] = m
            data[branch]["whitelist_only"] = (m == "exclusive")
        else:
            wl_only = request.form.get("whitelist_only") == "on"
            data[branch]["whitelist_only"] = wl_only
            data[branch]["mode"] = "exclusive" if wl_only else "additive"
        save_branches(data)
        generate_conf()
        mode = data[branch]["mode"]
        audit("branch-mode", f"{branch}: {mode}")
        flash(f"{branch} access mode set to {mode}.", "ok")
    return redirect(url_for("branches", branch=branch))


def audit_system(action, detail):
    """Audit entry from outside a request context (background worker)."""
    try:
        db = sqlite3.connect(config.DB_PATH)
        db.execute("INSERT INTO audit (ts, username, action, detail) VALUES (?,?,?,?)",
                   (datetime.now().isoformat(timespec="seconds"), "system", action, detail))
        db.commit()
        db.close()
    except Exception:
        pass
    syslog_send(f"user=system action={action} detail={detail}")


def purge_expired_access():
    """Remove expired temporary full-access entries. Returns True if any removed."""
    net = load_network()
    now = time.time()
    keep, gone = [], []
    for fa in net["full_access"]:
        if fa.get("expires") and fa["expires"] <= now:
            gone.append(fa["src"])
        else:
            keep.append(fa)
    if not gone:
        return False
    net["full_access"] = keep
    save_network(net)
    generate_conf()
    ok, out = run_squid(config.RECONFIGURE_CMD)
    audit_system("fullaccess-expired",
                 f"auto-removed: {', '.join(gone)} (squid reload {'ok' if ok else 'FAILED'})")
    return True


def _purge_loop():
    lock_path = os.path.join(config.BASE_DIR, ".purge.lock")
    while True:
        time.sleep(60)
        try:
            with open(lock_path, "w") as lf:
                try:
                    fcntl.flock(lf, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except OSError:
                    continue  # another worker is handling it
                purge_expired_access()
        except Exception:
            pass


threading.Thread(target=_purge_loop, daemon=True).start()


@app.route("/network", methods=["GET"])
@login_required
def network():
    try:
        purge_expired_access()
    except Exception:
        pass
    net = load_network()
    return render_template("network.html", net=net,
                           day_labels=DAY_LABELS,
                           gen_conf=config.GEN_CONF,
                           auto=config.AUTO_RECONFIGURE)


@app.route("/network/ports", methods=["POST"])
@login_required
@config_license_required
def network_ports():
    if session.get("role") == "viewer":
        abort(403)
    net = load_network()
    which = request.form.get("list")
    key = {"safe": "safe_ports", "ssl": "ssl_ports"}.get(which)
    if not key:
        abort(400)
    action = request.form.get("action")
    if action == "add":
        v = request.form.get("port", "").strip()
        if not valid_port(v):
            flash("Invalid port. Use 1-65535 or a range like 8000-8100.", "error")
        elif v in net[key]:
            flash("Port already in the list.", "error")
        else:
            net[key].append(v)
            save_network(net)
            generate_conf()
            audit("port-add", f"{key}: {v}")
            flash(f"Port {v} added to {key}.", "ok")
    elif action == "remove":
        v = request.form.get("port", "")
        if v in net[key]:
            net[key].remove(v)
            save_network(net)
            generate_conf()
            audit("port-remove", f"{key}: {v}")
            flash(f"Port {v} removed from {key}.", "ok")
    return redirect(url_for("network"))


@app.route("/network/full-access", methods=["POST"])
@login_required
@config_license_required
def network_full_access():
    if session.get("role") == "viewer":
        abort(403)
    net = load_network()
    action = request.form.get("action")
    if action == "add":
        srcv = request.form.get("src", "").strip()
        desc = request.form.get("desc", "").strip()
        timed = request.form.get("timed") == "on"
        if not valid_src(srcv):
            flash("Invalid IP or subnet. Examples: 172.31.11.55 or 172.31.11.0/24", "error")
            return redirect(url_for("network"))
        entry = {"src": srcv, "desc": desc, "time": None}
        duration = request.form.get("duration", "perm")
        if duration != "perm":
            try:
                hours = float(duration)
                if not 0 < hours <= 168:
                    raise ValueError
            except ValueError:
                flash("Invalid duration.", "error")
                return redirect(url_for("network"))
            entry["expires"] = int(time.time() + hours * 3600)
        if timed:
            days = "".join(d for d, _ in DAY_LABELS if request.form.get("day_" + d))
            start = request.form.get("start", "")
            end = request.form.get("end", "")
            if not days:
                flash("Select at least one day for a time-based rule.", "error")
                return redirect(url_for("network"))
            if not (TIME_RE.match(start) and TIME_RE.match(end)) or start >= end:
                flash("Invalid time window. Use HH:MM, start must be before end.", "error")
                return redirect(url_for("network"))
            entry["time"] = {"days": days, "start": start, "end": end}
        net["full_access"].append(entry)
        save_network(net)
        generate_conf()
        audit("fullaccess-add",
              f"{srcv} {entry['time'] or 'always'}"
              + (f" TEMP until {datetime.fromtimestamp(entry['expires']):%d-%b %H:%M}"
                 if entry.get("expires") else ""))
        flash(f"Full internet access added for {srcv}.", "ok")
    elif action == "remove":
        idx = int(request.form.get("idx", -1))
        if 0 <= idx < len(net["full_access"]):
            gone = net["full_access"].pop(idx)
            save_network(net)
            generate_conf()
            audit("fullaccess-remove", gone["src"])
            flash(f"Removed full access for {gone['src']}.", "ok")
    return redirect(url_for("network"))


@app.route("/squid/apply", methods=["POST"])
@login_required
def squid_apply():
    if session.get("role") == "viewer":
        abort(403)
    ok, out = run_squid(config.PARSE_CMD)
    if not ok:
        flash("Config check FAILED - not reloading. " + out[-400:], "error")
        return redirect(request.referrer or url_for("branches"))
    ok, out = run_squid(config.RECONFIGURE_CMD)
    audit("squid-reload", "ok" if ok else out[:200])
    flash("Squid reloaded successfully." if ok else "Reload failed: " + out[-400:],
          "ok" if ok else "error")
    return redirect(request.referrer or url_for("branches"))


@app.route("/squid/restart", methods=["POST"])
@login_required
@admin_required
def squid_restart():
    ok, out = run_squid(config.PARSE_CMD)
    if not ok:
        flash("Config check FAILED - not restarting. " + out[-400:], "error")
        return redirect(request.referrer or url_for("branches"))
    ok, out = run_squid(config.RESTART_CMD)
    if not ok:
        audit("squid-restart", "queue failed: " + out[:180])
        flash("Could not start the restart: " + out[-400:], "error")
        return redirect(request.referrer or url_for("branches"))
    # restart is queued; squid drains connections for shutdown_lifetime seconds
    up, state = wait_for_squid()
    audit("squid-restart", "active" if up else f"state={state} after wait")
    if up:
        flash("Squid restarted and is active.", "ok")
    else:
        flash(f"Restart was issued but Squid is still '{state}' after "
              f"{config.RESTART_WAIT}s. Squid drains active connections on "
              f"shutdown (shutdown_lifetime), so this can be normal - check the "
              f"dashboard in a moment. If it stays down, run 'sudo squid -k parse'.",
              "error")
    return redirect(request.referrer or url_for("branches"))


# ---------------------------------------------------------- AD / SSL settings
@app.route("/settings/ad", methods=["POST"])
@login_required
@admin_required
def settings_ad():
    s = load_settings()
    act = request.form.get("action")
    if act == "save":
        s["ad_enabled"] = request.form.get("ad_enabled") == "on"
        for f in ("ad_host1", "ad_host2", "ad_domain", "ad_base_dn",
                  "ad_bind_user", "ad_ca_file", "ad_group_admin",
                  "ad_group_operator", "ad_group_viewer"):
            s[f] = request.form.get(f, "").strip()
        s["ad_port"] = int(request.form.get("ad_port", "636") or 636)
        s["ad_timeout"] = max(2, min(30, int(request.form.get("ad_timeout", "5") or 5)))
        mode = request.form.get("ad_security", "ldaps")
        if mode not in ("ldaps", "starttls", "none"):
            mode = "ldaps"
        s["ad_security"] = mode
        s["ad_use_ssl"] = (mode == "ldaps")     # kept in sync for back-compat
        s["ad_verify_cert"] = request.form.get("ad_verify_cert") == "on"
        pw = request.form.get("ad_bind_password", "")
        if pw:                                   # only overwrite if provided
            s["ad_bind_password"] = crypto_util.encrypt(pw)
        save_settings(s)
        audit("settings-ad", f"enabled={s['ad_enabled']} host={s['ad_host1']}")
        flash("Active Directory settings saved.", "ok")
    return redirect(url_for("settings") + "#ad")


@app.route("/settings/ad/test", methods=["POST"])
@login_required
@admin_required
def settings_ad_test():
    s = load_settings()
    ok, lines = ad_auth.test_connection(
        s, request.form.get("test_user", "").strip() or None,
        request.form.get("test_password", "") or None)
    flash(("AD test OK: " if ok else "AD test problem: ") + " | ".join(lines),
          "ok" if ok else "error")
    return redirect(url_for("settings") + "#ad")


@app.route("/settings/ssl-toggle", methods=["POST"])
@login_required
@admin_required
def ssl_toggle():
    s = load_settings()
    want = request.form.get("ssl_enabled") == "on"
    if want and not os.path.exists(config.SSL_CERT):
        flash("Install a certificate before enabling HTTPS.", "error")
        return redirect(url_for("certificates"))
    s["ssl_enabled"] = want
    save_settings(s)
    audit("ssl-toggle", "on" if want else "off")
    flash(f"HTTPS {'enabled' if want else 'disabled'}. Restart the service to "
          f"apply: the GUI will be reachable on "
          f"{'https' if want else 'http'}://<host>:{config.LISTEN_PORT}.", "ok")
    run_squid(config.SELF_RESTART_CMD)
    return redirect(url_for("certificates"))


# ------------------------------------------------------- email / SMTP alerts
@app.route("/settings/smtp", methods=["POST"])
@login_required
@admin_required
def settings_smtp():
    s = load_settings()
    s["smtp_enabled"] = request.form.get("smtp_enabled") == "on"
    for f in ("smtp_host", "smtp_user", "smtp_from", "smtp_to", "smtp_security"):
        s[f] = request.form.get(f, "").strip()
    if s["smtp_security"] not in ("starttls", "ssl", "none"):
        s["smtp_security"] = "starttls"
    try:
        s["smtp_port"] = max(1, min(65535, int(request.form.get("smtp_port", "587") or 587)))
    except ValueError:
        s["smtp_port"] = 587
    s["smtp_verify_cert"] = request.form.get("smtp_verify_cert") == "on"
    # Accept pasted values like 'smtp://host', 'https://host/' or 'host:587'
    host, inline_port = mailer.normalize_host(s["smtp_host"])
    s["smtp_host"] = host
    if inline_port:
        s["smtp_port"] = inline_port
    pw = request.form.get("smtp_password", "")
    if pw.strip():                           # only overwrite when provided
        # Leading/trailing whitespace in a pasted secret is always accidental.
        s["smtp_password"] = crypto_util.encrypt(pw.strip())
    for f in ("alert_login_fail", "alert_config_change", "alert_service",
              "alert_license", "alert_cert"):
        s[f] = request.form.get(f) == "on"
    save_settings(s)
    audit("settings-smtp", f"enabled={s['smtp_enabled']} host={s['smtp_host']}")
    flash("Email settings saved.", "ok")
    return redirect(url_for("settings") + "#smtp")


@app.route("/settings/smtp/test", methods=["POST"])
@login_required
@admin_required
def settings_smtp_test():
    s = load_settings()
    if not mailer.is_configured(s):
        flash("Fill in the server, From and To addresses first, and enable email.",
              "error")
        return redirect(url_for("settings") + "#smtp")
    host = socket.gethostname()
    ok, msg = mailer.send(
        s, f"[BT Proxy] Test message from {host}",
        f"This is a test message from the BT Proxy management console on {host}.\n"
        f"If you received this, email alerting is configured correctly.\n")
    audit("smtp-test", "ok" if ok else f"FAILED: {msg}"[:180])
    flash("Test email sent." if ok else f"Test failed: {msg}", "ok" if ok else "error")
    return redirect(url_for("settings") + "#smtp")


# ------------------------------------------------------- DC-DR replication
def dr_settings():
    return load_settings()


def is_standby():
    """True when this node is a read-only DR standby (active-passive mode)."""
    s = load_settings()
    return (s.get("dr_enabled") and s.get("dr_mode") == "active-passive"
            and s.get("dr_role") == "standby")


def dr_guard_readonly():
    """Call at the top of every config-changing action. Blocks edits on a
    standby so DC and DR can never diverge. Returns a response to abort with,
    or None to proceed."""
    if is_standby():
        s = load_settings()
        flash(f"This node is the DR standby (managed from "
              f"{s.get('dr_peer_host') or 'the primary'}). Configuration is "
              f"read-only here until it is promoted to primary.", "error")
        return True
    return False


def dr_push(reason="change"):
    """Build the policy bundle and push it to the peer. Best-effort: never
    raises into the caller, records status. Runs in a worker thread so a slow
    or down peer never blocks the GUI."""
    s = load_settings()
    if not s.get("dr_enabled") or not s.get("dr_peer_host"):
        return
    # A standby never pushes in active-passive (only the primary is authoritative).
    if s.get("dr_mode") == "active-passive" and s.get("dr_role") != "primary":
        return
    secret = crypto_util.decrypt(s.get("dr_secret", "")) if s.get("dr_secret") else ""
    if not secret:
        return

    def _worker():
        try:
            data, meta = dr_sync.build_bundle(
                s, config.BRANCH_MAP, config.NETWORK_MAP,
                config.ACL_DIR, config.DEPLIST_DIR)
            sig = dr_sync.sign(secret, data)
            import urllib.request, ssl as _ssl
            url = (f"https://{s['dr_peer_host']}:{int(s.get('dr_peer_port', config.LISTEN_PORT))}"
                   f"/dr/sync")
            req = urllib.request.Request(url, data=data, method="POST")
            req.add_header("X-BTP-Sign", sig)
            req.add_header("X-BTP-Source", meta["source"])
            req.add_header("Content-Type", "application/octet-stream")
            ctx = _ssl.create_default_context()
            if not s.get("dr_verify_cert"):
                ctx.check_hostname = False
                ctx.verify_mode = _ssl.CERT_NONE
            with urllib.request.urlopen(req, timeout=15, context=ctx) as resp:
                body = resp.read().decode("utf-8", "replace")[:120]
            _dr_set_status(f"pushed to peer ({reason}): {body}")
            audit_system("dr-push", f"{reason}: {body}"[:180])
        except Exception as e:
            _dr_set_status(f"push FAILED ({reason}): {e}")
            audit_system("dr-push-fail", f"{reason}: {e}"[:180])

    threading.Thread(target=_worker, daemon=True).start()


def _dr_set_status(msg):
    try:
        s = load_settings()
        s["dr_last_status"] = msg[:200]
        s["dr_last_sync"] = datetime.now().isoformat(timespec="seconds")
        save_settings(s)
    except Exception:
        pass


@app.route("/dr/sync", methods=["POST"])
def dr_receive():
    """Receive a policy bundle from the peer. Authenticated by HMAC over the
    body AND by source-IP match against the configured peer. No session; this
    is machine-to-machine over the DC-DR tunnel."""
    s = load_settings()
    if not s.get("dr_enabled"):
        abort(404)                     # feature off: do not even acknowledge
    secret = crypto_util.decrypt(s.get("dr_secret", "")) if s.get("dr_secret") else ""
    if not secret:
        abort(503)

    # 1. source IP must be the configured peer (defence in depth atop the HMAC)
    peer = s.get("dr_peer_host", "")
    remote = request.remote_addr or ""
    peer_ips = set()
    try:
        peer_ips = {ai[4][0] for ai in socket.getaddrinfo(peer, None)}
    except Exception:
        pass
    if peer and peer_ips and remote not in peer_ips:
        audit_anon("dr-reject", f"bundle from unexpected IP {remote}")
        abort(403)

    # 2. HMAC over the exact body
    data = request.get_data()
    sig = request.headers.get("X-BTP-Sign", "")
    if not dr_sync.verify_sig(secret, data, sig):
        audit_anon("dr-reject", f"bad signature from {remote}")
        abort(403)

    # 3. an active-passive PRIMARY must not accept pushes (only the standby does)
    if s.get("dr_mode") == "active-passive" and s.get("dr_role") == "primary":
        audit_anon("dr-reject", "primary refused an incoming push")
        abort(409)

    ok, msg = dr_sync.apply_bundle(
        data, config.ACL_DIR, config.BASE_DIR, save_settings, load_settings,
        config.PARSE_CMD, run_squid, config.RECONFIGURE_CMD,
        lambda a, d: audit_anon(a, d))
    _dr_set_status(("received: " if ok else "received/REJECTED: ") + msg)
    return (msg, 200) if ok else (msg, 422)


@app.route("/settings/dr", methods=["POST"])
@login_required
@admin_required
def settings_dr():
    if dr_guard_readonly():
        return redirect(url_for("settings") + "#dr")
    s = load_settings()
    s["dr_enabled"] = request.form.get("dr_enabled") == "on"
    mode = request.form.get("dr_mode", "active-passive")
    s["dr_mode"] = mode if mode in ("active-passive", "active-active") else "active-passive"
    role = request.form.get("dr_role", "primary")
    s["dr_role"] = role if role in ("primary", "standby") else "primary"
    s["dr_peer_host"] = request.form.get("dr_peer_host", "").strip()
    s["dr_peer_port"] = int(request.form.get("dr_peer_port", str(config.LISTEN_PORT)) or config.LISTEN_PORT)
    s["dr_verify_cert"] = request.form.get("dr_verify_cert") == "on"
    s["dr_sync_interval"] = max(60, min(3600,
                                int(request.form.get("dr_sync_interval", "300") or 300)))
    secret = request.form.get("dr_secret", "")
    if secret.strip():
        s["dr_secret"] = crypto_util.encrypt(secret.strip())
    save_settings(s)
    audit("dr-config", f"mode={s['dr_mode']} role={s['dr_role']} "
                       f"peer={s['dr_peer_host']} enabled={s['dr_enabled']}")
    flash("DR settings saved.", "ok")
    return redirect(url_for("settings") + "#dr")


@app.route("/dr/sync-now", methods=["POST"])
@login_required
@admin_required
def dr_sync_now():
    s = load_settings()
    if not s.get("dr_enabled") or not s.get("dr_peer_host"):
        flash("Enable DR and set a peer first.", "error")
        return redirect(url_for("settings") + "#dr")
    if is_standby():
        flash("A standby node does not push. Promote it first, or sync from the "
              "primary.", "error")
        return redirect(url_for("settings") + "#dr")
    dr_push("manual")
    flash("Sync started - check the DR status in a moment.", "ok")
    return redirect(url_for("settings") + "#dr")


@app.route("/dr/promote", methods=["POST"])
@login_required
@admin_required
def dr_promote():
    """Standby -> primary. Deliberate, audited, manual failover. No automatic
    promotion: two primaries (split-brain) is worse than a brief outage."""
    s = load_settings()
    if not (s.get("dr_enabled") and s.get("dr_mode") == "active-passive"
            and s.get("dr_role") == "standby"):
        flash("Promote is only available on an active-passive standby.", "error")
        return redirect(url_for("settings") + "#dr")
    confirm = request.form.get("confirm", "")
    if confirm != "PROMOTE":
        flash('Type PROMOTE to confirm making this node the primary.', "error")
        return redirect(url_for("settings") + "#dr")
    s["dr_role"] = "primary"
    save_settings(s)
    audit("dr-promote", f"{socket.gethostname()} promoted to primary by "
                        f"{session.get('username')}")
    flash("This node is now the PRIMARY. It will serve clients and can push to "
          "the peer. Ensure the old primary is demoted or offline to avoid two "
          "primaries.", "ok")
    return redirect(url_for("settings") + "#dr")



@app.route("/backup")
@login_required
@admin_required
def backup_page():
    return render_template("backup.html",
                           backups=backup_manager.list_backups(),
                           s=load_settings(),
                           smtp_ready=mailer.is_configured(load_settings()),
                           inspected=None)


@app.route("/backup/create", methods=["POST"])
@login_required
@admin_required
def backup_create():
    note = request.form.get("note", "").strip()
    try:
        path, fname = backup_manager.create(note)
    except Exception as e:
        flash(f"Backup failed: {e}", "error")
        return redirect(url_for("backup_page"))
    audit("backup-create", fname)
    s = load_settings()
    backup_manager.prune(int(s.get("backup_keep", 10) or 10))
    if request.form.get("email_it") == "on":
        if not mailer.is_configured(s):
            flash("Backup created, but email is not configured.", "error")
        else:
            ok, msg = mailer.send(
                s, f"[BT Proxy] Configuration backup - {socket.gethostname()}",
                "Attached is a BT Proxy configuration backup.\n\n"
                "IMPORTANT: this archive contains password hashes, MFA secrets "
                "and the key that decrypts stored service passwords. Store it "
                "securely and do not forward it.\n",
                attachment=(path, fname))
            audit("backup-email", "ok" if ok else f"FAILED: {msg}"[:150])
            flash("Backup created and emailed." if ok
                  else f"Backup created, but the email failed: {msg}",
                  "ok" if ok else "error")
            return redirect(url_for("backup_page"))
    flash(f"Backup created: {fname}", "ok")
    return redirect(url_for("backup_page"))


@app.route("/backup/download/<path:name>")
@login_required
@admin_required
def backup_download(name):
    # security: never trust the name - basename only, must exist in BACKUP_DIR
    safe = os.path.basename(name)
    path = os.path.join(backup_manager.BACKUP_DIR, safe)
    if not os.path.isfile(path) or not safe.endswith(".tar.gz"):
        abort(404)
    audit("backup-download", safe)
    return send_file(path, as_attachment=True, download_name=safe)


@app.route("/backup/delete", methods=["POST"])
@login_required
@admin_required
def backup_delete():
    safe = os.path.basename(request.form.get("name", ""))
    path = os.path.join(backup_manager.BACKUP_DIR, safe)
    if os.path.isfile(path) and safe.endswith(".tar.gz"):
        os.remove(path)
        audit("backup-delete", safe)
        flash(f"Deleted {safe}.", "ok")
    else:
        flash("Backup not found.", "error")
    return redirect(url_for("backup_page"))


@app.route("/backup/inspect", methods=["POST"])
@login_required
@admin_required
def backup_inspect():
    f = request.files.get("archive")
    if not f or not f.filename:
        flash("Choose a backup file first.", "error")
        return redirect(url_for("backup_page"))
    os.makedirs(backup_manager.BACKUP_DIR, exist_ok=True)
    tmp = os.path.join(backup_manager.BACKUP_DIR, "_pending_restore.tar.gz")
    f.save(tmp)
    os.chmod(tmp, 0o600)
    try:
        info = backup_manager.inspect(tmp)
    except ValueError as e:
        os.remove(tmp)
        flash(str(e), "error")
        return redirect(url_for("backup_page"))
    audit("backup-inspect", f"{info['hostname']} {info['created']}")
    return render_template("backup.html",
                           backups=backup_manager.list_backups(),
                           s=load_settings(),
                           smtp_ready=mailer.is_configured(load_settings()),
                           inspected=info)


@app.route("/backup/restore", methods=["POST"])
@login_required
@admin_required
def backup_restore():
    # restoring replaces users/MFA - re-authenticate the admin first
    pw = request.form.get("confirm_password", "")
    row = get_db().execute("SELECT * FROM users WHERE id=?",
                           (session["uid"],)).fetchone()
    if not row or not row["pw_hash"] or not check_password_hash(row["pw_hash"], pw):
        audit("backup-restore-denied", "wrong password")
        flash("Password incorrect - restore cancelled.", "error")
        return redirect(url_for("backup_page"))
    src = request.form.get("source", "pending")
    if src == "pending":
        path = os.path.join(backup_manager.BACKUP_DIR, "_pending_restore.tar.gz")
    else:
        path = os.path.join(backup_manager.BACKUP_DIR, os.path.basename(src))
    if not os.path.isfile(path):
        flash("Backup file not found - upload it again.", "error")
        return redirect(url_for("backup_page"))
    ok, msg = backup_manager.restore(path)
    audit("backup-restore", msg[:180] if ok else f"FAILED: {msg}"[:180])
    if ok:
        try:
            os.remove(os.path.join(backup_manager.BACKUP_DIR,
                                   "_pending_restore.tar.gz"))
        except OSError:
            pass
        flash(msg, "ok")
        run_squid(config.SELF_RESTART_CMD)
    else:
        flash(msg, "error")
    return redirect(url_for("backup_page"))


# ------------------------------------------------------------ factory reset
@app.route("/backup/factory-reset", methods=["POST"])
@login_required
@admin_required
def factory_reset():
    pw = request.form.get("confirm_password", "")
    typed = request.form.get("confirm_text", "").strip()
    row = get_db().execute("SELECT * FROM users WHERE id=?",
                           (session["uid"],)).fetchone()
    if not row or not row["pw_hash"] or not check_password_hash(row["pw_hash"], pw):
        audit("factory-reset-denied", "wrong password")
        flash("Password incorrect - factory reset cancelled.", "error")
        return redirect(url_for("backup_page"))
    if typed != "RESET":
        flash('Type RESET in the confirmation box to proceed.', "error")
        return redirect(url_for("backup_page"))
    if row["is_ad"]:
        flash("Factory reset requires a LOCAL admin account (AD passwords "
              "cannot be re-verified here).", "error")
        return redirect(url_for("backup_page"))
    # audit BEFORE wiping - the db is about to be deleted
    audit("factory-reset", f"initiated by {session.get('username')}")
    try:
        s = load_settings()
        if mailer.is_configured(s):
            mailer.send(s, f"[BT Proxy] FACTORY RESET on {socket.gethostname()}",
                        mailer.alert_body(socket.gethostname(), "factory-reset",
                                          "All configuration erased",
                                          session.get("username", "-"),
                                          datetime.now().strftime("%Y-%m-%d %H:%M:%S")))
    except Exception:
        pass
    ok, msg, snap = backup_manager.factory_reset()
    session.clear()
    if ok:
        flash(msg, "ok")
    else:
        flash(msg, "error")
    run_squid(config.SELF_RESTART_CMD)
    return redirect(url_for("login"))


@app.route("/backup/schedule", methods=["POST"])
@login_required
@admin_required
def backup_schedule():
    s = load_settings()
    sched = request.form.get("backup_schedule", "off")
    s["backup_schedule"] = sched if sched in ("off", "daily", "weekly", "monthly") else "off"
    t = request.form.get("backup_time", "02:00")
    s["backup_time"] = t if re.match(r"^([01]\d|2[0-3]):[0-5]\d$", t) else "02:00"
    try:
        s["backup_weekday"] = max(0, min(6, int(request.form.get("backup_weekday", 0))))
    except ValueError:
        s["backup_weekday"] = 0
    try:
        s["backup_dom"] = max(1, min(28, int(request.form.get("backup_dom", 1))))
    except ValueError:
        s["backup_dom"] = 1
    s["backup_email"] = request.form.get("backup_email") == "on"
    try:
        s["backup_keep"] = max(1, min(100, int(request.form.get("backup_keep", 10))))
    except ValueError:
        s["backup_keep"] = 10
    save_settings(s)
    audit("backup-schedule", f"{s['backup_schedule']} at {s['backup_time']} "
                             f"email={s['backup_email']}")
    flash("Backup schedule saved.", "ok")
    return redirect(url_for("backup_page"))


# ------------------------------------------------------------- certificates
@app.route("/certificates", methods=["GET"])
@login_required
@admin_required
def certificates():
    return render_template("certificates.html",
                           cert=cert_manager.inspect_current(),
                           ssl_enabled=ssl_on(),
                           has_pending=cert_manager.pending_key() is not None,
                           backups=cert_manager.list_backups(),
                           default_cn=request.host.split(":")[0])


@app.route("/certificates/self-signed", methods=["POST"])
@login_required
@admin_required
def cert_self_signed():
    cn = request.form.get("cn", "").strip()
    if not cn:
        flash("Enter a hostname or IP for the certificate.", "error")
        return redirect(url_for("certificates"))
    sans = re.split(r"[\s,]+", request.form.get("sans", "").strip())
    years = max(1, min(20, int(request.form.get("years", "5") or 5)))
    try:
        cert_pem, key_pem = cert_manager.generate_self_signed(cn, sans, years)
        ok, msg = cert_manager.install(cert_pem, key_pem)
    except Exception as e:
        ok, msg = False, str(e)
    audit("cert-self-signed", f"{cn} {years}y" if ok else f"FAILED: {msg}")
    flash("Self-signed certificate generated and installed. " + msg
          if ok else "Failed: " + msg, "ok" if ok else "error")
    return redirect(url_for("certificates"))


@app.route("/certificates/import", methods=["POST"])
@login_required
@admin_required
def cert_import():
    def read(field):
        f = request.files.get(field)
        return f.read() if f and f.filename else b""
    cert_pem = read("cert")
    key_pem = read("key") or (cert_manager.pending_key()
                              if request.form.get("use_pending") else b"")
    bundle = read("bundle")
    passphrase = request.form.get("passphrase", "") or None
    if not cert_pem or not key_pem:
        flash("Both a certificate and a private key are required "
              "(or generate a CSR first to reuse its key).", "error")
        return redirect(url_for("certificates"))
    try:
        chain = cert_manager.build_chain(cert_pem, bundle)
        ok, errors, warnings = cert_manager.validate_pair(chain, key_pem, passphrase)
        if not ok:
            flash("Certificate rejected: " + " ".join(errors), "error")
            return redirect(url_for("certificates"))
        ok, msg = cert_manager.install(chain, key_pem, passphrase)
        if warnings:
            flash("Note: " + " ".join(warnings), "ok")
    except Exception as e:
        ok, msg = False, str(e)
    audit("cert-import", "installed" if ok else f"FAILED: {msg}")
    flash("Certificate imported and installed." if ok else "Failed: " + msg,
          "ok" if ok else "error")
    return redirect(url_for("certificates"))


@app.route("/certificates/csr", methods=["POST"])
@login_required
@admin_required
def cert_csr():
    cn = request.form.get("cn", "").strip()
    if not cn:
        flash("Common Name (hostname/IP) is required.", "error")
        return redirect(url_for("certificates"))
    sans = re.split(r"[\s,]+", request.form.get("sans", "").strip())
    try:
        csr = cert_manager.generate_csr(
            cn, sans, org=request.form.get("org", ""),
            locality=request.form.get("locality", ""),
            state=request.form.get("state", ""),
            country=request.form.get("country", ""),
            email=request.form.get("email", ""))
        audit("cert-csr", cn)
        return render_template("certificates.html",
                               cert=cert_manager.inspect_current(),
                               ssl_enabled=ssl_on(),
                               has_pending=True,
                               backups=cert_manager.list_backups(),
                               default_cn=request.host.split(":")[0],
                               csr_pem=csr.decode())
    except Exception as e:
        flash("CSR generation failed: " + str(e), "error")
        return redirect(url_for("certificates"))


@app.route("/certificates/restore", methods=["POST"])
@login_required
@admin_required
def cert_restore():
    ok, msg = cert_manager.restore_backup(request.form.get("name") or None)
    audit("cert-restore", msg[:120])
    flash(msg, "ok" if ok else "error")
    if ok:
        run_squid(config.SELF_RESTART_CMD)
    return redirect(url_for("certificates"))


# --------------------------------------------------------- squid package update
def squid_pkg_versions():
    """Return {'current':..., 'available':..., 'error':...} from the helper."""
    out = {"current": "", "available": "", "error": ""}
    if not os.path.exists(config.SQUID_PKG_HELPER):
        out["error"] = ("Helper not installed. Copy deploy/btproxy-squid-update "
                        "to /usr/local/sbin/ (see README).")
        return out
    ok, txt = run_squid(config.SQUID_PKG_CHECK)
    if not ok:
        out["error"] = txt[-300:] or "helper failed"
        return out
    for line in txt.splitlines():
        if line.startswith("current:"):
            out["current"] = line.split(":", 1)[1].strip()
        elif line.startswith("available:"):
            out["available"] = line.split(":", 1)[1].strip()
    return out


@app.route("/squid/package/check", methods=["POST"])
@login_required
@admin_required
def squid_pkg_check():
    v = squid_pkg_versions()
    if v["error"]:
        flash("Could not check for Squid updates: " + v["error"], "error")
    elif v["current"] and v["available"] and v["current"] != v["available"]:
        flash(f"Squid update available: {v['current']} → {v['available']}", "ok")
    else:
        flash(f"Squid is up to date ({v['current'] or 'unknown'}).", "ok")
    audit("squid-pkg-check", f"{v['current']} / {v['available']} {v['error']}"[:180])
    return redirect(url_for("update_page"))


@app.route("/squid/package/upgrade", methods=["POST"])
@login_required
@admin_required
def squid_pkg_upgrade():
    ok, txt = run_squid(config.SQUID_PKG_APPLY)
    audit("squid-pkg-upgrade", ("ok: " if ok else "FAILED: ") + txt[-160:])
    if ok:
        line = next((l for l in txt.splitlines() if l.startswith("upgraded:")), "")
        flash("Squid package upgraded. " + line +
              (" Check the warning above." if "WARNING" in txt else ""),
              "ok")
        if "WARNING" in txt:
            flash("squid.conf did not parse cleanly after the upgrade - "
                  "review Access Lists and run Reload Squid.", "error")
    else:
        flash("Squid upgrade failed: " + txt[-400:], "error")
    return redirect(url_for("update_page"))


# -------------------------------------------------------------- software update
@app.route("/update", methods=["GET"])
@login_required
@admin_required
def update_page():
    return render_template("update.html", backups=update_engine.list_backups(),
                           inspected=None, squid_pkg=squid_pkg_versions())


@app.route("/update/inspect", methods=["POST"])
@login_required
@admin_required
def update_inspect():
    f = request.files.get("package")
    if not f or not f.filename:
        flash("Choose a .btpkg update file first.", "error")
        return redirect(url_for("update_page"))
    tmp = os.path.join(update_engine.UPDATE_DIR, "_pending.btpkg")
    os.makedirs(update_engine.UPDATE_DIR, exist_ok=True)
    f.save(tmp)
    try:
        info = update_engine.inspect(tmp)
    except ValueError as e:
        os.remove(tmp)
        flash(str(e), "error")
        return redirect(url_for("update_page"))
    audit("update-inspect", f"{info['version']} (built {info['built']})")
    return render_template("update.html", backups=update_engine.list_backups(),
                           inspected=info, squid_pkg=squid_pkg_versions())


@app.route("/update/apply", methods=["POST"])
@login_required
@admin_required
def update_apply():
    tmp = os.path.join(update_engine.UPDATE_DIR, "_pending.btpkg")
    if not os.path.exists(tmp):
        flash("No pending update - upload the file again.", "error")
        return redirect(url_for("update_page"))
    ok, msg = update_engine.apply_package(tmp)
    try:
        os.remove(tmp)
    except OSError:
        pass
    audit("update-apply", msg[:180])
    flash(msg, "ok" if ok else "error")
    if ok:
        # attempt automatic service restart so new code loads
        r_ok, r_out = run_squid(config.SELF_RESTART_CMD)
        if r_ok:
            flash("Service is restarting to load the new version - "
                  "this page will reconnect in a few seconds.", "ok")
        else:
            flash("Please restart the service to load the new version: "
                  "sudo systemctl restart squid-webgui", "ok")
    return redirect(url_for("update_page"))


# -------------------------------------------------------------------- settings
ALLOWED_LOGO = {".png", ".jpg", ".jpeg", ".svg", ".gif", ".webp"}


@app.route("/settings", methods=["GET", "POST"])
@login_required
@admin_required
def settings():
    s = load_settings()
    if request.method == "POST":
        action = request.form.get("action")
        if action == "branding":
            title = request.form.get("app_title", "").strip()[:40]
            sub = request.form.get("app_subtitle", "").strip()[:60]
            if title:
                s["app_title"] = title
            s["app_subtitle"] = sub
            save_settings(s)
            audit("settings", f"branding: {title} / {sub}")
            flash("Branding updated.", "ok")
        elif action == "logo":
            f = request.files.get("logo")
            if not f or not f.filename:
                flash("Choose a logo file first.", "error")
            else:
                ext = os.path.splitext(f.filename)[1].lower()
                if ext not in ALLOWED_LOGO:
                    flash("Logo must be PNG, JPG, SVG, GIF or WEBP.", "error")
                else:
                    # remove previous logo file(s)
                    for e in ALLOWED_LOGO:
                        p = os.path.join(app.static_folder, "logo" + e)
                        if os.path.exists(p):
                            os.remove(p)
                    dest = os.path.join(app.static_folder, "logo" + ext)
                    f.save(dest)
                    s["logo_file"] = "logo" + ext
                    save_settings(s)
                    audit("settings", f"logo uploaded ({f.filename})")
                    flash("Logo updated.", "ok")
        elif action == "pwpolicy":
            s["pw_min_length"] = max(6, min(32, int(request.form.get("pw_min_length", 8) or 8)))
            s["pw_complexity"] = (request.form.get("pw_complexity")
                                  if request.form.get("pw_complexity") in ("off", "medium", "strong")
                                  else "off")
            s["pw_history"] = max(0, min(10, int(request.form.get("pw_history", 0) or 0)))
            s["pw_expire_days"] = max(0, min(365, int(request.form.get("pw_expire_days", 0) or 0)))
            save_settings(s)
            audit("settings", f"password policy: len>={s['pw_min_length']} "
                              f"complexity={s['pw_complexity']} history={s['pw_history']} "
                              f"expire={s['pw_expire_days']}d")
            flash("Password policy saved. It applies to new passwords from now on.", "ok")
        elif action == "license":
            key = request.form.get("license_key", "").strip()
            info = lic.verify_key(key)
            if not info:
                flash("Invalid license key - not saved. Check for copy/paste errors.", "error")
            else:
                s["license_key"] = key
                save_settings(s)
                audit("license", f"activated: {info['c']} until {info['e']}")
                flash(f"License activated for {info['c']} - valid until {info['e']}.", "ok")
        elif action == "syslog":
            s["syslog_enabled"] = request.form.get("syslog_enabled") == "on"
            s["syslog_host"] = request.form.get("syslog_host", "").strip()
            s["syslog_port"] = int(request.form.get("syslog_port", "514") or 514)
            s["syslog_proto"] = ("tcp" if request.form.get("syslog_proto") == "tcp"
                                 else "udp")
            save_settings(s)
            _syslog["key"] = None  # force handler rebuild
            audit("settings", f"syslog {'ON' if s['syslog_enabled'] else 'OFF'} "
                              f"{s['syslog_host']}:{s['syslog_port']}/{s['syslog_proto']}")
            flash("Syslog settings saved.", "ok")
        elif action == "syslog_test":
            syslog_send(f"TEST message from BT Proxy (user={session['username']})")
            flash("Test message sent (check the syslog server). "
                  "UDP gives no delivery confirmation.", "ok")
        elif action == "logo_remove":
            for e in ALLOWED_LOGO:
                p = os.path.join(app.static_folder, "logo" + e)
                if os.path.exists(p):
                    os.remove(p)
            s["logo_file"] = None
            save_settings(s)
            audit("settings", "logo removed")
            flash("Logo removed.", "ok")
        return redirect(url_for("settings"))
    ports = []
    try:
        for line in open(config.SQUID_CONF):
            m = re.match(r"^\s*http_port\s+(\S+)", line)
            if m:
                ports.append(m.group(1))
    except OSError:
        pass
    return render_template("settings.html", s=s, squid_ports=", ".join(ports),
                           squid_ver=squid_info().get("version", ""),
                           deplist_stats=dep_classify.list_stats())


# ----------------------------------------------------------------------- logs
LOG_LINE = re.compile(
    r"^(?P<ts>\d+(?:\.\d+)?)\s+(?P<elapsed>-?\d+)\s+(?P<client>\S+)\s+"
    r"(?P<result>\S+)\s+(?P<bytes>\d+)\s+(?P<method>\S+)\s+(?P<url>\S+)\s+"
    r"(?P<user>\S+)\s+(?P<hier>\S+)\s+(?P<mime>\S+)")


def tail_lines(path, n):
    """Read the last n lines of a file without loading it fully."""
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            block = 65536
            data = b""
            while size > 0 and data.count(b"\n") <= n:
                step = min(block, size)
                size -= step
                f.seek(size)
                data = f.read(step) + data
            return data.decode("utf-8", "replace").splitlines()[-n:]
    except FileNotFoundError:
        return None


def parse_log_lines(lines):
    out = []
    for line in lines:
        m = LOG_LINE.match(line)
        if not m:
            continue
        d = m.groupdict()
        d["time"] = datetime.fromtimestamp(float(d["ts"])).strftime("%d-%b %H:%M:%S")
        d["denied"] = "DENIED" in d["result"]
        out.append(d)
    return out


@app.route("/logs")
@login_required
def logs():
    return render_template("logs.html", access_log=config.ACCESS_LOG)


@app.route("/api/logs")
@login_required
def api_logs():
    lines = tail_lines(config.ACCESS_LOG, config.LOG_MAX_LINES)
    if lines is None:
        return jsonify({"error": f"Cannot read {config.ACCESS_LOG}. "
                                 "Check the service user is in the squid/proxy group."}), 500
    entries = parse_log_lines(lines)

    q       = request.args.get("q", "").lower()
    client  = request.args.get("client", "").strip()
    action  = request.args.get("action", "")     # all | denied | allowed
    method  = request.args.get("method", "").upper()

    def keep(e):
        if q and q not in e["url"].lower() and q not in e["result"].lower() \
             and q not in e["user"].lower():
            return False
        if client and not e["client"].startswith(client):
            return False
        if action == "denied" and not e["denied"]:
            return False
        if action == "allowed" and e["denied"]:
            return False
        if method and e["method"] != method:
            return False
        return True

    entries = [e for e in entries if keep(e)][-config.LOG_PAGE_SIZE:]
    entries.reverse()
    return jsonify({"entries": entries, "count": len(entries)})


# -------------------------------------------------------------------- sessions
def sessions_from_cachemgr():
    r = requests.get(config.CACHEMGR_URL, timeout=config.CACHEMGR_TIMEOUT)
    r.raise_for_status()
    text = r.text
    out = []
    cur = {}
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("Connection:"):
            if cur.get("client"):
                out.append(cur)
            cur = {}
        elif line.startswith("remote:"):
            cur["client"] = line.split("remote:", 1)[1].strip()
        elif line.startswith("uri "):
            cur["url"] = line[4:].strip()
        elif line.startswith("username"):
            cur["user"] = line.split(None, 1)[1].strip() if len(line.split()) > 1 else "-"
        elif line.startswith("start"):
            m = re.search(r"start ([\d.]+)", line)
            if m:
                age = time.time() - float(m.group(1))
                cur["age"] = f"{int(age)}s" if age < 120 else f"{int(age/60)}m"
    if cur.get("client"):
        out.append(cur)
    return out


def sessions_from_log():
    lines = tail_lines(config.ACCESS_LOG, 2000) or []
    entries = parse_log_lines(lines)
    cutoff = time.time() - config.SESSION_FALLBACK_WINDOW
    agg = OrderedDict()
    for e in entries:
        if float(e["ts"]) < cutoff:
            continue
        key = e["client"]
        a = agg.setdefault(key, {"client": key, "user": e["user"],
                                 "requests": 0, "last_url": "", "last_seen": 0.0})
        a["requests"] += 1
        if float(e["ts"]) >= a["last_seen"]:
            a["last_seen"] = float(e["ts"])
            a["last_url"] = e["url"]
            if e["user"] != "-":
                a["user"] = e["user"]
    out = list(agg.values())
    for a in out:
        a["age"] = f"{int(time.time()-a['last_seen'])}s ago"
    out.sort(key=lambda x: -x["last_seen"])
    return out


@app.route("/sessions")
@login_required
def sessions_page():
    return render_template("sessions.html",
                           window=config.SESSION_FALLBACK_WINDOW)


@app.route("/api/sessions")
@login_required
def api_sessions():
    try:
        live = sessions_from_cachemgr()
        return jsonify({"source": "cache-manager", "sessions": live})
    except Exception:
        pass
    return jsonify({"source": "access-log",
                    "window": config.SESSION_FALLBACK_WINDOW,
                    "sessions": sessions_from_log()})


# ------------------------------------------------------------------- dashboard
_prev = {"cpu": None, "net": None}


def read_cpu():
    with open("/proc/stat") as f:
        parts = f.readline().split()[1:]
    nums = [int(x) for x in parts]
    idle = nums[3] + (nums[4] if len(nums) > 4 else 0)
    return sum(nums), idle


def cpu_percent():
    total, idle = read_cpu()
    prev = _prev["cpu"]
    _prev["cpu"] = (total, idle)
    if not prev:
        time.sleep(0.25)
        total2, idle2 = read_cpu()
        _prev["cpu"] = (total2, idle2)
        prev, total, idle = (total, idle), total2, idle2
    dt, di = total - prev[0], idle - prev[1]
    return round(100.0 * (1 - di / dt), 1) if dt > 0 else 0.0


def mem_info():
    info = {}
    with open("/proc/meminfo") as f:
        for line in f:
            k, v = line.split(":", 1)
            info[k] = int(v.strip().split()[0])  # kB
    total = info.get("MemTotal", 1)
    avail = info.get("MemAvailable", 0)
    used = total - avail
    return {"total_mb": total // 1024, "used_mb": used // 1024,
            "percent": round(100.0 * used / total, 1)}


def net_counters():
    rx = tx = 0
    with open("/proc/net/dev") as f:
        for line in f.readlines()[2:]:
            iface, data = line.split(":", 1)
            if iface.strip() == "lo":
                continue
            v = data.split()
            rx += int(v[0]); tx += int(v[8])
    return rx, tx


def net_rate():
    rx, tx = net_counters()
    now = time.time()
    prev = _prev["net"]
    _prev["net"] = (now, rx, tx)
    if not prev or now - prev[0] <= 0:
        return {"rx_bps": 0, "tx_bps": 0, "rx_total": rx, "tx_total": tx}
    dt = now - prev[0]
    return {"rx_bps": max(0, int((rx - prev[1]) / dt)),
            "tx_bps": max(0, int((tx - prev[2]) / dt)),
            "rx_total": rx, "tx_total": tx}


def squid_info():
    info = {"status": "unknown", "since": "", "version": "", "rss_mb": None}
    try:
        r = subprocess.run(["systemctl", "is-active", "squid"],
                           capture_output=True, text=True, timeout=5)
        info["status"] = r.stdout.strip() or "unknown"
    except Exception:
        pass
    try:
        r = subprocess.run(["systemctl", "show", "squid", "-p",
                            "ActiveEnterTimestamp", "-p", "MainPID"],
                           capture_output=True, text=True, timeout=5)
        pid = None
        for line in r.stdout.splitlines():
            if line.startswith("ActiveEnterTimestamp=") and "=" in line:
                ts = line.split("=", 1)[1].strip()
                info["since"] = " ".join(ts.split()[1:3]) if ts else ""
            if line.startswith("MainPID="):
                pid = int(line.split("=", 1)[1] or 0) or None
        if pid:
            with open(f"/proc/{pid}/status") as f:
                for line in f:
                    if line.startswith("VmRSS:"):
                        info["rss_mb"] = int(line.split()[1]) // 1024
                        break
    except Exception:
        pass
    try:
        r = subprocess.run([config.SQUID_BIN, "-v"], capture_output=True,
                           text=True, timeout=5)
        first = r.stdout.splitlines()[0] if r.stdout else ""
        m = re.search(r"Version ([\w.]+)", first)
        info["version"] = m.group(1) if m else ""
    except Exception:
        pass
    return info


def log_files():
    """access.log plus rotated siblings (access.log.1, access.log.2.gz...),
    newest first."""
    files = [config.ACCESS_LOG]
    files += sorted(glob.glob(config.ACCESS_LOG + ".*"))
    return [f for f in files if os.path.exists(f)]


def reverse_lines(path, max_bytes=64 * 1024 * 1024):
    """Yield lines of a plain file from the end, without loading it fully."""
    with open(path, "rb") as f:
        f.seek(0, os.SEEK_END)
        pos = f.tell()
        buf = b""
        read = 0
        while pos > 0 and read < max_bytes:
            step = min(1 << 16, pos)
            pos -= step
            f.seek(pos)
            chunk = f.read(step)
            read += step
            buf = chunk + buf
            lines = buf.split(b"\n")
            buf = lines[0]
            for ln in reversed(lines[1:]):
                yield ln.decode("utf-8", "replace")
        if buf:
            yield buf.decode("utf-8", "replace")


def traffic_totals():
    """Proxy bytes/requests in the last 1h and 24h, reading newest-first and
    stopping as soon as entries get older than 24h (fast on big logs)."""
    now = time.time()
    h1, d24 = now - 3600, now - 86400
    t = {"h1_bytes": 0, "h1_req": 0, "d24_bytes": 0, "d24_req": 0}
    done = False
    for path in log_files():
        if done:
            break
        if path.endswith(".gz"):
            try:
                with gzip.open(path, "rt", errors="replace") as f:
                    for line in f:
                        m = LOG_LINE.match(line)
                        if not m or float(m.group("ts")) < d24:
                            continue
                        ts, b = float(m.group("ts")), int(m.group("bytes"))
                        t["d24_bytes"] += b; t["d24_req"] += 1
                        if ts >= h1:
                            t["h1_bytes"] += b; t["h1_req"] += 1
            except OSError:
                pass
            continue
        for line in reverse_lines(path):
            m = LOG_LINE.match(line)
            if not m:
                continue
            ts = float(m.group("ts"))
            if ts < d24:
                done = True
                break
            b = int(m.group("bytes"))
            t["d24_bytes"] += b; t["d24_req"] += 1
            if ts >= h1:
                t["h1_bytes"] += b; t["h1_req"] += 1
    return t


def iter_log_entries(t_from, t_to):
    """All parsed access-log entries with t_from <= ts < t_to, across
    current + rotated (+ gzipped) files."""
    for path in log_files():
        opener = gzip.open if path.endswith(".gz") else open
        try:
            with opener(path, "rt", errors="replace") as f:
                for line in f:
                    m = LOG_LINE.match(line)
                    if not m:
                        continue
                    ts = float(m.group("ts"))
                    if t_from <= ts < t_to:
                        yield m.groupdict()
        except OSError:
            continue


def log_hour_stats():
    lines = tail_lines(config.ACCESS_LOG, config.LOG_MAX_LINES) or []
    cutoff = time.time() - 3600
    req = denied = byts = 0
    clients = set()
    for e in parse_log_lines(lines):
        if float(e["ts"]) < cutoff:
            continue
        req += 1
        byts += int(e["bytes"])
        clients.add(e["client"])
        if e["denied"]:
            denied += 1
    return {"requests": req, "denied": denied, "bytes": byts,
            "clients": len(clients)}


@app.route("/")
@app.route("/dashboard")
@login_required
def dashboard():
    return render_template("dashboard.html")


@app.route("/api/stats")
@login_required
def api_stats():
    disk = os.statvfs("/")
    disk_total = disk.f_blocks * disk.f_frsize
    disk_free = disk.f_bavail * disk.f_frsize
    try:
        sess = sessions_from_cachemgr()
        sess_count, sess_src = len(sess), "cache-manager"
    except Exception:
        sess = sessions_from_log()
        sess_count, sess_src = len(sess), "access-log"
    return jsonify({
        "cpu": cpu_percent(),
        "mem": mem_info(),
        "disk": {"total_gb": round(disk_total / 1e9, 1),
                 "used_gb": round((disk_total - disk_free) / 1e9, 1),
                 "percent": round(100.0 * (disk_total - disk_free) / disk_total, 1)},
        "net": net_rate(),
        "sessions": {"count": sess_count, "source": sess_src},
        "squid": squid_info(),
        "hour": log_hour_stats(),
        "traffic": traffic_totals(),
        "cert": cert_manager.inspect_current(),
        "ssl_on": ssl_on(),
        "license": license_status(),
        "uptime": float(open("/proc/uptime").read().split()[0]),
        "load": os.getloadavg()[0],
    })


# -------------------------------------------------------------------- reports
def csv_safe(v):
    v = str(v)
    return "'" + v if v[:1] in "=+-@" else v


def parse_report_dates():
    try:
        d_from = datetime.strptime(request.form["date_from"], "%Y-%m-%d")
        d_to = datetime.strptime(request.form["date_to"], "%Y-%m-%d")
    except (KeyError, ValueError):
        return None, None
    if d_to < d_from:
        d_from, d_to = d_to, d_from
    return d_from.timestamp(), (d_to + timedelta(days=1)).timestamp()


def host_of(url):
    h = re.sub(r"^[a-z]+://", "", url).split("/")[0]
    return h.rsplit(":", 1)[0] if re.search(r":\d+$", h) else h


def access_filter():
    client = request.form.get("client", "").strip()
    user = request.form.get("user", "").strip().lower()
    domain = request.form.get("domain", "").strip().lower()
    denied = request.form.get("denied_only") == "on"

    def keep(e):
        if client and not e["client"].startswith(client):
            return False
        if user and user not in e["user"].lower():
            return False
        if domain and domain not in e["url"].lower():
            return False
        if denied and "DENIED" not in e["result"]:
            return False
        return True
    return keep


@app.route("/reports", methods=["GET"])
@login_required
def reports():
    today = datetime.now().date()
    return render_template("reports.html",
                           d_to=today.isoformat(),
                           d_from=(today - timedelta(days=6)).isoformat(),
                           result=None)


@app.route("/reports/generate", methods=["POST"])
@login_required
def reports_generate():
    rtype = request.form.get("rtype", "access")
    t_from, t_to = parse_report_dates()
    if t_from is None:
        flash("Choose valid From and To dates.", "error")
        return redirect(url_for("reports"))
    out = request.form.get("output", "view")
    span = f"{request.form['date_from']}_to_{request.form['date_to']}"

    if rtype == "audit":
        rows = get_db().execute(
            "SELECT ts, username, action, detail FROM audit "
            "WHERE ts >= ? AND ts < ? ORDER BY id",
            (datetime.fromtimestamp(t_from).isoformat(timespec="seconds"),
             datetime.fromtimestamp(t_to).isoformat(timespec="seconds"))).fetchall()
        header = ["Time", "GUI User", "Action", "Detail"]
        data = [[r["ts"], r["username"], r["action"], r["detail"]] for r in rows]

    elif rtype == "activity":
        keep = access_filter()
        agg = {}
        for e in iter_log_entries(t_from, t_to):
            if not keep(e):
                continue
            key = (e["client"], e["user"])
            a = agg.setdefault(key, {"req": 0, "denied": 0, "bytes": 0, "domains": {}})
            a["req"] += 1
            a["bytes"] += int(e["bytes"])
            if "DENIED" in e["result"]:
                a["denied"] += 1
            h = host_of(e["url"])
            a["domains"][h] = a["domains"].get(h, 0) + 1
        header = ["Client IP", "Proxy User", "Requests", "Denied", "MB Transferred", "Top Sites"]
        data = []
        for (client, user), a in sorted(agg.items(), key=lambda kv: -kv[1]["bytes"]):
            top = ", ".join(f"{d}({n})" for d, n in
                            sorted(a["domains"].items(), key=lambda x: -x[1])[:5])
            data.append([client, user, a["req"], a["denied"],
                         round(a["bytes"] / 1e6, 2), top])

    else:  # website access log
        keep = access_filter()
        header = ["Time", "Client IP", "Proxy User", "Result", "Method", "URL", "Bytes"]

        def gen_rows():
            for e in iter_log_entries(t_from, t_to):
                if keep(e):
                    yield [datetime.fromtimestamp(float(e["ts"])).strftime("%Y-%m-%d %H:%M:%S"),
                           e["client"], e["user"], e["result"], e["method"],
                           e["url"], e["bytes"]]
        if out == "csv":
            def stream():
                buf = _io.StringIO()
                w = _csv.writer(buf)
                w.writerow(header)
                for row in gen_rows():
                    w.writerow([csv_safe(v) for v in row])
                    if buf.tell() > 65536:
                        yield buf.getvalue(); buf.seek(0); buf.truncate()
                yield buf.getvalue()
            audit("report", f"access CSV {span}")
            return Response(stream_with_context(stream()), mimetype="text/csv",
                            headers={"Content-Disposition":
                                     f"attachment; filename=access_report_{span}.csv"})
        data = []
        truncated = False
        for row in gen_rows():
            data.append(row)
            if len(data) >= 500:
                truncated = True
                break
        audit("report", f"access view {span}")
        return render_template("reports.html", result={"header": header, "rows": data,
                               "truncated": truncated, "rtype": rtype},
                               d_from=request.form["date_from"], d_to=request.form["date_to"])

    # audit / activity: small enough to build fully
    if out == "csv":
        buf = _io.StringIO()
        w = _csv.writer(buf)
        w.writerow(header)
        for row in data:
            w.writerow([csv_safe(v) for v in row])
        audit("report", f"{rtype} CSV {span}")
        return Response(buf.getvalue(), mimetype="text/csv",
                        headers={"Content-Disposition":
                                 f"attachment; filename={rtype}_report_{span}.csv"})
    audit("report", f"{rtype} view {span}")
    return render_template("reports.html", result={"header": header,
                           "rows": data[:500], "truncated": len(data) > 500,
                           "rtype": rtype},
                           d_from=request.form["date_from"], d_to=request.form["date_to"])


# ----------------------------------------------------------------------- misc
def load_settings():
    s = {"app_title": config.APP_TITLE, "app_subtitle": config.APP_SUBTITLE,
         "logo_file": config.LOGO_FILE}
    s.update(ad_auth.DEFAULTS)
    s.update(mailer.DEFAULTS)
    s.update(scheduler.DEFAULTS)
    s.update(dr_sync._dr_defaults())
    if os.path.exists(config.SETTINGS_FILE):
        try:
            s.update(json.load(open(config.SETTINGS_FILE)))
        except Exception:
            pass
    return s


def save_settings(s):
    with open(config.SETTINGS_FILE, "w") as f:
        json.dump(s, f, indent=2)


def ssl_on():
    s = load_settings()
    if "ssl_enabled" in s:
        return bool(s["ssl_enabled"])
    return config.SSL_ENABLED


@app.context_processor
def inject_globals():
    s = load_settings()
    logo = None
    if s.get("logo_file") and os.path.exists(
            os.path.join(app.static_folder, s["logo_file"])):
        logo = s["logo_file"]
    return {"now": datetime.now, "cfg": config, "logo": logo,
            "app_title": s["app_title"], "app_subtitle": s["app_subtitle"],
            "csrf_token": session.get("csrf", ""),
            "lic": license_status() if session.get("uid") else None}


@app.template_filter("timestamp_fmt")
def timestamp_fmt(ts):
    return datetime.fromtimestamp(ts).strftime("%d-%b %H:%M")


@app.errorhandler(403)
def forbidden(e):
    return render_template("base.html", error_403=True), 403


# Runs at import time too, so gunicorn/systemd gets a ready database
init_db()
if not os.path.exists(config.BRANCH_MAP):
    save_branches(OrderedDict())
if not os.path.exists(config.NETWORK_MAP):
    save_network({"safe_ports": [], "ssl_ports": [], "full_access": []})
try:
    generate_conf()
except PermissionError:
    print(f"[warn] cannot write {config.GEN_CONF} - check ACL_DIR permissions")


# ------------------------------------------------------- scheduled jobs
def _scheduled_backup_job(cfg):
    """Create a backup and, if configured, email it. Runs on the scheduler
    thread (no request context), so it audits via audit_system()."""
    try:
        path, fname = backup_manager.create("scheduled")
    except Exception as e:
        audit_system("backup-scheduled", f"FAILED: {e}"[:180])
        return
    audit_system("backup-scheduled", fname)
    backup_manager.prune(int(cfg.get("backup_keep", 10) or 10))
    if cfg.get("backup_email"):
        s = load_settings()
        if mailer.is_configured(s):
            ok, msg = mailer.send(
                s, f"[BT Proxy] Scheduled backup - {socket.gethostname()}",
                "Attached is the scheduled BT Proxy configuration backup.\n\n"
                "IMPORTANT: this archive contains password hashes, MFA secrets "
                "and the key that decrypts stored service passwords. Store it "
                "securely and do not forward it.\n",
                attachment=(path, fname))
            audit_system("backup-email", "ok" if ok else f"FAILED: {msg}"[:150])


def _daily_checks():
    """Once-a-day expiry warnings by email (certificate, license)."""
    s = load_settings()
    if not mailer.is_configured(s):
        return
    host = socket.gethostname()
    # certificate expiry
    try:
        if s.get("alert_cert", True):
            info = cert_manager.inspect_current()
            if info and info.get("days_left") is not None and info["days_left"] <= 30:
                mailer.send(s, f"[BT Proxy] Certificate expires in "
                               f"{info['days_left']} day(s) - {host}",
                            mailer.alert_body(host, "cert-expiring",
                                              f"SSL certificate expires {info.get('not_after','?')}",
                                              "system",
                                              datetime.now().strftime("%Y-%m-%d %H:%M:%S")))
    except Exception:
        pass
    # license expiry
    try:
        if s.get("alert_license", True):
            st = license_status()
            if st and not st.get("trial") and st.get("days_left") is not None \
                    and st["days_left"] <= 14:
                mailer.send(s, f"[BT Proxy] License expires in "
                               f"{st['days_left']} day(s) - {host}",
                            mailer.alert_body(host, "license-expiring",
                                              f"License expires {st.get('expires','?')}",
                                              "system",
                                              datetime.now().strftime("%Y-%m-%d %H:%M:%S")))
    except Exception:
        pass


try:
    scheduler.start(app, load_settings, _scheduled_backup_job, _daily_checks,
                    run_dr_sync=lambda: dr_push("periodic"))
except Exception as e:
    print(f"[warn] scheduler did not start: {e}")

if __name__ == "__main__":
    ssl_ctx = None
    if ssl_on() and os.path.exists(config.SSL_CERT):
        ssl_ctx = (config.SSL_CERT, config.SSL_KEY)
    app.run(host=config.LISTEN_HOST, port=config.LISTEN_PORT, ssl_context=ssl_ctx)
