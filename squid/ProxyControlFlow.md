# BT Proxy — Control Flow

End-to-end flows through the Proxy Control Center: how an operator change
becomes a live Squid rule, how the app peers into Squid, and what the
background processes do while nobody is looking.

---

## 1. One config change, end to end

Typical scenario: an operator adds `he.example` to branch `Calicut_BR03`'s
whitelist.

```
Operator POSTs /branches/add-url (form: branch, kind=whitelist, domains)
   │
   ├─ security_gate()          # CSRF check, standby write-guard, idle timeout
   ├─ login_required           # session valid
   ├─ role check               # viewer is 403
   ├─ config_license_required  # expired license → redirect to Settings
   │
   ├─ split_entries()          # validation + normalisation
   │    • domain → canonical dot form  (he.example → he.example)
   │    • "include subdomains" on → ".he.example" semantics via leading dot
   │    • IP/CIDR entries are separated out into the branch's _ips
   │    • dedupe, reject invalid hostnames/IPs, enforce bulk limits
   │
   ├─ write_acl(<branch>_whitelist.txt, entries)   # canonical, sorted, de-duped
   │    • the .txt IS the Squid dstdomain file (no IPs ever in it)
   ├─ save_branches(branches.json)                  # path + _ips updated
   ├─ audit("acl-add", ...)                         # DB row + syslog + email
   └─ _maybe_dr_push("change:acl-add")              # replicate to DR peer
```

Note: ACL files are written immediately; Squid does **not** know yet. The
operator later clicks **Reload Squid**:

```
POST /squid/apply
   ├─ run_squid(squid -k parse)          # config check
   │     └─ fail → flash error, ABORT (no reload on invalid config)
   ├─ run_squid(squid -k reconfigure)    # live reload, zero downtime
   ├─ audit("squid-reload", ok/fail)
   └─ flash result
```

**Restart Squid** (admin only) is the heavier cousin: parse check →
`systemctl --no-block restart squid` (returns immediately — a blocking call
would routinely blow past timeouts because squid's default `shutdown_lifetime`
is 30s) → poll `systemctl is-active squid` until `active` (45s deadline) →
report the actual state.

---

## 2. Config generation — the single include file

Every GUI-managed rule ends up in one generated file
`/etc/squid/acls/webgui_generated.conf`, which `squid.conf` includes with one
line placed just above `http_access deny all`:

```
acl Safe_ports port 8080 ...                      # extra ports (if any)
acl SSL_ports  port 8443 ...

acl fullaccess_1 src 172.31.11.55                 # full-access hosts
http_access allow fullaccess_1 [fullaccess_1_time]  # time-windowed variant

acl <n>_net src <sources...>                      # per-branch rules
acl <n>_blacklist dstdomain "<branch>_blacklist.txt"
http_access deny  <n>_net <n>_blacklist           # deny wins, then allow
acl <n>_whitelist dstdomain "<branch>_whitelist.txt"
http_access allow <n>_net <n>_whitelist
http_access deny  <n>_net                          # only in "exclusive" mode

# …every branch, emitted most-specific-source first…
```

Ordering guarantees (security-critical):

1. **Most-specific source first.** Branches are sorted by subnet prefix span
   (`branch_specificity()`), so a `/32` host rule or small department range is
   emitted before the `/24` that contains it. Squid stops at the first
   `http_access` match, so per-PC rules really win.
