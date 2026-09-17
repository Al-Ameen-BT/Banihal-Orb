# BT Proxy — Full Features & Functions (Proxy Control Center)

BT Proxy is a web-based **Proxy Control Center** for managing a Squid caching proxy.
It turns raw Squid ACL work — whitelists, blacklists, per-subnet rules, ports,
config reloads — into a role-based web console with live monitoring, auditing,
backup, disaster-recovery and self-update.

This document is the complete functional/UI spec for the product.

---

## 1. Product personality

- **One panel, three roles.** `viewer` (read-only monitoring), `editor`
  (add/edit rules, no user/global config), `admin` (everything). Enforcement is
  server-side on every route, not just hidden menus.
- **License-gated config.** Access Lists and Network Rules lock to read-only the
  moment the trial/license expires. Monitoring (logs, sessions, reports,
  dashboard) stays available.
- **No downtime edits.** Every whitelist/blacklist change lands on disk
  instantly; the operator explicitly presses **Reload Squid** (`squid -k parse`
  then `squid -k reconfigure`) — no service restart, no dropped connections.
- **Everything is audited.** Every config action is written to an audit trail,
  forwarded to syslog (RFC3164, Wazuh-parsable), and email-alerted when the
  event class warrants it.

---

## 2. UI / UX specification

### 2.1 Global shell (`base.html`)

- **Brand** block in the sidebar: LED indicator + `app_title` + `app_subtitle`
  (both changeable in Settings → Branding). A `static/logo.png` replaces the LED
  when present.
- **Sidebar navigation**, role-filtered:
  - All roles: Dashboard, Access Lists, Network Rules, Live Log, Sessions, Reports
  - Admin only: Users & Audit, Settings, Certificates, Backup & Restore,
    Software Update
- **Active page** highlighted; every nav link is a GET page (no side effects).
- **User footer**: username (mono), role tag, Change password, Two-factor auth,
  Sign out, version + copyright.
- **Flash banner strip** (error/warn/success) rendered above content.
- **License banner**: on expiry a red read-only notice is pinned at the top of
  every page; a warning banner appears within 7 days of expiry. Admin sees an
  inline link to Settings → License.
- **CSRF**: a `meta[name=csrf]` token is injected; every POST form gets a hidden
  `_csrf` input automatically via JS on load.
- **403 page**: rendered in the shell with a friendly "ask an administrator" text.

### 2.2 Login (`login.html`)

- Username + password form (also the **MFA challenge** stage).
- Handles three auth paths seamlessly: local accounts, **Active Directory /
  LDAPS**, and continuing a session with TOTP **two-factor**.
- Shows friendly lockout message after too many failed attempts (5 fails /
  15 min, per username **or** IP).
- After login, `must_change` users are forced straight to Change Password.

### 2.3 Dashboard (`dashboard.html`)

A 5-second auto-refreshing status wall (single `/api/stats` JSON endpoint).
Stat cards, each with label / big value / sub-line and (for % metrics) a
colored bar that turns amber >75%, red >90%:

| Card | Shows |
|------|-------|
| Squid Service | LED (green/red/dim) + service state + version + uptime + RSS RAM |
| Active Sessions | count + source (`cache-manager` or `access-log` fallback) |
| CPU | % + 1-min load average |
| Memory | % + used/total MB |
| Disk (/) | % + used/total GB |
| Last Hour (proxy) | requests + denied + clients + bytes |
| System Uptime | days/hours + boot time |
| Bandwidth (proxy) | bytes in 1h / 24h + 24h request count |
| SSL Certificate | days-left (color-coded) + type + HTTPS on/off + expiry |
| License | Licensed/Trial/EXPIRED + customer + days left (color-coded) |

Below the cards: a **Network bandwidth line chart** (RX green / TX blue,
canvas, 60 points at 5s = 5 min window) with live ↓/↑ bps readout and legend.

### 2.4 Access Lists (`branches.html`)

The heart of the product.

- **Rescan ACL files** button — adopts hand-made ACL files found in the ACL
  directory into tracked branches (ignores `gen_*` machine files).
- **Reload Squid** (amber) + **Restart Squid** (red, admin-only, confirm dialog)
  buttons in the page header.
- **Branch picker**: searchable strip of branch "ports" (name + LED + count),
  `+ New branch` and `Delete branch` (confirm dialog). A branch stores a name,
  description, source IPs/subnets, access mode, and two site lists.
