# BT Proxy — Troubleshooting & CLI Guide

**Version 1.12.10** · Banihal Technologies LLP

CLI prefix (or use the `btp` shortcut):

```bash
cd /opt/squid-webgui
sudo -u squidui ./venv/bin/python manage.py <command>
```

---

## 1. FIRST CHECK — everything is denied / no rule works

This is the most common problem on a new install, and it is almost never a
software fault. Squid must be told to read BT Proxy's rules, **above** its
catch-all deny:

```bash
sudo squid -k parse 2>&1 | grep -nE "webgui_generated|_net|deny all"
```

You must see the include and your rules **before** `http_access deny all`:

```
Processing: include /etc/squid/acls/webgui_generated.conf
Processing: acl ho_net src 10.1.0.0/24
Processing: http_access allow ho_net ho_whitelist
Processing: http_access deny all              <-- your rules are ABOVE this
```

If the include line is missing, or appears **after** `http_access deny all`,
every request is denied before your rules are ever evaluated. Fix:

```bash
sudo nano /etc/squid/squid.conf
```

Place `include /etc/squid/acls/webgui_generated.conf` immediately **above**
`http_access deny all`, then:

```bash
sudo squid -k parse && sudo squid -k reconfigure
```

## 2. Service control

```bash
sudo systemctl status  squid-webgui --no-pager
sudo systemctl restart squid-webgui
sudo journalctl -u squid-webgui -n 40 --no-pager    # first stop for any failure
```

Foreground run to see a real traceback:

```bash
sudo systemctl stop squid-webgui
cd /opt/squid-webgui
sudo -u squidui ./venv/bin/gunicorn -c gunicorn_conf.py app:app
# Ctrl+C, then: sudo systemctl start squid-webgui
```

## 3. CLI commands

```
btp status                     app/squid/license/config overview
btp list                       users, roles, MFA and lockout status
btp create-admin <user>        create an admin (nobody can log in)
btp promote <user>             make a user an admin
btp reset-password <user>      set a new password (forces change, clears lockout)
btp reset-mfa <user>           turn MFA off so the user can re-enroll
btp unlock <user> / unlock-all clear login lockouts
btp regen-conf                 rebuild and parse-check the Squid include file
btp license                    show license details
btp cert-restore               restore the most recent certificate backup
btp ssl-off                    disable HTTPS (revert to http)
btp backup [note]              create a configuration backup now
btp backup-list                list backups on this server
btp restore <file>             restore a backup (asks to confirm)
btp factory-reset              erase all config/data (asks to confirm)
```

Every CLI action is audit-logged as user `CLI` and forwarded to syslog/Wazuh.

## 4. Account recovery

```bash
btp list                       # who exists, who is locked out
btp reset-password admin       # prompts twice, clears lockout
btp reset-mfa <user>           # lost phone
btp unlock <user>
btp create-admin rescue        # nobody can get in at all
```

## 5. A site is blocked but it is in the whitelist

Almost always one of these:

**The site needs more domains than you whitelisted.** A page pulls content from
other domains (CDNs, APIs, fonts). Watch what is actually denied while loading
the site:

```bash
sudo tail -f /var/log/squid/access.log
```

`TCP_DENIED/403` lines name the domain that was refused. Add the ones the site
genuinely needs (Access Lists → Dependency Finder makes this easier). Ignore
browser noise — telemetry and search-suggestion domains appear constantly and
should stay denied.

**Testing with a complex site.** Use a simple page to prove the mechanism works
(one self-contained domain, plain HTTP) before testing a large site that loads
many domains.

**The client is not in the rule's source range.** The log shows the client IP:

```bash
sudo tail -20 /var/log/squid/access.log | awk '{print $3}' | sort -u
```

Confirm that IP falls inside the rule's sources.

**The include is missing or misplaced** — see section 1.

## 6. Access rules not behaving as expected

**A department/host rule is ignored, users get the wider subnet's access:**

```bash
btp regen-conf
sudo squid -k reconfigure
grep -nE "http_access|_net src" /etc/squid/acls/webgui_generated.conf
```

The narrow rule must appear **above** the broad one (BT Proxy emits
most-specific-source first). If a department PC is not matched at all, its IP
has probably changed — IP-based rules need static IPs or DHCP reservations.

## 7. Email alerts not arriving

**Settings → Email alerts → Send test email** reports the exact SMTP error.
Read it before changing anything — it distinguishes the three failure types:

**a) "Cannot resolve the mail server name X"** — a DNS/name problem; no
connection was attempted. Check the host field contains a bare hostname (no
`http://`, no `:587` appended) and that the server can resolve it:

```bash
getent hosts smtp.office365.com     # the host you configured
cat /etc/resolv.conf
```

**b) "Resolved X but could not connect on port N"** — the name is fine, the
path is not. Check the port, the security mode (587 = STARTTLS, 465 = SSL,
25 = None) and any firewall in between:

```bash
nc -vz smtp.office365.com 587
```

**c) "SMTP authentication failed (5xx): ..."** — the message includes the mail
server's own words. Most authentication failures are **not** a wrong password:

- **Wrong hostname for the account type.** This is the most common cause and it
  looks exactly like a bad password. A Microsoft 365 organisation mailbox is
  `smtp.office365.com`; `smtp-mail.outlook.com` is the *consumer* Outlook.com
  host and will reject an organisation account. See doc 05 for the full table.
- **Username is not the full email address.**
- **Gmail App Password entered with spaces** — it must be the 16 characters
  with no spaces, and 2-Step Verification must be on.
