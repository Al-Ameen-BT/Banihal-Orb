# BT Proxy — Documentation Set

**Version 1.12.10** · Banihal Technologies LLP

| File | Topic | Audience |
|---|---|---|
| 01-Fresh-Installation.md | Install on a new server | Deployment engineer |
| 02-Update.md | Safe update (GUI and manual) | Engineer / admin |
| 03-Troubleshooting.md | CLI reference, recovery, common failures | Engineer / admin |
| 04-SSL-Installation.md | Self-signed + purchased certificates, HTTPS | Engineer / admin |
| 05-Email-Backup-Reset.md | Email alerts, backup/restore, factory reset | Engineer / admin |
| 06-License-Creation.md | Generating license keys | **Banihal internal** |
| 07-Package-Creation.md | Building `.btpkg` / full packages | **Banihal internal** |
| 08-AD-LDAPS-Integration.md | AD login over verified LDAPS + Tirur record | **Banihal internal** |
| 09-DC-DR-Replication.md | DC-DR high-availability setup, failover & fail-back | **Banihal internal** |

**Give customers 01–05. Documents 06, 07 and 08 are internal** (06/07 describe
signing with the vendor private key; 08 contains a site record and DC-side
certificate steps).

## What's new since 1.12.0

**Access lists (1.12.4–1.12.6)**
- Domains are compiled straight into `webgui_generated.conf`; the confusing
  `gen_*` companion files are gone, and `dstdomain` references each list file
  directly. List files are canonical — normalised on save, IPs kept separate.
- **Bulk upload** a list from a text file, and **bulk delete** with select-all.
- New rules default to **Exclusive** (whitelist-only) — they fail closed.
- The "include subdomains" choice is real again: ticked stores `.example.com`
  (domain + subdomains), unticked stores the exact host.

**Email diagnostics (1.12.1–1.12.2)**
- The SMTP test names the real failure — DNS vs connection vs authentication —
  and shows the mail server's own reason. Microsoft 365 organisation mailboxes
  use `smtp.office365.com`; consumer Outlook.com is not usable.

**Active Directory (1.12.8–1.12.10)** — see doc 08
- **StartTLS (389)** mode in addition to LDAPS (636); the connection test
  diagnoses TLS-handshake resets and distinguishes closed ports from refused TLS.
- **AD users can't have their password reset locally** (AD owns it); MFA
  enrolment and reset remain fully available for AD users.
- **AD logins are one account** — `user` and `user@domain` (any casing) resolve
  to a single account keyed on the sAMAccountName, so MFA cannot be bypassed by
  using the other login form. Existing duplicates merge automatically.

**CLI (1.12.7)**
- An unrecognised `manage.py` / `btp` command reports the error with a
  did-you-mean suggestion and a non-zero exit, instead of silently printing help.

## What's new in 1.12.0

- **Email alerts (SMTP)** — security and operational alerts by email. The SMTP
  password is stored encrypted; TLS certificate verification is on by default.
- **Backup & Restore** — full configuration backup with checksummed manifest,
  validated restore, and optional scheduled backups emailed daily/weekly/monthly.
- **Factory reset** — erases all configuration and users; requires the admin's
  password plus typing `RESET`, and snapshots everything first.
- CLI additions: `backup`, `backup-list`, `restore`, `factory-reset`.

## The one thing that breaks a new install

`squid.conf` must contain this line **above** `http_access deny all`:

```
include /etc/squid/acls/webgui_generated.conf
```

If it is missing, or placed below the deny, **every request is denied** and no
GUI rule has any effect. Verify with:

```bash
sudo squid -k parse 2>&1 | grep -nE "webgui_generated|_net|deny all"
```

The generated rules must appear **before** `http_access deny all`.

© Banihal Technologies LLP — BT Proxy v1.12.10