- **New branch** form: name (`[A-Za-z0-9_-]{2,32}`) + optional description.
- **Branch networks** panel: shows source subnets/IPs as removable chips;
  "Add subnet / IP" input; and the critical **Access mode** radio:
  - **Additive** — whitelist + whatever broader rules (its subnet, global) grant.
  - **Exclusive** — the sources may reach ONLY the whitelist; everything else
    denied (whitelist-only).
  - Rules are evaluated most-specific-source-first so a /32 host rule beats the
    /24 subnet containing it.
- **Dependency Finder** (advisory, amber LED): paste a URL →
  **Find dependencies** → the app fetches the page read-only (no JS execution)
  and lists referenced domains (CDNs, fonts, APIs) with:
  - checkbox per domain (already-in-list shows `✓ in list`),
  - **Type** (site / redirect / same site / third-party),
  - **Assessment** (avoid = warning icon + note, likely = ok-text, check = note),
  - **Refs** count.
  - Operator ticks only what the site genuinely needs → **Approve selected**
    adds them to the whitelist. Nothing is ever auto-allowed.
- **Whitelist / Blacklist panels** (two columns):
  - Add form (space/comma separated) with **"include subdomains"** checkbox
    (`.example.com` matches subdomains; unticked = exact host only). IPs/subnets
    accepted too.
  - **Bulk upload** (`<details>`): text file, 1 MB / 5000 entries max, blank
    lines + `#` comments ignored, every line validated like a typed entry.
  - **List tools**: toggle-to-show + live client-side filter box.
  - Multi-select with **select all** (respects the current filter so a filtered
    delete never removes invisible rows) + "Delete selected" with count and
    confirm.
- **One-time squid.conf setup** `<details>`: shows the single `include` line
  the operator must place above `http_access deny all`.

### 2.5 Network Rules (`network.html`)

- **Extra Safe_ports** — HTTP ports allowed beyond Squid defaults (e.g. `8080`,
  `8000-8100`). Add / remove, validated `1-65535` or `low-high`.
- **Extra SSL_ports** — HTTPS CONNECT ports beyond 443.
- **Full internet access** table — hosts/subnets that bypass all branch lists:
  - Source (IP or CIDR), description, duration (Permanent or Temporary
    1–24 hours), optional **daily time window** (day checkboxes Mon–Sun +
    `from HH:MM` / `to HH:MM`, start < end enforced).
  - Rows show schedule: `TEMP until …`, day letters + window, or `always`.
  - Remove with confirm.
- **Expiry auto-purge**: expired temporary rules are silently removed by the
  background purge loop and on page load.
- Same Reload/Restart button group + one-time squid.conf snippet.

### 2.6 Live Log (`logs.html`)

- Live tail of `/var/log/squid/access.log` (last 5000 lines, 200 per refresh),
  auto-refresh on/off (5s).
- Filters: free-text (url/result/user), **client IP starts-with**, direction
  (allowed/denied), HTTP method.
- Monospace table: time · client · user · result · method · URL · bytes;
  DENIED rows visually flagged.

### 2.7 Sessions (`sessions.html`)

- Live **concurrent sessions**: primary source is the Squid cache-manager
  (`/squid-internal-mgr/active_requests`); if unreachable it falls back to
  grouping recent access.log entries (client seen within 120s = active).
- Auto-refresh (5s), source tag shown prominently, sortable-ish table.

### 2.8 Reports (`reports.html`)

Form: date range (From/To, auto-swapped if reversed) + report type +
output (view / CSV download). Three types:

1. **Website access log** — one row per request (time, client, user, result,
   method, URL, bytes) with optional client/user/domain/denied-only filters;
   streams to CSV (formula-injection-safe quoting); view capped at 500 rows.
2. **User activity summary** — per client+user: requests, denied, MB
   transferred, top 5 sites.
3. **Audit log** — time, GUI user, action, detail from the audit trail.

CSV export is streamed for large reports (never buffers the whole file).

### 2.9 Users & Audit (`users.html`)

- Console users table: username, role (admin / editor / viewer), MFA status,
  AD shadow-user flag, created date. Create user, change password, set role,
  delete, toggle MFA; AD users shown but cannot get a local password.
- **Recent activity**: last N audit rows (time, user, action, detail).

### 2.10 Settings (`settings.html`)

Sectioned admin panel:

- **Branding** — app title / subtitle.
- **Logo** — upload/replace `static/logo.png`.
- **Password policy** — min length, complexity (off/medium/strong), history
  (last N cannot be reused), expiry days.
