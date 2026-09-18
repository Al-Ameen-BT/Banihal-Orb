# BT Proxy — Application Full Description

**BT Proxy** (Squid Web GUI) is a server-managed **web console** that turns a
raw Squid caching proxy into an operator-facing product: per-branch access
lists, network rules, live monitoring, user management, auditing, backups,
disaster recovery and self-update — all from a browser, no SSH and no hand-edited
`squid.conf`.

Product name: **BT PROXY — proxy control panel** (branding is configurable).
Version: read from `VERSION` (kept intentionally out of any update package).
Built by Banihal Technologies LLP.

---

## 1. The problem it solves

Whitelist/blacklist management for a Squid proxy historically means:

- SSH-ing to the server,
- keeping dozens of `.acl` files straight by hand,
- remembering which subnet is meant to be whitelist-only vs additive,
- carefully ordering `http_access` lines so a /32 host rule beats its /24 subnet,
- hunting through a raw access.log to see who's being denied,
- editing `squid.conf` to open a port or grant temporary full internet access.

BT Proxy replaces all of it with a role-based GUI that writes *one* generated
include file, is evaluated most-specific-src-first, auto-purges expired rules,
and audits everything to the audit trail + syslog + email.

---

## 2. Domain model

### Branch (access rule)
A named group — e.g. `Calicut_BR03` — with:
- **description**
- **sources**: the IPs/subnets the rule applies to
- **mode**: `additive` (whitelist plus broader access) or `exclusive`
  (whitelist-only; everything else denied)
- **whitelist / blacklist**: two site lists — domains stored canonically in a
  `.txt` that Squid reads directly (`dstdomain`), IP/CIDR entries stored in
  `branches.json` (`<kind>_ips`) and emitted as `dst` ACLs
- paths automatically healed, schema-migrated and de-duplicated on load.

### Network map
- `safe_ports` / `ssl_ports`: extra allowed HTTP/HTTPS-CONNECT ports
- `full_access`: hosts that bypass branch rules — permanent, temporary
  (N hours, auto-purged), or on a recurring daily time window.

### User
`username`, `role` (viewer/editor/admin), local or AD shadow record, optional
TOTP MFA, password history + expiry, forced-change flag.

### Audit event
`ts · user · action · detail`, stored, syslog-forwarded (RFC3164 → Wazuh) and
optionally emailed per event class.

---

## 3. Application layers

### 3.1 Web layer (Flask)
- 60 server-rendered routes (16 pages) + 3 JSON endpoints (`/api/stats`,
  `/api/logs`, `/api/sessions`).
- All POSTs are CSRF-protected; every page/page-element is role-gated; idle
  sessions expire; DR standby blocks config writes centrally.
- 16 Jinja2 templates share one shell (`base.html`) and one CSS file.

### 3.2 Domain/engine layer
- **ACL engine** (`app.py`): domain normalisation, dedupe, schema migration,
  path healing, `generate_conf()` with ordering guarantee, atomic writes.
- **Dependency Finder**: reads a URL read-only (no JS), extracts referenced
  domains, classifies (site/redirect/third-party), scores avoid/likely/check,
  operator approves. Categories configurable via deplists.

### 3.3 Persistence layer
- SQLite: users, audit, login_fails, pw_history.
- JSON: branches, network, settings — flat and human-inspectable.

### 3.4 Integration layer
- Squid process control via sudo (parse/reconfigure/restart, is-active poll).
- Cache-manager session introspection with access.log fallback.
- SMTP alerts, syslog forwarding, LDAPS auth, gunicorn.

### 3.5 Lifecycle layer
Four daemon threads (scheduler, purge, DR worker, async mailer) — see
`ProxyControlFlow.md` §4. Single-writer discipline via PID/flock locks so
parallel gunicorn workers never race on generated config or scheduled jobs.

---

## 4. Core features (quick map)

| Area | Features |
|---|---|
| **Proxy control** | per-branch whitelist/blacklist, additive/exclusive modes, subnet/IP sources, bulk upload, Reload/Restart squid with parse-safety |
| **Network rules** | extra Safe/SSL ports, full-access (permanent / temporary / time-windowed), auto-expiry purge |
| **Monitoring** | dashboard status wall + 5min bandwidth chart, live access log, concurrent sessions, reports (access/activity/audit) with CSV export |
| **Governance** | roles (viewer/editor/admin), TOTP MFA, password policy/history/expiry, AD/LDAPS sign-in, login lockouts, full audit + syslog + email alerts |
| **Resilience** | one-click backup/restore/factory-reset, scheduled backups with email, retention, DC–DR replication across two servers |
| **Trust** | Ed25519-signed licenses (anti clock-rollback), verified + signed self-update, certificate lifecycle management (self-signed/import/CSR/backup), SSL toggle |
| **Integration** | Wazuh-ready syslog, SMTP alerting, dependency discoverability of sites |

---

## 5. Cross-cutting invariants

1. **A config change never goes live silently** — every edit is audited; every
   squid reload is parse-checked first.
2. **One worker owns scheduled reality** — PID/flock locks; a dead owner's lock
   is re-claimed.
3. **Write safety** — generated config is atomic (`tmp`+rename); updates never
   overwrite config/data files (DENIED list enforced on the signed package).
4. **Fail-closed alerting** — alerting, pushing, backing up and purging are all
   best-effort and wrapped so a failure can't break the control plane.
5. **Read-only when it must be** — expired license → config locked; DR standby →
   config locked; viewer role → all writes locked. Monitoring always works.

---

## 6. Deployment

- **systemd service** `squid-webgui` → `gunicorn` (workers from
  `gunicorn_conf.py`) → listens on `0.0.0.0:8800` (configurable).
- **sudoers** grants the service account exactly three privileged verbs:
  `squid -k parse`, `squid -k reconfigure`, `systemctl --no-block restart
  squid`, plus `squid-webgui` self-restart and the package-update helper.
- Squid needs exactly **one** line in `squid.conf`, above `http_access deny
  all`:
  ```
  include /etc/squid/acls/webgui_generated.conf
  ```
  and (for live sessions) `http_access allow localhost manager`.
- Supported on Rocky Linux & Ubuntu (Squid from OS packages — identical paths).

---

## 7. Background processes (micro-service summary)

| Process | Owner(s) | Cadence | Job |
|---|---|---|---|
| Scheduler daemon | 1 worker (PID lock) | 60s | scheduled backup, daily cert/license alerts, periodic DR safety sync |
| Purge loop | 1 worker (flock) | 60s | remove expired full-access rules → regen + reload + audit |
| DR worker | trigger/bg thread | on change + periodic | HMAC-sign bundle → push to peer |
| Async mailer | bg thread | per event | SMTP alert never blocks the request |
| Syslog sender | per audit call | sync/lazy handler | RFC3164 forward to Wazuh/collector |

---

## 8. Operations (CLI — `manage.py`)

- `manage.py list` — users, roles, MFA status.
- `manage.py passwd <user>` — reset a password (forced change).
- `manage.py license [--brief]` — license state.
- `manage.py status` — squid + service + key paths health.
- `manage.py regen` — regenerate the ACL include file by hand.

Docs set in `docs/` covers fresh install, updates (incl. rollback), SSL,
email/backup/reset, license creation, package building, AD/LDAPS and DC/DR
replication, plus a troubleshooting guide with shared security notes.