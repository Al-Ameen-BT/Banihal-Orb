# Squid Web GUI

A lightweight web console for managing Squid proxy per-branch whitelists and blacklists, watching the live access log, and seeing which clients are currently browsing.

Features in this version:

1. Login screen (local accounts, hashed passwords, 3 roles: admin / operator / viewer)
2. User creation, password reset, forced change on first login, audit trail
3. Concurrent session list (Squid cache manager, automatic access.log fallback)
4. Live access.log viewer with filters (text, client IP, allowed/denied, method) and auto-refresh
5. Branch-wise whitelist/blacklist display, add/remove domains, one-click "Apply to Squid" (runs `squid -k parse` check first, then `reconfigure`)

Stack: Python 3 + Flask + SQLite. No external CDN assets — works on an isolated LAN.

---

## 1. Install (Rocky Linux 8/9 or Ubuntu 22.04/24.04)

```bash
# Rocky:
sudo dnf install -y python3 python3-pip squid
# Ubuntu:
sudo apt install -y python3 python3-venv python3-pip squid

# App user and location
sudo useradd -r -s /sbin/nologin squidui
sudo mkdir -p /opt/squid-webgui /etc/squid/acls
sudo cp -r ./* /opt/squid-webgui/
cd /opt/squid-webgui
sudo python3 -m venv venv
sudo ./venv/bin/pip install -r requirements.txt

# Permissions
sudo chown -R squidui:squidui /opt/squid-webgui
sudo chown -R squidui:squid /etc/squid/acls      # app writes ACL files here
sudo chmod 775 /etc/squid/acls

# Let squidui read the log:
# Rocky (log group is 'squid'):
sudo usermod -aG squid squidui
sudo chmod g+rx /var/log/squid && sudo chmod g+r /var/log/squid/access.log
# Ubuntu (log group is 'proxy'):
sudo usermod -aG proxy squidui
sudo chmod g+rx /var/log/squid && sudo chmod g+r /var/log/squid/access.log
```

> On Rocky with SELinux enforcing, also allow the app to read logs and write ACLs:
> `sudo semanage fcontext -a -t squid_conf_t "/etc/squid/acls(/.*)?" && sudo restorecon -Rv /etc/squid/acls`
> If the GUI still can't read logs, check `sudo ausearch -m avc -ts recent`.

## 2. Sudo rule (reload squid only)

```bash
sudo cp deploy/sudoers-squidui /etc/sudoers.d/squidui
sudo chmod 440 /etc/sudoers.d/squidui
sudo visudo -cf /etc/sudoers.d/squidui   # must say "parsed OK"
```

## 3. Enable the cache manager (for the live Sessions page)

In `/etc/squid/squid.conf`, make sure these lines exist near the top of the
http_access section (default configs already have most of it):

```
http_access allow localhost manager
http_access deny manager
```

If they are missing, the Sessions page automatically falls back to
access.log analysis — everything still works, just less "live".

## 4. Wire branch ACL files into squid.conf (one time per branch)

The GUI stores the domain lists in files under `/etc/squid/acls/`.
For each branch, add a block like this (the GUI shows a ready-made snippet
under each branch page — adjust the `src` subnet to that branch):

```
acl branch01_net src 172.31.11.0/24
acl branch01_whitelist dstdomain "/etc/squid/acls/branch01_whitelist.txt"
acl branch01_blacklist dstdomain "/etc/squid/acls/branch01_blacklist.txt"

http_access deny  branch01_net branch01_blacklist
http_access allow branch01_net branch01_whitelist
# whitelist-only mode for this branch (optional):
# http_access deny branch01_net
```

Order matters in Squid: deny (blacklist) before allow (whitelist), and both
before your general allow rules. After adding the blocks once, all day-to-day
changes happen in the GUI — it edits the .txt files and reloads Squid.

Note: `dstdomain` files must not be empty when referenced with a
whitelist-only deny rule, and Squid warns on empty ACL files at reload.
The GUI always writes a comment header so files are never zero-byte.

## 5. Run as a service

```bash
# Set a real secret first:
sudo sed -i "s/CHANGE_ME_LONG_RANDOM_STRING/$(openssl rand -hex 32)/" deploy/squid-webgui.service
sudo cp deploy/squid-webgui.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now squid-webgui
```

Firewall:

```bash
# Rocky:
sudo firewall-cmd --add-port=8800/tcp --permanent && sudo firewall-cmd --reload
# Ubuntu:
sudo ufw allow 8800/tcp
```

Open `http://<server-ip>:8800`

**Default login: `admin` / `admin@123` — you will be forced to change it immediately.**

## 6. Quick test without systemd

```bash
cd /opt/squid-webgui && sudo -u squidui ./venv/bin/python app.py
```

---

## Configuration

Everything lives in `config.py`: paths, port, `AUTO_RECONFIGURE`
(reload Squid on every change vs. manual Apply button), log window sizes.

`branches.json` maps branch names to their ACL files. You can create new
branches from the GUI (admin role) — it creates the files and shows the
squid.conf snippet to paste once.

## Roles

| Role     | View lists/logs/sessions | Add/remove URLs, reload Squid | Manage users |
|----------|:---:|:---:|:---:|
| viewer   | ✔ | ✖ | ✖ |
| operator | ✔ | ✔ | ✖ |
| admin    | ✔ | ✔ | ✔ |

## Security notes