- **License** — current status (trial/licensed + days left) + key entry.
- **Email alerts (SMTP)** — server, port, SSL/TLS, auth user/password (stored
  encrypted), recipients, per-class alert toggles (auth lockouts, config
  changes, squid restart failures, license/cert warnings), **Test connection**.
  Passwords are Fernet-encrypted via `crypto_util` with a key backed up in
  every backup archive.
- **Dependency Finder category lists** — import/count advisory classification
  lists used by the Dependency Finder.
- **Active Directory authentication (optional)** — host(s), port, LDAPS/STARTTLS,
  base DN, bind user/password, admin/editor/viewer group mapping, **Test
  connection** with actionable diagnostics.
- **Syslog server (central log forwarding)** — host, port, UDP/TCP; every audit
  event is forwarded as RFC3164 (`<PRI>Mmm dd HH:MM:SS host btproxy[pid]: …`),
  pre-decoder friendly for Wazuh.
- **DC–DR replication (HA)** — enable, node role (DC = primary push, standby =
  read-only), peer host/port, shared secret, verify-cert toggle, sync interval.
- **SSL toggle** — HTTPS on/off for the web GUI.

### 2.11 Certificates (`certificates.html`)

- **Current certificate**: subject, SANs, validity, days-left colour, HTTPS
  status; history of previous certs.
- **Generate self-signed** (CN, SANs, years).
- **Import purchased certificate** (cert + key + optional passphrase), chain
  building, on-install backup of whatever was running.
- **CSR generation** → copy the CSR to your CA, then import the reply.
- **Restore** a previously backed-up certificate.
- SSL enforced at the web server layer; HSTS + secure cookies added only when
  HTTPS is on.

### 2.12 Backup & Restore (`backup.html`)

- **Create a backup** — one-click archive of settings, branches, network map,
  database, ACL lists, deployment lists, crypto key + certs. Note to operator:
  contains password hashes, MFA secrets and the key decrypting stored SMTP
  passwords — store securely.
- **Email the archive** after creation (optional).
- **Automatic backup schedule** — off/daily/weekly/monthly, time of day
  (server local), weekday or day-of-month, retention count, keep-N pruning.
- **Backups on this server** — list, download, inspect (manifest), delete.
- **Restore from backup** — one-click back to a snapshot; also the only path to
  unlock a forgotten MFA (restore + reset flow).
- **Factory reset** — wipes configuration to defaults (optionally keeping the
  admin username).

### 2.13 Software Update (`update.html`)

- **Squid proxy package**: Check for updates / Upgrade via the root helper
  wrapper (`btproxy-squid-update`).
- **BT Proxy update**: upload an update package → inspect (verifies signature
  over SHA-256s, version checks, protected-file list) → confirm → apply →
  history of past updates + rollback list. Update never touches config/data
  files.

---

## 3. Role matrix (functions per role)

| Function | viewer | editor | admin |
|---|---|---|---|
| Dashboard / Live Log / Sessions / Reports | ✔ | ✔ | ✔ |
| Add/remove whitelist & blacklist entries | – | ✔ | ✔ |
| Bulk upload, dependency approve | – | ✔ | ✔ |
| Branch create/delete, sources, mode | – | ✔ | ✔ |
| Port rules, full-access rules | – | ✔ | ✔ |
| Reload Squid | – | ✔ | ✔ |
| Restart Squid | – | – | ✔ |
| Users & audit | – | – | ✔ |
| Settings (all), Certificates | – | – | ✔ |
| Backup / Restore / Factory reset | – | – | ✔ |
| Software update | – | – | ✔ |

Enforcement: `login_required`, `admin_required`, per-route role checks, the
`config_license_required` decorator, and a **standby node write-guard** that
403s every config POST on a DR standby except auth/DR actions.

---

## 4. Key product behaviours

- **Safety net paths** are security-critical: only one gunicorn worker saves
  generated config; writes are atomic (`tmp` + rename); expired rules are
  purged; phantom generated branches are healed; mis-stored ACL paths are
  resolved on every load.
- **Fail-safe squid ops**: every reload/restart first runs `squid -k parse`;
  restart uses `systemctl --no-block` (never blocks > squid's 30s
  shutdown_lifetime) then polls `systemctl is-active` to report the real result.
- **Anti-rollback licensing**: a high-water clock blocks license extension by
  rolling the system clock back, and logs `license-tamper` to syslog.