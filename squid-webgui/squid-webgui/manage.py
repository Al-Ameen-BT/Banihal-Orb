#!/usr/bin/env python3
"""
BT Proxy - emergency server-side management CLI.
Run on the server as root or the squidui user (needs write access to squidui.db).

  User accounts
    manage.py list                          list users, roles, MFA/lock status
    manage.py create-admin <username>       create a new admin (prompts for password)
    manage.py promote <username>            make an existing user an admin
    manage.py reset-password <username>     set a new password (forces change at login)
    manage.py reset-mfa <username>          turn MFA off so the user can log in again
    manage.py unlock <username>             clear login-failure lockout for one user
    manage.py unlock-all                    clear all login-failure lockouts

  System
    manage.py status                        app/squid/license/config overview
    manage.py license                       show license details
    manage.py regen-conf                    rebuild the Squid include file from stored data

  Certificates / HTTPS  (escape hatch when a bad cert locks the GUI)
    manage.py cert-restore                  restore the most recent cert backup
    manage.py ssl-off                       disable HTTPS (revert to http) and exit
    manage.py backup [note]                 create a configuration backup now
    manage.py backup-list                   list backups on this server
    manage.py restore <file>                restore a backup (asks to confirm)
    manage.py factory-reset                 erase all config/data (asks to confirm)

Notes:
  - reset-password intentionally bypasses the GUI password policy (emergency use).
  - Every action is written to the audit log and forwarded to syslog if enabled.
"""
import getpass
import os
import sqlite3
import subprocess
import sys
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import config
from werkzeug.security import generate_password_hash


