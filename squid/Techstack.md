# BT Proxy — Tech Stack

## Runtime

| Layer | Choice | Why |
|---|---|---|
| Language | **Python 3** (single codebase, ~10k LOC) | server-side logic + every OS integration is stdlib |
| Web framework | **Flask ≥ 3.0** | light; no ORM/framework weight for JSON-backed config |
| WSGI server | **gunicorn ≥ 21.2** | multi-worker production serving behind systemd |
| Frontend | **Server-rendered Jinja2 + vanilla JS + one CSS file** | no build step, no framework deps, small attack surface |
| Charting | **Canvas 2D** hand-drawn (dashboard bandwidth) | zero charting-library dependency |
| Database | **SQLite** (`squidui.db`) | users, audit trail, login_fails, password history |
| Service manager | **systemd** (`squid-webgui.service`) | boot, daemon supervision, restart |

## Key libraries (`requirements.txt`)

- `Flask` — routes, sessions, Jinja templates, CSRF plumbing
- `requests` — DR peer push (HMAC-signed HTTPS POST), license checks
- `gunicorn` — production WSGI server (multiple workers)
- `pyotp` — TOTP two-factor authentication
- `qrcode` + `pillow` — TOTP provisioning QR codes (in-app `data:` URI)
- `cryptography` — cert generation (self-signed, CSR, chain building) via
  `cert_manager`, inventory inspection, license key signing/verify (Ed25519),
  update-package signature verification
- `ldap3` — Active Directory / LDAPS authentication and group→role mapping

## What there *isn't* (deliberately)

- No npm / no JS framework / no Tailwind — one hand-authored `static/style.css`,
  CSS variables for theme tokens (`--green/--red/--amber/--blue/--muted`).
- No ORM (raw `sqlite3`), no Celery (plain daemon threads), no Redis.
- No monitoring agent — Squid is read through its own **cache-manager**
  (`/squid-internal-mgr/active_requests`) with an access.log fallback.

## OS integrations

| Integration | Mechanism |
|---|---|
| Squid reload/restart | `sudo -n squid -k parse/reconfigure`, `systemctl --no-block restart` via `deploy/sudoers-squidui` |
| Live service state | `systemctl is-active squid` polling |
| Squid package updates | root wrapper `/usr/local/sbin/btproxy-squid-update` |
| Syslog forwarding | Python `SysLogHandler`, RFC3164 (UDP/TCP, facility LOCAL1) |
| Email alerts | stdlib `smtplib`/`email` over STARTTLS/SSL, sent on daemon threads |
| ACL files | plain-text `dstdomain`/`dst` files under `/etc/squid/acls/`, generated atomically |

## State files (all flat, JSON-backed)

| File | Holds |
|---|---|
| `squidui.db` | users, audit, login_fails, pw_history (chmod 0600) |
| `branches.json` | branch definitions: sources, modes, list paths, stored IPs |
| `network.json` | safe/ssl ports, full-access rules with expiry/time windows |
| `settings.json` | branding, SMTP, syslog, AD, DR, license, pw policy, scheduler |
| `scheduler.lock` / `.purge.lock` | single-worker ownership (PID / flock) |
| `scheduler_state.json` | last-run bookkeeping for scheduled jobs |
| `backups/`, `certs/`, `deplists/` | archives, TLS material, dependency-finder lists |

## Frontend patterns

- Layout: CSS grid shell, sidebar + content; `.panel` cards; `.port` branch
  tabs; `.chip` source pills; `.led` status LEDs (green/amber/red/dim).
- Interaction: form-based POSTs with `_csrf` hidden inputs (auto-injected),
  followed by redirect+flash (PRG). Fetch JSON only for the three live views
  (stats/logs/sessions), each with 5s auto-refresh.
- Every destructive control has an `onsubmit` confirm dialog.

## Security stack

- CSRF: per-session token on all POSTs.
- Sessions: 8h absolute / 30-min idle, HTTP-only, SameSite=Lax, Secure over HTTPS.
- Headers: X-Frame-Options DENY, nosniff, Referrer-Policy, strict CSP, HSTS.
- Passwords: hashed w/ werkzeug `scrypt`-style hashes; AD shadow users have
  empty hashes.
- MFA: TOTP (pyotp), per-user, QR provisioning, not bypassable across
  account-merge paths.
- Secrets: SMTP passwords Fernet-encrypted (`crypto_util`) — key shipped in
  backups (documented), chmod-0600 DBs/keys.
- Brute force: login fail counting by username+IP → 15-min lockouts.
- Integrity: Ed25519 over license keys & update packages; HMAC for DR sync.

## OS support

Rocky Linux or Ubuntu (RHEL/DEB), where `squid` is installed from OS packages —
paths (`/etc/squid`, `/usr/sbin/squid`, `/var/log/squid/access.log`) are
identical on both. GUI served on port 8800 (configurable in `config.py`).

## Directory layout

```
app.py                # Flask app: routes, auth, ACL engine, telemetry (~3.5k LOC)
scheduler.py          # background job daemon thread
backup_manager.py     # archive create/inspect/restore/reset
cert_manager.py       # self-signed, import, CSR, backup of TLS material
crypto_util.py        # Fernet encrypt/decrypt (SMTP passwords)
ad_auth.py            # LDAPS auth + role-from-groups
mailer.py             # SMTP alerts, async sends
dr_sync.py            # DC–DR bundle build/sign/apply/push
dep_finder.py         # dependency discovery for sites
dep_classify.py       # advisory domain classification
import_squid_conf.py  # one-shot adoption of an existing squid.conf
update_engine.py      # verified self-update + rollback
license.py            # Ed25519 license verify
manage.py             # CLI: users, license, status, regen
gunicorn_conf.py      # gunicorn workers settings
config.py             # all paths, constants, tuning knobs
templates/            # 16 Jinja2 pages
static/style.css       # entire visual system
deploy/               # systemd unit, sudoers, update helper, wazuh rules
docs/                 # install/update/troubleshoot guides
```