- Run it on the management VLAN only; restrict port 8800 by firewall to admin subnets.
- The sudoers rule permits exactly two commands (`squid -k parse`, `squid -k reconfigure`).
- Every login, list change, reload, and user action is written to the audit table (Users & Audit page).
- For HTTPS, put nginx/Apache in front as a reverse proxy with a certificate.

---

## Custom port

Edit `LISTEN_PORT` in `config.py`, then `sudo systemctl restart squid-webgui`.
(The systemd unit reads the port through `gunicorn_conf.py`, no unit editing needed.)
Remember to open the new port in the firewall.

## SSL / HTTPS

1. Put your certificate and key in `/opt/squid-webgui/certs/`. For a
   self-signed certificate (10-year, fine for an internal admin tool):

   ```bash
   sudo mkdir -p /opt/squid-webgui/certs
   sudo openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
        -keyout /opt/squid-webgui/certs/server.key \
        -out    /opt/squid-webgui/certs/server.crt \
        -subj "/CN=$(hostname -f)" \
        -addext "subjectAltName=DNS:$(hostname -f),IP:YOUR_SERVER_IP"
   sudo chown -R squidui:squidui /opt/squid-webgui/certs
   sudo chmod 600 /opt/squid-webgui/certs/server.key
   ```

2. In `config.py` set:

   ```python
   SSL_ENABLED = True
   ```

