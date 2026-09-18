# BT Proxy — Email Alerts, Backup & Restore, Factory Reset

**Version 1.12.10** · Banihal Technologies LLP

---

## Part 1 — Email alerts (SMTP)

### Configure

**Settings → Email alerts (SMTP)**

| Field | Notes |
|---|---|
| Enable email alerting | Master switch |
| SMTP server / Port | e.g. `smtp.example.com`, 587 |
| Security | STARTTLS (587), SSL/TLS (465), or None (25) |
| Verify TLS certificate | Leave **on**; untick only for an internal server with a self-signed certificate |
| Username / Password | Password is stored **encrypted** (with `secret.key`) |
| From address | The sender the mail server permits |
| Send alerts to | One or more recipients, comma separated |

Click **Save email settings**, then **Send test email**. The test reports the
exact SMTP error if it fails.

### Choosing the right server

**Preferred for banks: the customer's internal mail relay** — typically port
25, Security = `None`, username and password left blank, with the proxy
server's IP allowlisted on the relay. Alerts and backup emails then never
leave the customer's own network, and there is no cloud provider
authentication policy to break later.

If a Microsoft 365 account must be used, **the hostname depends on the account
type** — using the wrong one produces an authentication failure that looks
exactly like a wrong password:

| Account type | SMTP server | Port / Security |
|---|---|---|
| Microsoft 365 **organisation** mailbox | `smtp.office365.com` | 587 / STARTTLS |
| Personal Outlook.com / Hotmail / Live | `smtp-mail.outlook.com` | Not usable — see below |
| Google Workspace / Gmail | `smtp.gmail.com` | 587 / STARTTLS, App Password required |

Notes:

- The quickest check at any site: **ask what SMTP server the customer's other
  alerting systems already use, and copy it exactly.**
- The username is always the **full email address**.
- For an M365 organisation mailbox, SMTP AUTH must be enabled on that mailbox
  by the tenant admin (disabled by default on newer tenants):
  `Set-CASMailbox -Identity alerts@customer.example -SmtpClientAuthenticationDisabled $false`
- **Personal Outlook.com accounts cannot be used.** Microsoft requires OAuth2
  for SMTP on consumer mailboxes; passwords and App Passwords are both
  rejected. There is no setting that changes this.
- For Gmail, the App Password is 16 characters entered **with no spaces**, and
  2-Step Verification must be on.

> **Plan ahead:** Microsoft is retiring password-based SMTP AUTH for Exchange
> Online. When it is switched off, every system alerting through that account
> stops at once — not just BT Proxy. Confirm the current date against the
> customer's own Microsoft 365 Message Center, and prefer an internal relay for
> anything long-lived.

> **Do not use a customer's public webmail account for backup emails.** A
> backup contains `secret.key` and the user database. Send scheduled backups to
> an internal mailbox only, or leave the backup email option off and collect
> backups from the server.

### What raises an alert

Always mailed when email is enabled (security-critical):

- **Account lockout** — repeated failed logins
- **License tampering** — the system clock was rolled back
- **Certificate expiring** — daily from 30 days out
- **Factory reset** — all configuration erased

Optional, per the tick-boxes:

- Access list / network rule changes
- Service or Squid restart failures
- License expiry (daily from 14 days out)

Single failed logins are deliberately not mailed — they are normal noise. The
lockout that follows repeated failures is.

### Notes

- Alerts never contain passwords, license keys or session tokens.
- Sending happens on a background thread — a slow or dead mail server can never
  stall the console or block the action that raised the alert.
- Every send attempt is audit-logged.

---

## Part 2 — Backup & Restore

### What a backup contains

Rules, access lists, sources and modes; network rules; users, roles, MFA
enrolments and the audit log; settings; imported dependency lists; the branch
ACL files; and `secret.key`. It does **not** contain the program files (those
come from the installation package) or `squid.conf`.

> **A backup is a secret.** It holds password hashes, MFA secrets and the key
> that decrypts stored service passwords — it is effectively this server's
> identity. Files are written mode 0600. Store downloads securely; do not email
> them to personal accounts or leave them on shared drives.

### Create a backup

**Backup & Restore → Create backup now** (add a note, e.g. "before adding
department rules"), then **Download** and keep it off-server.

CLI:

```bash
btp backup "before update"
btp backup-list
```

### Automatic backups

**Backup & Restore → Automatic backup schedule**

- **Run**: off / daily / weekly / monthly
- **At**: server local time (verify the timezone with `timedatectl`)
- **Weekday** / **Day of month** for weekly/monthly
- **Keep last**: older archives are pruned automatically
- **Email each scheduled backup**: attaches the archive to an email

Scheduled runs appear in the audit log as `backup-scheduled`.

### Restore

**Backup & Restore → Restore from a backup**

1. Upload the archive → **Check backup**
2. Review what it contains (when it was taken, from which server, which version)
3. Enter your **admin password** and confirm

BT Proxy validates the manifest and **every file's checksum before writing
anything** — a corrupt or altered archive is rejected. A snapshot of the current
configuration is saved first (under `backups/_snapshots/`), and the service
restarts afterwards. Click **Reload Squid** when it returns.

CLI:

```bash
btp restore /path/to/btproxy-backup-<host>-<timestamp>.tar.gz
```

> Restoring replaces users and MFA enrolments. You will need the credentials
> from the backup, not the ones in use now.

---

## Part 3 — Factory reset

**Backup & Restore → Factory reset**

Erases all rules, access lists, network rules, users, MFA enrolments, the audit
log, settings, imported lists and the SSL certificate. The console returns to
first-run setup (`admin` / `admin@123`). Squid's own `squid.conf` is **not**
touched, and neither are the program files.

To proceed you must:

1. Enter your **admin password** (a local admin — AD accounts cannot be
   re-verified for this)
2. Type **`RESET`** in the confirmation box

A snapshot is written to `backups/_snapshots/` before anything is erased, and
the reset is audit-logged and emailed (if email is on) *before* the database is
removed.

**Take and download a backup first.** The snapshot lives on the same server; if
the server is lost, so is it.

CLI:

```bash
btp factory-reset          # asks you to type RESET
sudo systemctl restart squid-webgui
```

### After a reset

1. Restart the service
2. Log in with `admin` / `admin@123` and set a new password
3. Re-activate the license, re-configure settings, re-create rules
4. Re-add the Squid include line if `/etc/squid/acls/` was cleared:

```bash
sudo squid -k parse 2>&1 | grep -nE "webgui_generated|deny all"
```

---

© Banihal Technologies LLP — BT Proxy v1.12.10