2. **Blacklist before whitelist** — deny is evaluated first.
3. **Exclusive mode** adds a scoped `http_access deny <n>_net`, which cannot
   leak to other sources (it is guarded by the rule's own `src` ACL) and, being
   emitted before broader overlapping rules, never lets a wider subnet widen a
   department's access.

The file is written **atomically** (`*.conf.tmp` → `os.replace`) so Squid never
reads a half-written ACL, then `prune_generated_lists()` deletes orphaned
`gen_*` companion files no rule references.

### Entry handling rules

- The list `.txt` files hold **canonical leading-dot domain forms**, de-duped,
  with redundant subdomains collapsed (`a.b.example.com` ⊂ `.example.com`).
- **IPs/CIDRs never live in the .txt** — inside `dstdomain` Squid would
  reverse-resolve them at runtime. They are stored in `branches.json` as
  `<kind>_ips` and emitted as `dst` ACLs in groups of 8.
- A one-time `acl_schema` migration converts pre-1.13 bare-domain lists to the
  dot form; it never re-runs, so an operator's deliberate exact-match entry is
  not silently upgraded into a wildcard.
- `heal_branches()` runs on every branch load: drops phantom `gen_*` branches,
  resolves missing/incorrectly-stored list paths to the conventional files, and
  migrates stale lists.

---

## 3. Live telemetry flow

`/api/stats` (polled by the dashboard every 5s):

```
api_stats()
  ├─ cpu_percent(), mem_info()        # /proc parsing
  ├─ disk usage via os.statvfs("/")
  ├─ net_rate()                       # RX/TX bps from /proc/net/dev
  ├─ squid_info()                     # systemctl is-active + version + RSS
  ├─ sessions_from_cachemgr()         # http://127.0.0.1:3128/squid-internal-mgr/active_requests
  │     └─ unreachable → sessions_from_log()   # group access.log, 120s window
  ├─ log_hour_stats()                 # last hour: requests/denied/clients/bytes
  ├─ traffic_totals()                 # 1h + 24h bytes and requests
  ├─ cert_manager.inspect_current()   # SSL cert days-left
  ├─ license_status()                 # trial/licensed + days_left
  └─ uptime, load
```

`/api/logs` tails `access.log` (last 5000 lines, 200/page) with
client/user/result/method filters; `/api/sessions` returns the session list.
All three are `login_required`; a redirect (expired idle session) is handled
client-side by checking `r.redirected`.

---

## 4. Background micro-processes

### 4.1 Scheduler daemon thread (`scheduler.py`)

Wakes every 60s (first wake delayed 20s for boot). A PID lock file means **only
one** gunicorn worker runs it (re-claimed if that worker dies). Runs three jobs:

- **Scheduled backup** — daily/weekly/monthly at HH:MM (server local), at most
  once per calendar day (state in `scheduler_state.json`). Creates the archive,
  prunes to `backup_keep`, optionally emails it.
- **Daily housekeeping alerts** — once per day (≥ 8:00): cert expiry warning
  (≤ 30 days) and license expiry warning (≤ 14 days) by email.
- **Periodic DR safety sync** — every `dr_sync_interval` (≥ 60s): re-pushes the
  current config bundle to the DR peer so a change that failed to land while the
  peer was briefly down is caught and healed.

### 4.2 Purge loop (`_purge_loop`)

Wakes every 60s, claims `flock` on `.purge.lock` (skips if another worker owns
it). Calls `purge_expired_access()` which clears expired full-access rules,
regenerates config, reloads Squid and audits `fullaccess-expired`. Also runs
on `/network` page load, so expiry is never more than ~60s stale.

### 4.3 DR sync worker (`dr_sync.py` + threaded POST)

Config-changing actions (`acl-`, `branch-`, `port-`, `fullaccess-`,
`depfind-approve`, `deplist-`, `settings`, `user-`) trigger a **push**: a
`build_bundle()` tarball of settings, branches.json, network.json, ACL dir and
deplists, HMAC-signed with the shared secret, POSTed to
`https://<peer>:<port>/dr/sync` on a daemon thread (never blocks the request).
The peer `dr_receive` verifies the signature + source header, `apply_bundle()`
writes atomically and regenerates ACLs. `dr-*` actions are excluded from the
push prefixes so a received bundle never re-pushes (no replication loop).

On a **standby** node, `security_gate()` 403s every config POST not on the
allowlist (`login`, `logout`, `mfa*`, `password`, settings-dc/dr, `dr_sync_now`,
`dr_receive`) — one central guard, so no forgotten route can cause DC/DR drift.

### 4.4 Async mailer (`mailer.send_async`)

Email sends run on a fire-and-forget daemon thread so a slow SMTP server can
never stall a web request. `audit()` decides whether to alert via
`mailer.should_alert()` (critical classes always; others behind their SMTP
alert toggles).

### 4.5 Syslog forwarding

`audit()`/`audit_anon()` also call `syslog_send()` — lazily built RFC3164
formatter on a UDP/TCP `SysLogHandler` (facility LOCAL1), so Wazuh or any
collector sees `/btproxy/`-tagged, pre-decoded lines.

---

## 5. Auth flow

```
login (local)           login (AD/LDAPS)         MFA step
   │                        │                      │
   ├─ rate-limit check ◄────┤                      │
   ├─ verify werkzeug hash  ├─ ldap3 bind to AD    │
   ├─ merge legacy dupes    ├─ role from groups    │
   └─ record/clear fails    └─ shadow local row    │
                         └──► if user.mfa_enabled ─┘
                              complete_login(): user + mfa challenge
                                                   └─ pyotp.verify /totp
```

- Failed logins (username OR IP, 5 in 15 min) → temporary lockout.
- AD shadow users have an **empty password hash** — they physically cannot use
  the local path; MFA is preserved across a legacy UPN→canonical merge (so it
  can't be bypassed by logging in under the old form).
- Password policy checks: min length, complexity mode, reuse history,
  expiry — enforced server-side at set time, not only client-side.
- Session: 8h absolute lifetime, 30-min idle logout, per-request `last_seen`,
  HTTP-only + SameSite=Lax cookies, Secure flag auto-added over HTTPS.
- Response security headers on every request: `X-Frame-Options: DENY`,
  `nosniff`, `Referrer-Policy`, strict CSP, HSTS when HTTPS.

---

## 6. License & anti-tamper flow

`license_status()` decides trial (install date + 30 days) vs licensed (Ed25519
signed key). `_effective_today()` maintains a **high-water clock** in
settings.json: if the system clock moves back more than a day, expiry math
keeps using the highest time ever seen and logs `license-tamper` (Wazuh rule
110213) at most hourly. The check rides on every config-guarded route via the
`config_license_required` decorator.

---

## 7. Backup, restore & update flows

- **Backup** (`backup_manager.create`): tars a manifest + settings.json +
  branches.json + network.json + squidui.db + ACL dir + deplists + certs +
  crypto key into `backups/`. `restore` validates the manifest, takes a safety
  snapshot first, then applies. `factory_reset` wipes to defaults.
- **Update** (`update_engine`): uploaded package → manifest read →
  `verify_package` (Ed25519 signature over per-file SHA-256s + version check +
  DENIED files must not be written) → backup of current version →
  `apply_package` extracts payload (config/data excluded) → previous version
  added to rollback list. Package helper for Squid itself runs through the
  root-owned wrapper `btproxy-squid-update`.

---

## 8. Start-up sequence (app.py import / gunicorn)

```
init_db()            # schema + migrations + default admin (forced pw change)
save_branches()/net  # seed empty JSON maps if absent
generate_conf()      # rebuild the include file early (best-effort)
_purge_loop thread   # starts
scheduler.start()    # scheduler thread starts
gunicorn (multiple workers, one owns the scheduler via PID lock)
```

Failure isolation principle: every background job is wrapped in `try/except`
that swallows and continues — a failed alert, DR push, backup or purge can
never take the control center down.