def db():
    conn = sqlite3.connect(config.DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def audit(conn, action, detail):
    conn.execute("INSERT INTO audit (ts, username, action, detail) VALUES (?,?,?,?)",
                 (datetime.now().isoformat(timespec="seconds"), "CLI", action, detail))


def ask_password(prompt="New password"):
    p1 = getpass.getpass(f"{prompt} (min 8 chars): ")
    if len(p1) < 8:
        print("Password too short.")
        sys.exit(1)
    if p1 != getpass.getpass("Repeat: "):
        print("Passwords do not match.")
        sys.exit(1)
    return p1


def user_row(conn, name):
    row = conn.execute("SELECT * FROM users WHERE username=?", (name,)).fetchone()
    if not row:
        print(f"No such user: {name}")
        sys.exit(1)
    return row


def cmd_list(conn):
    since = (datetime.now() - timedelta(minutes=config.LOGIN_LOCK_MIN)
             ).isoformat(timespec="seconds")
    print(f"{'USERNAME':<20} {'ROLE':<10} FLAGS")
    print("-" * 60)
    for r in conn.execute("SELECT * FROM users ORDER BY role, username"):
        flags = []
        if r["mfa_enabled"]:
            flags.append("MFA")
        if r["must_change"]:
            flags.append("pw-change-pending")
        n = conn.execute("SELECT COUNT(*) c FROM login_fails WHERE ts > ? AND username=?",
                         (since, r["username"])).fetchone()["c"]
        if n >= config.LOGIN_MAX_FAILS:
            flags.append("LOCKED-OUT")
        elif n:
            flags.append(f"{n} recent fail(s)")
        print(f"{r['username']:<20} {r['role']:<10} {' '.join(flags)}")


def cmd_license(conn, brief=False):
    try:
        import app
        st = app.license_status()
    except Exception as e:
        print(f"License          : could not read ({e})")
        return
    state = "EXPIRED" if st["expired"] else ("Trial" if st["trial"] else "Licensed")
    print(f"License          : {state} - {st['customer']}, expires {st['expires']} "
          f"({st['days_left']} days)")
    if not brief and st["expired"]:
        print("  Access Lists and Network Rules are READ-ONLY until a valid key is entered.")


def cmd_status(conn):
    print(f"BT Proxy version : {config.APP_VERSION}")
    print(f"GUI port         : {config.LISTEN_PORT}  (SSL {'ON' if config.SSL_ENABLED else 'off'})")
    print(f"Database         : {config.DB_PATH}")
    print(f"Squid conf       : {config.SQUID_CONF}")
    print(f"Generated ACLs   : {config.GEN_CONF}"
          f"{'' if os.path.exists(config.GEN_CONF) else '   [MISSING]'}")
    print(f"Access log       : {config.ACCESS_LOG}"
          f"{'' if os.path.exists(config.ACCESS_LOG) else '   [MISSING]'}")
    for svc in ("squid", "squid-webgui"):
        try:
            r = subprocess.run(["systemctl", "is-active", svc],
                               capture_output=True, text=True, timeout=5)
            print(f"{svc:<17}: {r.stdout.strip() or 'unknown'}")
        except Exception as e:
            print(f"{svc:<17}: could not query ({e})")
    n_users = conn.execute("SELECT COUNT(*) c FROM users").fetchone()["c"]
    n_admin = conn.execute("SELECT COUNT(*) c FROM users WHERE role='admin'").fetchone()["c"]
    print(f"Users            : {n_users} ({n_admin} admin)")
    cmd_license(conn, brief=True)


def cmd_regen(conn):
    import app
    app.generate_conf()
    print(f"Regenerated {config.GEN_CONF}")
    ok = subprocess.run(["sudo", "-n", config.SQUID_BIN, "-k", "parse"],
                        capture_output=True, text=True)
    if ok.returncode == 0:
        print("squid -k parse: OK. Run 'sudo squid -k reconfigure' to apply.")
    else:
        print("squid -k parse FAILED:")
        print((ok.stdout + ok.stderr)[-600:])
    audit(conn, "cli-regen-conf", "regenerated include file")


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    cmd = sys.argv[1]
    conn = db()

    if cmd == "list":
        cmd_list(conn)
    elif cmd == "status":
        cmd_status(conn)
    elif cmd == "license":
        cmd_license(conn)
    elif cmd == "regen-conf":
        cmd_regen(conn)
        conn.commit()
    elif cmd == "cert-restore":
        import cert_manager
        ok, msg = cert_manager.restore_backup()
        print(msg)
        audit(conn, "cli-cert-restore", msg[:120]); conn.commit()
        print("Restart the service: sudo systemctl restart squid-webgui")
    elif cmd == "ssl-off":
        import json
        s = {}
        if os.path.exists(config.SETTINGS_FILE):
            s = json.load(open(config.SETTINGS_FILE))
        s["ssl_enabled"] = False
        json.dump(s, open(config.SETTINGS_FILE, "w"), indent=2)
        audit(conn, "cli-ssl-off", "disabled HTTPS"); conn.commit()
        print("HTTPS disabled. Restart the service: sudo systemctl restart squid-webgui")
    elif cmd == "backup":
        import backup_manager
        note = sys.argv[2] if len(sys.argv) > 2 else "cli"
        path, fname = backup_manager.create(note)
        print(f"Backup created: {path}")
        audit(conn, "cli-backup-create", fname); conn.commit()
    elif cmd == "backup-list":
        import backup_manager
        items = backup_manager.list_backups()
        if not items:
            print("No backups found.")
        for b in items:
            print(f"  {b['created']}  {b['size_kb']:>8} KB  {b['name']}")
    elif cmd == "restore":
        import backup_manager
        if len(sys.argv) < 3:
            print("Usage: manage.py restore <backup-file>"); sys.exit(1)
        path = sys.argv[2]
        if not os.path.exists(path):
            print(f"File not found: {path}"); sys.exit(1)
        try:
            info = backup_manager.inspect(path)
        except ValueError as e:
            print(str(e)); sys.exit(1)
        print(f"Backup from {info['hostname']} taken {info['created']} "
              f"(BT Proxy {info['version']}), {info['file_count']} file(s).")
        if input("Restore and REPLACE the current configuration? [y/N] ").lower() != "y":
            print("Cancelled."); sys.exit(0)
        ok, msg = backup_manager.restore(path)
        print(msg)
        audit(conn, "cli-backup-restore", msg[:120]); conn.commit()
    elif cmd == "factory-reset":
        import backup_manager
        print("This erases ALL configuration, users, MFA, audit log and rules.")
        if input('Type RESET to confirm: ').strip() != "RESET":
            print("Cancelled."); sys.exit(0)
        audit(conn, "cli-factory-reset", "initiated from CLI"); conn.commit()
        conn.close()
        ok, msg, snap = backup_manager.factory_reset()
        print(msg)
        print("Restart the service: sudo systemctl restart squid-webgui")
        sys.exit(0 if ok else 1)
    elif cmd == "unlock-all":
        conn.execute("DELETE FROM login_fails")
        audit(conn, "cli-unlock-all", "cleared all lockouts")
        conn.commit()
        print("All login-failure lockouts cleared.")
    elif cmd == "create-admin":
        if len(sys.argv) < 3:
            print("Usage: manage.py create-admin <username>", file=sys.stderr)
            sys.exit(2)
        name = sys.argv[2]
        if conn.execute("SELECT 1 FROM users WHERE username=?", (name,)).fetchone():
            print(f"User {name} already exists. Use 'promote' or 'reset-password'.")
            sys.exit(1)
        p = ask_password()
        now = datetime.now().isoformat(timespec="seconds")
        conn.execute("INSERT INTO users (username, pw_hash, role, must_change, created_at, "
                     "pw_changed_at) VALUES (?,?,'admin',1,?,?)",
                     (name, generate_password_hash(p), now, now))
        audit(conn, "cli-create-admin", name)
        conn.commit()
        print(f"Admin {name} created. Password change is forced at first login.")
    elif cmd in ("reset-password", "reset-mfa", "unlock", "promote"):
        if len(sys.argv) < 3:
            print(f"Usage: manage.py {cmd} <username>", file=sys.stderr)
            sys.exit(2)
        name = sys.argv[2]
        row = user_row(conn, name)
        if cmd == "reset-password":
            p = ask_password()
            now = datetime.now().isoformat(timespec="seconds")
            conn.execute("UPDATE users SET pw_hash=?, must_change=1, pw_changed_at=? WHERE id=?",
                         (generate_password_hash(p), now, row["id"]))
            conn.execute("DELETE FROM login_fails WHERE username=?", (name,))
            audit(conn, "cli-reset-password", name)
            print(f"Password reset for {name}. Must change at next login. Lockout cleared.")
        elif cmd == "reset-mfa":
            conn.execute("UPDATE users SET totp_secret=NULL, mfa_enabled=0 WHERE id=?",
                         (row["id"],))
            audit(conn, "cli-reset-mfa", name)
            print(f"MFA disabled for {name}. They can log in with password only and re-enroll.")
        elif cmd == "unlock":
            conn.execute("DELETE FROM login_fails WHERE username=?", (name,))
            audit(conn, "cli-unlock", name)
            print(f"Lockout cleared for {name}.")
        elif cmd == "promote":
            conn.execute("UPDATE users SET role='admin' WHERE id=?", (row["id"],))
            audit(conn, "cli-promote", name)
            print(f"{name} is now an admin.")
        conn.commit()
    else:
        import difflib
        known = ["list", "create-admin", "promote", "reset-password", "reset-mfa",
                 "unlock", "unlock-all", "status", "license", "regen-conf",
                 "cert-restore", "ssl-off", "backup", "backup-list", "restore",
                 "factory-reset"]
        print(f"Unknown command: {cmd!r}", file=sys.stderr)
        near = difflib.get_close_matches(cmd, known, n=3, cutoff=0.6)
        if near:
            print("Did you mean:  " + "   ".join(near), file=sys.stderr)
        print("Run 'manage.py' with no arguments to see all commands.",
              file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