- **`5.7.139 ... basic authentication is disabled`** — the provider refuses
  password logins for this mailbox entirely. No password will work. Personal
  Outlook.com accounts are permanently in this state. Use an internal relay.
- **SMTP AUTH not enabled on the mailbox** (M365, disabled by default on newer
  tenants) — the tenant admin must run:
  `Set-CASMailbox -Identity <mailbox> -SmtpClientAuthenticationDisabled $false`

> **Fastest check at any site:** ask what SMTP server the customer's existing
> alerting systems already use, and copy it exactly.

Other notes:

- A certificate error from an internal mail server can be worked around by
  unticking *verify the mail server's TLS certificate* — do this only on a
  trusted internal network.
- Alerts are best-effort: a mail failure never blocks the action that triggered
  it. Check the audit log for `smtp-test` / `backup-email` results.

## 7b. ACL directory contents

One file per list, plus the generated config:

```
ho_whitelist.txt  ho_blacklist.txt      <- the lists (Squid reads these)
webgui_generated.conf                   <- the rules that reference them
```

`webgui_generated.conf` points at each list by path:

```
acl ho_whitelist dstdomain "/etc/squid/acls/ho_whitelist.txt"
http_access allow ho_net ho_whitelist
```

The list files are managed by BT Proxy. Entries are stored in Squid's
"domain and all subdomains" form, so a domain entered as `google.com` is
stored as `.google.com` — that is expected, not corruption.

**IPs and subnets** entered into a list are *not* stored in the .txt. They live
in `branches.json` and are emitted as `dst` ACLs, because Squid reverse-resolves
IPs inside a `dstdomain` file, making them dead entries. The GUI shows domains
and IPs together regardless.

Editing a .txt by hand takes effect only after an Apply (the GUI rewrites these
files) — edit lists in the GUI.

*(Versions 1.11.1–1.12.3 also wrote `gen_*.txt` companion files. They are
obsolete and are removed automatically on update. A list a rule actually points
at is never deleted, even if it is named `gen_*`.)*

To see exactly what Squid was given:

```bash
sudo grep -E "^# ---- Rule:|^acl |^http_access " /etc/squid/acls/webgui_generated.conf
```

## 8. Scheduled backups not running

- Schedules use the **server's local time** — confirm with `timedatectl`.
- The job runs at most once per day, shortly after the configured time.
- Only one gunicorn worker runs the scheduler (a lock file elects it). If the
  service was restarted at exactly the scheduled minute, the run moves to the
  next day.
- Check the audit log for `backup-scheduled` entries.

## 9. Permissions

```bash
sudo chown -R squidui:squidui /opt/squid-webgui
sudo chown -R squidui:squid /etc/squid/acls && sudo chmod 775 /etc/squid/acls
sudo usermod -aG proxy squidui     # Ubuntu (squid on Rocky)
sudo systemctl restart squid-webgui
sudo visudo -cf /etc/sudoers.d/squidui
```

## 10. Common failures

| Symptom | Cause / fix |
|---|---|
| Everything denied, rules look correct | **Section 1** — the include line |
| Restart fails: "sudo: I'm afraid I can't do that" | Sudoers outdated — recopy `deploy/sudoers-squidui`, chmod 440 |
| Won't start after enabling SSL | `btp ssl-off`, set `SSL_ENABLED=False`, restart; use the Certificates page |
| `ModuleNotFoundError` after update/OS upgrade | Rebuild venv (section 11) |
| `Permission denied: '/home/squidui'` | Old service unit — install the current one, or create the home dir |
| `Not a string: <module 'config'>` | `gunicorn_conf.py` naming clash — see 02-Update.md |
| 500 at login | DB not writable — `sudo chown -R squidui:squidui /opt/squid-webgui` |
| `Start request repeated too quickly` | Read the earlier error; `sudo systemctl reset-failed squid-webgui` |
| Live Log empty | Service account not in the log group (section 9) |
| MFA codes rejected | Server clock drift — `timedatectl`, enable NTP |
| Timestamps wrong in logs/reports | Server timezone — `sudo timedatectl set-timezone <Area/City>`, restart both services |
| Access List shows fewer rules than `.acl` files | Correct — the GUI lists rules from branches.json; deleting a rule leaves its old file. Remove orphans manually. |

## 11. After an OS major-version upgrade

```bash
sudo systemctl stop squid-webgui
cd /opt/squid-webgui
sudo apt install -y python3 python3-venv python3-pip
sudo rm -rf venv && sudo python3 -m venv venv
sudo ./venv/bin/pip install --upgrade pip
sudo ./venv/bin/pip install -r requirements.txt
sudo chown -R squidui:squidui /opt/squid-webgui
sudo systemctl start squid-webgui
```

## 12. Backups

Preferred: **Backup & Restore → Create backup now → Download**, or `btp backup`.

Full server-side archive if you want everything including program files:

```bash
sudo tar czf /root/btproxy-$(date +%F).tar.gz \
  -C /opt/squid-webgui config.py branches.json network.json settings.json squidui.db secret.key certs deplists \
  -C /etc/squid acls squid.conf
```

`secret.key` is required to decrypt the stored AD/SMTP passwords — always
include it, and treat the archive as a secret.

## 13. Reading the audit trail from the CLI

```bash
sudo -u squidui sqlite3 /opt/squid-webgui/squidui.db \
  "SELECT ts, username, action, detail FROM audit ORDER BY id DESC LIMIT 30;"
```

---

© Banihal Technologies LLP — BT Proxy v1.12.10