3. `sudo systemctl restart squid-webgui` and browse to
   `https://<server-ip>:8800` (browsers warn once for self-signed certs —
   accept the exception, or import the .crt into your admin PCs' trust store).

If the cert/key files are missing while SSL_ENABLED is True, the service
refuses to start with a clear message in `journalctl` instead of serving HTTP.

## Company logo on login screen

Copy your logo to the static folder — it appears automatically on the login
card and the sidebar, no config change needed:

```bash
sudo cp your-logo.png /opt/squid-webgui/static/logo.png
sudo chown squidui:squidui /opt/squid-webgui/static/logo.png
```

PNG or SVG, roughly 200px wide looks best. To use a different filename,
change `LOGO_FILE` in `config.py`. The title texts on the login screen and
sidebar are also configurable there (`APP_TITLE`, `APP_SUBTITLE`).

---

## Network Rules (v1.2)

The GUI now manages Squid's network-level ACLs too. Everything is written to
one generated file: `/etc/squid/acls/webgui_generated.conf`.

**One-time squid.conf change** — add this single line just above
`http_access deny all`, and remove any branch blocks you added manually before:

```
include /etc/squid/acls/webgui_generated.conf
```

What the Network Rules page manages:

- **Extra Safe_ports / SSL_ports** — allow custom HTTP ports (e.g. 8080,
  8000-8100) and custom HTTPS CONNECT ports (e.g. 8443) without touching
  squid.conf. Squid combines these with its built-in defaults.
- **Full internet access** — specific IPs or subnets that bypass all
  whitelists/blacklists, either always or on a schedule (days + time window,
  e.g. Mon-Fri 09:00-18:00). Useful for management PCs or servers.

What the branch page now manages:

- **Branch networks** — the subnets/IPs each branch's rules apply to
  (previously the manual `acl ..._net src` line). A branch's rules are only
  generated once it has at least one source; the page warns you if empty.
  Overlapping entries are rejected with a clear message.
- **Whitelist-only mode** — per-branch toggle that blocks everything except
  the whitelist (adds `http_access deny <branch>_net` after the allow rule).

Rule order inside the generated file (matters in Squid):
full-access allows first, then per branch: blacklist deny → whitelist allow →
optional deny-all. Empty domain lists are skipped automatically so Squid
never sees an empty-ACL error.

After any change, use **Apply to Squid** (config check + reload) unless
AUTO_RECONFIGURE is enabled in config.py.

---

## Importing an existing squid.conf (v1.3)

If you already have a hand-maintained squid.conf with src/dstdomain ACL
groups, the importer converts it into GUI data automatically:

```bash
cd /opt/squid-webgui
# dry run first - shows the plan, writes nothing:
sudo -u squidui ./venv/bin/python import_squid_conf.py /etc/squid/squid.conf
# then apply:
sudo -u squidui ./venv/bin/python import_squid_conf.py /etc/squid/squid.conf --apply
```

The importer detects: extra Safe_ports/SSL_ports, full-access hosts
(`acl X src …` + `http_access allow X`), and every src+dstdomain group with
its whitelist-only vs fall-through mode. Groups sharing one .acl file are
merged into a single GUI branch with combined sources — edit once, applies
to every branch office. Section comments inside .acl files are not preserved
(use the branch description instead).

Other v1.3 changes:
- Branches can be deleted from the GUI (admin only, removes its list files).
- Site lists accept IPs and subnets as well as domains. IP entries are
  generated as `dst` ACLs (correct type - avoids the reverse-DNS behavior of
  IPs inside dstdomain files) and duplicates are removed automatically.
- Branch rules are generated most-specific-first (/32 per-PC exceptions
  always come before their /24 subnet rule, regardless of creation order).

---

## v1.4 — usability at scale, branding, security hardening

**Squid control:** two buttons now — Reload (parse check + reconfigure, zero
downtime, operators+) and Restart (systemctl restart squid, brief downtime,
admin only, with confirmation). Update the sudoers file for restart to work:

```bash
sudo cp deploy/sudoers-squidui /etc/sudoers.d/squidui && sudo chmod 440 /etc/sudoers.d/squidui
```

**Scales to many branches / long lists:** branch search box filters 20+
branches as you type (matches name and description). Whitelist/blacklist
entries are collapsed by default behind a "Show N entries" button, with a
filter box to find a URL among hundreds instantly.

**Branding (Settings page, admin):** product name (default "BT PROXY"),
subtitle, and logo upload (PNG/JPG/SVG, max 2 MB) all from the GUI —
no file copying needed anymore. Stored in settings.json.

**Security hardening:**
- CSRF tokens verified on every POST (auto-injected into all forms)
- Login lockout: 5 failed attempts locks the username/IP for 15 minutes
  (configurable), failures and lockouts recorded in the audit log
- Idle auto-logout after 30 minutes of inactivity (configurable)
- Security headers: X-Frame-Options DENY, nosniff, CSP, Referrer-Policy,
  HSTS when SSL is enabled
- Session cookies: HttpOnly, SameSite=Lax, Secure when SSL is enabled
- squidui.db permissions forced to 600
- Settings page shows a live security status summary

Remaining recommendations: enable SSL when the Sectigo certificate arrives,
restrict the GUI port by firewall to the IT subnet, and ensure
SQUIDUI_SECRET in the systemd unit is a real random value.

---

## v1.5 — Two-factor authentication (TOTP)

Works fully offline on the LAN - codes come from the authenticator app on the
user's phone (Microsoft Authenticator, Google Authenticator, or any TOTP app),
no SMS gateway or internet connection needed.

**Enable (each user, self-service):** sidebar → *Two-factor auth* → scan the
QR code with the authenticator app → enter the current 6-digit code → ON.
From then on, sign-in asks for the code after the password.

**Lost phone:** an admin resets it from Users & Audit (*Reset MFA* button) -
the user logs in with password only and re-enrolls. If the only admin is
locked out, use the server CLI:

```bash
cd /opt/squid-webgui
sudo -u squidui ./venv/bin/python manage.py list
sudo -u squidui ./venv/bin/python manage.py reset-mfa <username>
sudo -u squidui ./venv/bin/python manage.py reset-password <username>
sudo -u squidui ./venv/bin/python manage.py unlock <username>
```

Notes:
- Wrong-code attempts count toward the same lockout as wrong passwords
  (5 fails = 15 min lock) and are audit-logged (mfa-fail).
- The password step and code step are separate: a stolen password alone
  cannot reach any page.
- TOTP depends on phone clock accuracy; the server should run NTP/chrony
  (codes tolerate ±30s drift).
- New dependencies: pyotp, qrcode, pillow (in requirements.txt).

---

## v1.6 — Dashboard

The landing page after login is now a live dashboard (auto-refresh 5s):

- **Squid service status** (active/inactive LED, version, up-since, process RAM)
- **Active sessions** count (cache manager, access.log fallback)
- **CPU %** with 1-minute load average
- **Memory** used/total with color-coded bar (amber >75%, red >90%)
- **Disk /** usage
- **Last hour proxy stats** — requests, denied count, unique clients, bytes served
- **Network bandwidth** — live RX/TX rates with a rolling 5-minute chart

All values read from /proc and systemctl - no extra dependencies, no agents.
Viewers can see the dashboard (read-only page). Squid status uses
"systemctl is-active" which needs no sudo.

Also in v1.6: search placeholders made generic ("Search branches by name or
description…", "Type to filter entries…").

---

## v1.7 — Reports, syslog/Wazuh, password policy, temp access, licensing

**Dashboard:** system uptime card, proxy bandwidth used in the last 1h and
24h (reads current + rotated logs efficiently, newest-first with early stop).

**Reports page (new):** three report types over any date range (a month or
more - reads access.log + rotated + .gz files):
- Website access log - every request; filters: client IP, user, URL text, denied-only
- User activity summary - per client/user: requests, denied, MB, top 5 sites
- Audit log - all GUI admin actions
Output: on-screen (first 500 rows) or full CSV download. CSV cells are
formula-escaped (safe to open in Excel). Report generation itself is audited.

**Syslog forwarding (Settings):** sends every audit event to a central syslog
server in real time (host/port/UDP-TCP, facility LOCAL1, test button).

**Wazuh integration:** ready-made decoder + rules in deploy/wazuh/:
```bash
# on the Wazuh manager:
cp btproxy_decoders.xml /var/ossec/etc/decoders/
cp btproxy_rules.xml    /var/ossec/etc/rules/
chown wazuh:wazuh /var/ossec/etc/decoders/btproxy_decoders.xml /var/ossec/etc/rules/btproxy_rules.xml
systemctl restart wazuh-manager
```
Also allow syslog intake in ossec.conf (<remote> connection=syslog, port 514
udp, allowed-ips = proxy server IP). Rules cover: failed logins (level 5),
brute force 5-in-5min (level 10), lockouts (8), MFA failures, full-access
grants (6), CLI overrides (7), config changes, service restarts.
Rule IDs 110200-110212.

**Password policy (Settings):** minimum length, complexity (off / medium /
strong), history (block reuse of last N), expiry in days (forces change at
login). Applies to password changes, user creation and resets.
manage.py reset-password intentionally bypasses policy (emergency use).

**Squid proxy port** now displayed in Settings (read from squid.conf).

**Temporary full internet access:** the Duration selector (1/2/3/4/8/24 hours)
creates self-expiring entries. A background worker removes them on schedule,
regenerates the config and reloads Squid automatically; removal is recorded
in the audit log as user "system". Time-window input boxes standardized.

**Licensing:** subscription keys (1/3/5-year) issued by Banihal Technologies
LLP. Fresh installs get a 30-day trial. When trial/license expires: Access
Lists and Network Rules become read-only (dashboard, logs, sessions, reports
keep working); a banner shows on every page from 7 days before expiry.
Activate keys in Settings. Generate keys with deploy/license_gen.py -
**Banihal internal tool: REMOVE deploy/license_gen.py (and keep license.py's
VENDOR_SECRET confidential) on customer installations.** Note: this is
honest-customer licensing - anyone with filesystem access and Python skills
could bypass it; it is a commercial control, not a security boundary.

© Banihal Technologies LLP

---

## v1.8 — Asymmetric licensing (Ed25519) + anti-rollback

License keys are now signed with Ed25519. Customer systems carry only the
PUBLIC key (license.py): it verifies keys but cannot create them, so nothing
on a customer server allows forging a license.

**Key format changed to BTP2.** Old BTP1 keys stop working - issue and
activate a new key after this update.

**Banihal internal - protect these two files** (they can mint licenses):
- deploy/vendor_private_key.hex   (the Ed25519 private key)
- deploy/license_gen.py           (the generator)
Keep both ONLY on a Banihal office machine plus a secure backup, and DELETE
both from every customer installation:
    rm /opt/squid-webgui/deploy/license_gen.py /opt/squid-webgui/deploy/vendor_private_key.hex
Losing the private key means no new licenses can be issued without shipping
a new public key to every install.

**Clock-rollback protection:** the app tracks the highest time it has ever
seen. Rolling the system clock back to stretch a license/trial does not work
(expiry is computed against the high-water mark), and the attempt is logged
to the audit trail and syslog as action=license-tamper - Wazuh rule 110213
raises it at level 12.

New dependency: cryptography (in requirements.txt).

Honest scope note: enforcement still runs on the customer's machine; an admin
who edits app.py can bypass it. The license is a commercial control backed by
the service contract, not a security boundary - but keys can no longer be
forged from anything present on the customer system.

---

## v1.9 — Version display + in-GUI software update ("firmware update")

**Version** is shown in the sidebar footer and on the login screen
(config.APP_VERSION).

**Software Update page (Settings area, admin only):** customers apply updates
by uploading a signed package file — no SSH needed.

Workflow:
1. Admin → Software Update → upload the .btpkg file → "Check package"
2. The GUI verifies the Ed25519 signature (same Banihal key as licenses) and
   shows version, build date, file count, release notes
3. "Apply" → every replaced file is backed up under updates/backup_<ts>/,
   new files written, then the service auto-restarts to load the new code
4. Update history is listed on the page

Safety:
- Unsigned or tampered packages are rejected before anything is touched
- Payload hash and per-file hashes verified
- config.py, *.db and *.json are never overwritten by a package (customer
  settings/data are safe even if a package tried)
- Path-traversal attempts blocked
- Automatic rollback if a write fails partway
- min_version gate prevents skipping required intermediate updates

**Banihal - building an update package** (on the office machine with the
private key, from the NEW version's source tree):

```bash
python3 deploy/build_update.py --version 1.10.0 \
    --min-version 1.9.0 \
    --notes "What changed in this release" \
    --out /tmp/btproxy-1.10.0.btpkg \
    app.py license.py update_engine.py templates static VERSION
```

List the files/dirs that changed (or all app files for a full replace).
Never list config.py or data files. Send the customer the single .btpkg;
they apply it from the GUI. The self-restart needs the sudoers line for
"systemctl restart squid-webgui" (updated deploy/sudoers-squidui).

© Banihal Technologies LLP

---

## v1.9 (final) — version display, GUI updates, Squid package updates

- Version shown in sidebar + login screen, read from the **VERSION** file
  (update packages replace it; config.py is never overwritten).
- **Software Update** page (admin): upload a signed `.btpkg` → verify → apply,
  with automatic backup, rollback and service restart.
- **Squid proxy package** panel on the same page: check installed vs available
  version and upgrade Squid itself. Uses a root-owned wrapper
  (`/usr/local/sbin/btproxy-squid-update`) so the GUI never holds blanket
  apt/dnf rights. Config is re-parsed automatically after upgrade.
- Settings shows Squid version, Squid proxy port, and BT Proxy version.

Full documentation: **INSTALL.md** (new systems) and **UPDATE.md** (updates).

Documentation set:
- **INSTALL.md** — fresh installation on a new server
- **UPDATE.md** — manual updates, .btpkg GUI updates, Squid package updates
- **TROUBLESHOOTING.md** — CLI reference: service control, user/password/MFA recovery,
  license, config problems, permissions, OS-upgrade recovery, backups

---

## v1.10.0 — Restart timeout fix

`systemctl restart squid` blocks until the unit finishes starting, and Squid
waits `shutdown_lifetime` (default 30s) for active client connections to drain.
The GUI's 30s command timeout therefore fired even though the restart had
actually been issued.

Fixes:
- Restarts are now issued with `--no-block` (the job is queued, systemctl
  returns immediately), then the GUI polls `systemctl is-active` for up to
  RESTART_WAIT seconds (default 45) and reports the real outcome.
- The GUI's own restart after a .btpkg update is also `--no-block` - a blocking
  self-restart could deadlock (systemd kills the process that is waiting).
- Command timeout raised to SQUID_CMD_TIMEOUT (default 60s), and a timeout now
  produces a clear message instead of a raw Python error.

**Requires the updated sudoers file** - sudo matches the exact argument list,
so the `--no-block` variants must be permitted:

```bash
sudo cp /opt/squid-webgui/deploy/sudoers-squidui /etc/sudoers.d/squidui
sudo chmod 440 /etc/sudoers.d/squidui
sudo visudo -cf /etc/sudoers.d/squidui     # must print "parsed OK"
```

Optional: to make restarts genuinely fast, lower Squid's drain time in
squid.conf (5 seconds is fine for a forward proxy):

    shutdown_lifetime 5 seconds

---

## v1.10.0 — Active Directory authentication + SSL certificate management

**Active Directory (optional):** local accounts always work; when AD is enabled,
users not found locally authenticate against AD (LDAPS, two-DC failover) and map
to roles by group membership. MFA still applies. If all DCs are down, local
login still works. Bind password stored encrypted. Settings → Active Directory,
with a Test button. New dependency: ldap3.

**SSL certificates (Certificates page):** generate self-signed (with IP/hostname
SANs, key never leaves the server) or import a purchased certificate (validates
key-matches-cert, chain and expiry). Generate CSR option. Enable/disable HTTPS
from the GUI (SSL_ENABLED moved to settings so it survives updates). Automatic
backup before every change; dashboard shows days-to-expiry (amber ≤30, red ≤7).
CLI escape hatches: manage.py cert-restore, manage.py ssl-off.

See docs_ad_ssl.md for full details.

---

## v1.10.0 fixes (post-release)

- Dashboard now shows a **License** card (Trial/Licensed/EXPIRED, days left)
  next to the SSL Certificate card.
- **Access Lists auto-heal**: branches whose stored list-file path was missing
  or stale are re-linked to their real .acl file on page load, so previously
  hidden entries reappear. Added a **Rescan ACL files** button that adopts any
  unlinked .acl files in the ACL directory as branches.
- Documented the `gunicorn_conf.py` "Not a string: <module 'config'>" fix and
  the sudoers restart fix.

---

## v1.10.1 — Dependency Finder (security-first, advisory only)

Helps whitelist sites that pull resources from many domains (CDNs, fonts, APIs),
without opening anything automatically.

- **Access Lists → Dependency Finder:** an admin/operator enters a site URL.
  BT Proxy fetches the page **read-only, with no code execution** (static HTML
  parse only — the site's JavaScript is never run), and lists the domains it
  references.
- **SSRF-hardened:** only public http/https hosts can be scanned. Loopback,
  private, link-local and cloud-metadata addresses are refused before connect,
  after DNS resolution, and on every redirect hop.
- **Human-in-the-loop:** every domain is shown with an assessment label; the
  operator individually ticks which to add. Nothing is auto-allowed. Telemetry/
  browser-noise (e.g. bing.com when the user is on Edge) is flagged "avoid" and
  left un-ticked so it is never approved by accident.
- **Advisory labels** come from locally-imported category lists (telemetry / cdn
  / provider) — Settings → Dependency Finder category lists. No external service
  is contacted; nothing about what is being whitelisted leaves the server.
- **Audited:** the URL searched, domains approved, and list imports are all
  written to the audit log and forwarded to syslog/Wazuh.

Admin/operator only (viewers cannot use it). New module files: dep_finder.py,
dep_classify.py, deplists/.

---

## v1.11.0 — Granular access rules + UI fixes

- Access rules at any granularity (subnet / department range / single host)
  with most-specific-source-first precedence, and per-rule additive/exclusive
  modes. A department or PC can have different access from its subnet.
- Config generation hardened: atomic write, source re-validation at generation,
  scoped per-rule denies.
- Sticky sidebar so Sign out / Change password / Two-factor stay reachable on
  long pages.
- Complete documentation set refreshed (docs/) — customer-agnostic examples.

---

## v1.11.1 — Intuitive domain matching

Whitelisting a domain now matches the domain AND all its subdomains
automatically. Enter `google.com` and it matches `google.com`, `www.google.com`,
`mail.google.com`, etc. Internally the leading-dot form is used (Squid's
"domain and all subdomains" syntax), redundant subdomains are removed so Squid
loads without warnings, and the operator's original list is never rewritten.
Validated against live Squid parsing.

---

## v1.12.0 — Email alerts, backup & restore, factory reset

**1. Email alerts (SMTP)** — Settings → Email Alerts. Configure host, port,
security (STARTTLS / SSL / none), certificate verification, credentials,
from/to addresses, with a **Send test email** button. Password is encrypted at
rest (Fernet, same key store as the rest of the app). Per-category toggles:
login failures/lockouts, configuration changes, service actions, license
events, certificate expiry. These events are **always** mailed regardless of
toggles: account lockout, license tamper detection, certificate expiring,
factory reset. Mail is sent on a background worker thread — a dead or slow
SMTP server can never block or break the GUI. Alert bodies contain no
passwords, keys or tokens. Single failed logins are not mailed (noise);
a lockout is.

**2. Backup & restore** — new Backup page (admin only). A backup is a
`.tar.gz` containing branches.json, network.json, settings.json, squidui.db,
secret.key, the dependency lists and the generated ACL files, plus a
`manifest.json` with SHA-256 checksums, product version and hostname.
Backup files are written 0600 — **they contain secrets, treat them as
sensitive**.
- Create, download, delete, and inspect-before-restore from the GUI.
- **Restore requires the admin password again**, validates every checksum and
  blocks path traversal *before* writing anything, and takes an automatic
  snapshot of the current state first.
- **Scheduled backup:** off / daily / weekly (choose weekday) / monthly
  (choose day) at a set time, optionally **emailed** to the configured
  address. Retention keeps the last N backups (default 10). Only one gunicorn
  worker runs the schedule (PID lock file), so a job never runs twice.
- CLI equivalents: `btp backup [note]`, `btp backup-list`, `btp restore <file>`.

**3. Factory reset** — Backup page, danger zone. Requires the **admin
password**, the typed word `RESET`, and a **local** admin account (an AD/LDAP
account cannot factory-reset). It snapshots first, then erases all
configuration, users, rules, lists and certificates, emails a critical alert,
and signs you out. `squid.conf` itself is left untouched. CLI: `btp factory-reset`.

**Docs:** full set refreshed in `docs/` — fresh installation, update
(GUI + manual), troubleshooting, SSL, the new email/backup/reset guide, plus
the Banihal-internal license creation and package creation guides.

No new pip dependencies (standard library only) — the GUI update package and
the manual update procedure both apply cleanly.

---

## v1.12.1 — SMTP diagnostics

Email setup failures now say what actually went wrong instead of a generic
message — the same silent-failure problem that made the squid.conf `include`
issue so hard to find:

- **DNS vs connection are separated.** "Cannot resolve the mail server name X"
  (a name/DNS problem, no connection was attempted) is now distinct from
  "Resolved X but could not connect on port N" (a port/firewall problem).
- **The mail server's own reason is shown.** An authentication failure now
  reports the provider's exact response and code, plus a hint — e.g. Google's
  `BadCredentials` suggests checking the full email address and a space-free
  App Password, while `Application-specific password required` says the
  account password won't work because 2-step verification is on.
- **Pasted hostnames are normalized on save** — `smtp://host`, `https://host/`,
  a trailing dot or stray spaces no longer cause a bogus DNS error, and
  `host:587` splits into the host and port fields automatically.
- **Leading/trailing whitespace is stripped from the SMTP password** (always
  accidental in a pasted secret).
- Field hints added: username is the full email address; app passwords are
  entered as 16 characters with no spaces.

---

## v1.12.2 — SMTP guidance (docs + field hints)

Field-tested against a live customer mail server. No behaviour change; this
release captures what actually goes wrong when configuring email:

- The SMTP host field now names the correct Microsoft 365 organisation endpoint
  (`smtp.office365.com`). The consumer host `smtp-mail.outlook.com` rejects an
  organisation account with an error that looks identical to a wrong password —
  this cost real time to find.
- Doc 05 gains a server-selection table (M365 organisation / personal
  Outlook.com / Gmail), the "copy whatever the customer's existing alerting
  already uses" shortcut, the per-mailbox `Set-CASMailbox` requirement, and a
  warning against sending backups (which contain `secret.key`) to public
  webmail.
- Doc 03 §7 rewritten around the three distinct failures the test button now
  reports: name resolution, connection, and authentication — with the real
  causes of each.
- Internal mail relay (port 25, Security = None, no credentials) documented as
  the preferred option for bank sites: nothing leaves the customer network and
  no provider auth policy can break it later.

---

## v1.12.3 — Rescan no longer adopts generated files

**Bug (found in production):** *Rescan ACL files* adopted BT Proxy's own
machine-generated companion lists (`gen_ho_whitelist.txt`, …) as if they were
hand-made operator files, creating phantom access rules named `gen_ho`,
`gen_br1` and so on. They had no sources, so they generated no Squid rules and
no traffic was affected — but they cluttered the rules list and the generated
config, and were a silent data-loss trap: anything typed into such a rule
would be destroyed on the next Apply, because BT Proxy rewrites that file from
the real rule it belongs to.

Fixes:

- **Rescan ignores `gen_*` files.** They are outputs, never inputs.
- **`gen_` is now a reserved prefix for rule names** — rejected at creation.
  A rule called `gen_ho` would own `gen_ho_whitelist.txt`, which is exactly the
  companion file the real `ho` rule overwrites.
- **Existing phantom rules are removed automatically** on first load. The check
  is deliberately narrow: the name must use the reserved prefix, the rule must
  have no sources, and every list path it holds must point at a generated file.
  A real rule cannot satisfy all three, so genuine rules — including new ones
  that simply have no sources yet — are never touched.
- Rescan's tooltip now states what it does and what it skips.

Verified against a live Squid parse: config clean, rule order unchanged, real
rules intact.

---

## v1.12.4 — No more `gen_*` files

The `gen_*.txt` companion lists are gone. Domains are compiled straight into
`webgui_generated.conf` as inline `dstdomain` values, chunked over repeated
`acl` lines (Squid appends each line to the same ACL).

Why they existed, and why they no longer need to: the companion held the
normalised leading-dot forms and kept IPs out of `dstdomain`. Both are now done
during generation. The original justification — "never machine-rewrite the
operator's file" — was not real: `write_acl` already stamps and rewrites those
files on every add/remove. So the second file bought nothing and cost clarity.

Result: one file per list (BT Proxy's storage, shown in the GUI) and one
generated config (the only file Squid reads). No mystery files in the ACL
directory.

- Obsolete `gen_*` files are deleted automatically on the next generation. A
  `gen_*` file that a rule actually points at is never touched.
- Unchanged: leading-dot normalisation, redundant-subdomain removal, IPs as
  `dst` ACLs, most-specific-source-first ordering, atomic writes.

Verified against live Squid: clean parse with mixed domain/IP lists, correct
rule order, and a 500-domain list compiling to 63 short lines with no warnings.

---

## v1.12.5 — `dstdomain` points at the list file again

Following operator feedback: the generated config now references each list by
file, as it did originally —

```
acl ho_whitelist dstdomain "/etc/squid/acls/ho_whitelist.txt"
http_access allow ho_net ho_whitelist
```

— instead of inlining the domains (1.12.4) or using a `gen_*` companion
(1.11.1–1.12.3). One list, one file, and that file is what Squid reads.

This works because the list file is now **canonical**: normalisation happens
when the list is saved, not when the config is generated. The file holds the
leading-dot forms with redundant subdomains removed, and never IPs.

- **IPs and subnets moved to `branches.json`** (`whitelist_ips` /
  `blacklist_ips`) and are emitted as `dst` ACLs. They must not sit in a
  `dstdomain` file: Squid reverse-resolves at runtime, so an IP there is a dead
  entry. The GUI still shows domains and IPs together in one list.
- **Existing lists migrate automatically** on first load: bare domains are
  rewritten to their dot form, and any IPs found are moved out into
  `branches.json` rather than dropped. The migration is idempotent.
- **Removed the "include subdomains" checkbox.** It had done nothing since
  v1.11.1 — normalisation forced the dot form whether or not it was ticked.
  A control that lies is worse than no control; the form now states the actual
  behaviour.

Verified against live Squid: clean parse, correct rule order (/29 before /24),
add/remove round-trips through the real routes, and a stable migration.

---

## v1.12.6 — Access-list usability

**1. New rules default to Exclusive (whitelist-only).** A new rule now fails
closed: its sources reach only what you list. Additive remains one click away.
Existing rules are untouched — their current mode is their mode.

**2. Bulk upload.** Each list gets a *Bulk upload from file* panel: plain text,
one entry per line, `#` comments and blank lines ignored. Every line goes
through exactly the same validation as a typed entry — a file is not a reason
to trust its contents — and the import is audited (`acl-bulk-upload`). Bounded
at 1 MB / 5000 entries so an upload cannot exhaust memory or bury a bad entry
in 100k unread lines.

**3. Bulk delete.** Entries now have tick-boxes with *select all* and *Delete
selected*, replacing one-at-a-time removal. Select-all only ticks rows visible
under the current filter, so a filtered select-all can never delete entries you
cannot see. Audited as `acl-remove-bulk`.

**4. "Include subdomains" checkbox is back — and now real.** Ticked stores
`.example.com` (the domain and everything under it); unticked stores
`example.com` (that exact host only). It was removed in 1.12.5 because it did
nothing; it returns because it does something.

> Why it was ever fake: both `google.com` and `.google.com` in one ACL is
> **FATAL** — Squid reports "'.google.com' is a subdomain of 'google.com'" and
> refuses to start. On a bank proxy that is a total outage. Forcing every entry
> to the dot form made the conflict impossible, at the cost of the control being
> a lie. Now the conflict is resolved instead: if both forms of a domain end up
> in a list, the broader dot form wins and the redundant one is dropped, with a
> message saying so. Verified against a live Squid parse.

Lists written by earlier versions stored bare domains that *meant* "and
subdomains", so they are converted once, gated behind a schema marker in
settings. After that, a deliberate exact-match entry is never silently widened.

---

## v1.12.7 — CLI reports unknown commands

`manage.py` (and the `btp` wrapper) no longer respond to a mistyped command by
printing the full help and exiting — which looked like success and could hide,
say, a lockout that was never cleared in an emergency.

- An unrecognised command now prints `Unknown command: '<x>'` to stderr, offers
  the closest matches (`unloack` -> "Did you mean: unlock  unlock-all"), and
  exits **2**.
- A command missing its `<username>` prints a one-line usage for that specific
  command instead of the whole manual, and exits 2.
- No arguments still prints the full command reference (exit 1), unchanged.

Same silent-failure class as the earlier squid.conf include and SMTP issues:
an action that quietly does nothing while looking fine is worse than one that
says it failed.

---

## v1.12.8 — AD: StartTLS support + real connection diagnostics

**Clearer test failures.** The AD *Test* button previously echoed the raw
socket error. It now identifies the layer that failed and what to do:

- TCP connects but the TLS handshake is reset ("Connection reset by peer"
  during SSL wrapping) is now reported as *reached the port but LDAPS was
  refused — the DC likely has no LDAPS certificate*, with the exact
  `openssl s_client` command to confirm. This is the classic "LDAPS not really
  enabled on the domain controller" case.
- A built-in probe (standard library, no openssl needed) distinguishes *port
  closed* from *port open but TLS refused*, and the result says which.
- Refused / timeout / DNS failures each get their own specific message.

**StartTLS mode added.** The connection Security setting is now a choice of
**LDAPS (636)**, **StartTLS (389)**, or **None (389)**, replacing the old
LDAPS on/off checkbox. StartTLS upgrades a plain-389 connection to TLS and
often works where LDAPS on 636 does not — many DCs answer 389 but never had an
LDAPS certificate installed. Credentials are still encrypted. Selecting a mode
auto-fills its default port.

Back-compatible: an existing config with only the old LDAPS flag keeps working
unchanged (treated as LDAPS when on, plaintext when off). Saving from the new
UI stores the mode and keeps the legacy flag in sync.

---

## v1.12.9 — AD users: no local password reset, MFA kept

Fixes a confusing and broken control on the Users page for AD-backed accounts.

- **Password reset is removed for AD users.** Their password lives in Active
  Directory; BT Proxy cannot change it. The old button wrote a local temporary
  password that could never be used to log in (an AD user authenticates against
  AD, not the local hash) and corrupted the account's shadow record. The Users
  page now shows "pw in AD" instead, and the reset action is refused server-side
  with a clear message.
- **MFA stays fully available for AD users.** MFA is BT Proxy's own second
  factor, independent of AD: an AD user can enrol it, it is enforced at login
  after the AD password succeeds, and an admin can reset it (e.g. lost device).
  This was already working and is unchanged.
- **Self-healing:** an AD shadow record left with a stray local password or a
  forced-change flag from the old bug is cleaned automatically on that user's
  next login (empty password, no forced change).
- Password-expiry policy no longer applies to AD users (AD owns their password
  lifecycle), so they are never pushed to the local change-password page.

No new dependencies.

---

## v1.12.10 — AD identity is one account (MFA can't be bypassed)

**Security fix.** Logging in as `tbt001` and `tbt001@domain` created two
separate accounts. MFA enrolled on one did not apply to the other — so a user
with MFA could sidestep it by signing in with the other form. That is now
closed.

- AD login is keyed on the **canonical sAMAccountName** returned by the
  directory, not on whatever form was typed. `tbt001`, `tbt001@domain`, and any
  casing all resolve to one account.
- **Existing duplicates are merged automatically** on next login, preserving MFA
  from whichever record had it enrolled, and the redundant record is removed
  (audited as `ad-user-merged`).
- The connection Test now shows the resolved account name on success, so it is
  obvious which account a login maps to.

If a user currently has two rows in Users / Activity, they collapse to one the
next time that person logs in. No new dependencies.

---

## v1.12.11 — Syslog is RFC3164-compliant (Wazuh/SIEM decoding)

**Fix.** BT Proxy's syslog messages were missing the timestamp and hostname
header — they went straight from the `<PRI>` priority to `btproxy:`. A SIEM's
pre-decoder (Wazuh, rsyslog, graylog) needs that header to identify the program
and hand the message to a decoder, so the symptom was "decoder and rules
configured but nothing decodes."

Messages are now standard RFC3164:

```
<142>Aug  5 14:32:37 TUCB-DC-PROXY btproxy[1234]: user=bt001 action=login detail=login from 172.31.104.51
```

The bundled Wazuh files in `deploy/wazuh/` are updated to match and were
rebuilt from scratch (the previous `btproxy_rules.xml` had duplicated fragments
and would not have loaded):
- `btproxy_decoders.xml` — a `program_name` decoder plus two field decoders
  (one for lines carrying a source IP, one for the rest).
- `btproxy_rules.xml` — 23 rules in the 110200–110239 range: auth
  success/failure, brute-force correlation, lockout, MFA failure, and
  high-severity events (license tamper, factory reset, backup restore,
  full-access grant, config changes).

After updating BT Proxy, restart the Wazuh manager so it reloads the decoder
and rules.

---

## v1.13.0 — DC-DR replication (high availability)

Replicates policy configuration between a primary (DC) and a second node (DR)
over your existing DC-DR VPN/ADVPN tunnel. Settings -> DC-DR replication.

**Two modes:**
- **Active-Passive (recommended):** one primary, one read-only standby. The
  primary pushes config on every change and on a safety-sync timer. The standby
  refuses all local config edits (drift is impossible) and shows a banner. On
  failure, an admin promotes the standby with a typed confirmation. Manual
  failover only - automatic promotion is deliberately not offered, because two
  primaries (split-brain) is worse than a brief outage.
- **Active-Active:** both nodes serve and accept edits, pushing to each other.

**What replicates:** access rules/branches, ports, full-access entries, ACL
list files, dependency lists, and policy settings (proxy behaviour, SMTP alert
targets, syslog target, AD auth config, backup schedule).

**What never replicates (each node keeps its own):** users, passwords, MFA
secrets, the TLS certificate, secret.key, the licence, and node-local settings
(hostname, SSL on/off and paths, AD CA-file path, syslog host, and the DR
config itself). This means a compromise or DB tamper on one node cannot
propagate identity or accounts to the other.

**Security:** every transfer is HMAC-SHA256 signed with a shared secret and the
sender's IP is checked against the configured peer, on top of the encrypted
tunnel. The receive endpoint returns 404 when the feature is off. An
active-passive primary refuses incoming pushes. Received config is validated
with `squid -k parse` BEFORE it is applied - if it fails, the node keeps its
last-good config and audits the rejection, so a standby always stays reliable.
Bundles are path-traversal checked before extraction.

No new dependencies (uses stdlib urllib over the existing app port).

---

## v1.13.1 — DR peer port defaults to the app port

The DC-DR receive endpoint is served by the web app itself (no separate
listener), but the peer-port default was a hardcoded 8443 that did not match the
app's actual port. A push therefore went to a port nothing listened on. The
default now tracks `LISTEN_PORT` (8800 by default), in the settings default, the
UI field, and the push/save code. Existing installs: set DR peer port to the
peer's web app port.
