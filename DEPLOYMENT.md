# Production Deployment Guide

This guide deploys the B2B SaaS platform: an **Express + TypeScript** API (`/server`) and a
**Next.js 14** frontend (`/client`), backed by **PostgreSQL** (five databases), with an optional
**Ollama assistant** and **Slack bot** integrations.

> Database schemas are provisioned by **idempotent SQL DDL** in `server/db/` (see §3) — this
> replaced `prisma db push`. Re-running is safe and never drops data. Prisma _clients_ are still
> generated (`npm run db:generate`). **Always back up before a schema change** regardless.

---

## What changed recently

Deploying an existing install? These landed in the latest updates — review before upgrading:

- **SQL-first DB provisioning** (replaces `prisma db push`). Schemas live as idempotent SQL DDL in
  `server/db/`; provision with `npm run db:provision` and gate the deploy with `npm run db:verify`.
  `db:push` is deprecated (now forwards to `db:provision`). See §3.
- **MFA is now opt-in (default off).** Email MFA is a per-user profile toggle — or org-enforced via
  `Customer.mfaRequired` — so a normal login no longer sends a code. SMTP is only needed for users
  who enable 2FA and for password resets.
- **Admin ticket store is required, no fallback.** `ADMIN_TICKETING_DATABASE_URL` must be set and
  reachable (`b2b_ticketing_admin`); the API fails loudly instead of using the shared store.
- **SSO toggle removed** from the UI — it was a non-functional stub (no real SSO auth exists).
- **Login routing fixes.** The Next `middleware.ts` matcher now excludes `/api` (page-auth no longer
  redirects API calls) and exempts `/sw.js`; the browser calls the API same-origin via `/api`, so
  `NEXT_PUBLIC_API_URL` must point at an API address the **Next.js server** can reach.
- **Web Push notifications.** Adds a `PushSubscription` table to the **main** DB and requires `VAPID_*`
  on the server + `NEXT_PUBLIC_VAPID_PUBLIC_KEY` on the client. Files: `server/src/lib/webpush.ts`,
  `server/src/modules/push/*`, `client/public/sw.js`, `client/src/lib/push-client.ts`.
- **Ticketing tenant isolation.** Ticket reads/attachments/comments are scoped to the caller's org
  (closed a cross-org IDOR). No config change.
- **Rate limiting behind Nginx.** The API sets `trust proxy = loopback`, so limits key on the real
  client IP behind Nginx.
- **Single systemd unit.** `deploy.sh` now installs one `b2b.service` (API + Web supervised in one
  unit) instead of separate `b2b-api`/`b2b-web` units, and removes the old pair on upgrade.
- **Non-root deploy.** The systemd unit runs as a dedicated non-root user with a hardened sandbox.
- **Admin-domain hardening.** `ADMIN_DOMAINS` must be private work domains; public mailbox domains
  are a privilege-escalation risk (any signup → `ADMINISTRATOR`).

---

## 1. Architecture & ports

```
                         ┌──────────── Nginx (443, TLS) ────────────┐
   Browser ───────────►  │  /            → Next.js  (127.0.0.1:3000)│
                         │  /api, /health→ API      (127.0.0.1:3001)│
                         └──────────────────────────────────────────┘
                                   │                     │
                                   ▼                     ▼
                        PostgreSQL (5 DBs)      Ollama agent (127.0.0.1:8001) — optional
                                                Slack (outbound WebSocket/HTTPS) — optional
```

Serving **both apps behind one origin** (Next at `/`, API at `/api`) is strongly recommended: it
makes requests same-origin, so the `SameSite=Lax` auth cookies "just work" and CORS is trivial.

| Component | Port (bind localhost) | Public? |
|---|---|---|
| API (`node dist/server.js`) | 3001 | via Nginx `/api` + `/health` |
| Frontend (`next start`) | 3000 | via Nginx `/` |
| PostgreSQL | 5432 | **no** (localhost/VPC only) |
| Ollama agent / Ollama | 8001 / 11435 | **no** (localhost only) |

---

## 2. Prerequisites

- **Node.js 20 LTS** and npm (both apps target Node 20).
- **PostgreSQL 14+**. `gen_random_uuid()` is built into core (PG 13+), so **no `pgcrypto` extension or
  `*-contrib` package is required** — the ticket-store DDL tries `pgcrypto` but tolerates its absence.
- **Nginx** (reverse proxy + TLS termination) and **certbot** (Let's Encrypt), or your own certs.
- A working **SMTP account** — needed for **email MFA** (opt-in per user, default off) and
  **password resets**. MFA is off by default, so mail isn't required just to log in — but any user
  who enables 2FA (or an org that sets `mfaRequired`) can't complete login without working mail.
- (Optional) **Ollama** + the Analytics Agent for the in-app assistant / Slack chat bridge.

---

## 3. Databases (four SQL-provisioned + the admin ticket store)

Four databases' schemas are provisioned by **idempotent SQL DDL** in `server/db/`
— this replaces `prisma db push` as the schema source of truth (safe to re-run;
never wipes data). Prisma _clients_ are still generated with `npm run db:generate`.
The fifth, the Administrators' isolated ticket store, is **required** and loaded
from the custom-format pg dump `ticketingDB` (repo root) — **not** from a `.sql`
file.

| Database | Env var | Created / schema | Notes |
|---|---|---|---|
| `b2b` (main) | `DATABASE_URL` | `db/b2b.sql` | Users, tenants, bots, MFA, audit, AD secrets |
| `b2b_chat` | `CHAT_DATABASE_URL` | `db/b2b_chat.sql` | Assistant chat history |
| `b2b_ticketing` | `TICKETING_DATABASE_URL` | `db/b2b_ticketing.sql` | Internal 2-table fallback store |
| `b2b_ticket` | `TICKET_DATABASE_URL` | `db/b2b_ticket.sql` | 14-table external ticket platform |
| `b2b_ticketing_admin` | `ADMIN_TICKETING_DATABASE_URL` | `pg_restore` of `ticketingDB` | Administrators' isolated store — **required, no fallback** |

Provision the four SQL databases in one step (reads the DB URLs from `server/.env`):

```bash
cd server && npm run db:provision      # = bash db/provision.sh
```

Or manually:

```bash
sudo -u postgres psql -f server/db/00_databases.sql        # create the 5 databases
psql "$DATABASE_URL"           -f server/db/b2b.sql
psql "$CHAT_DATABASE_URL"      -f server/db/b2b_chat.sql
psql "$TICKETING_DATABASE_URL" -f server/db/b2b_ticketing.sql
psql "$TICKET_DATABASE_URL"    -f server/db/b2b_ticket.sql

# Admin ticket store — load the schema from the dump (ONLY on a fresh, empty DB;
# the dump is schema-only, so a --clean restore would drop existing tickets):
pg_restore -d "$ADMIN_TICKETING_DATABASE_URL" ticketingDB
```

> ⚠️ `ADMIN_TICKETING_DATABASE_URL` is **required** and has **no fallback**. The
> admin ticketing store always uses its own `b2b_ticketing_admin` database; if it
> is unset or unreachable the API fails loudly rather than reading/writing the
> shared `b2b_ticket` store. `npm run db:verify` checks it alongside the others.

> ℹ️ `npm run db:push` is **deprecated** and now just forwards to `db:provision`
> (the old Prisma push could wipe/recreate `b2b_ticketing`). See
> `server/db/README.md` for details.

---

## 4. Environment variables

Copy `server/.env.example` → `server/.env` and fill in. **Generate every secret** with
`openssl rand -hex 32`. Beyond the example file, set these (added by recent features):

| Var | Required | Purpose |
|---|---|---|
| `DATABASE_URL`, `CHAT_DATABASE_URL`, `TICKETING_DATABASE_URL`, `TICKET_DATABASE_URL` | ✅ | The four core DBs |
| `ADMIN_TICKETING_DATABASE_URL` | ✅ | Administrators' isolated ticket store (`b2b_ticketing_admin`) — **required, no fallback**; the API won't start without it |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `IMPERSONATION_SECRET` | ✅ (≥32 chars) | Token signing |
| `SLACK_TOKEN_SECRET` | ✅ if using bots | **Encrypts Slack bot tokens, webhook URLs, and AD temp-passwords at rest.** Falls back to `JWT_ACCESS_SECRET`. **Back it up — if lost, all encrypted secrets become unrecoverable; if changed, existing ones stop decrypting.** |
| `PASSWORD_PEPPER` | Optional | Keys the one-way fingerprint used to detect **shared passwords across accounts**. Falls back to `JWT_ACCESS_SECRET`. **Keep it stable** — changing it invalidates every stored fingerprint, so existing duplicates go undetected until those users next set a password. |
| `NODE_ENV` | ✅ | Set to `production` |
| `PORT` | ✅ | `3001` |
| `COOKIE_SECURE` | ✅ | `true` under HTTPS (else the browser drops the auth cookie) |
| `ALLOWED_ORIGINS` | ✅ | Exact public origin(s) of the frontend, comma-separated (e.g. `https://app.example.com`) |
| `FRONTEND_URL` | ✅ | Public app URL — used to build password-reset links in emails |
| `ADMIN_DOMAINS` | ✅ | Comma-separated email domains allowed to hold `ADMINISTRATOR`. **Empty = admin login disabled.** ⚠ **Use only PRIVATE work domains you control** — registration grants `ADMINISTRATOR` from the email domain, so listing a public mailbox domain (`gmail.com`, `outlook.com`, …) lets ANY signup on that domain become a platform super-admin. |
| `SMTP_HOST/PORT/USER/PASS`, `MAIL_FROM` | ✅ | MFA + password-reset email. **`MAIL_FROM` must be an address the SMTP account is authorized to send as** (e.g. Outlook/Gmail reject a mismatched From), or MFA codes silently fail to send. |
| `SESSION_INACTIVITY_MINUTES` | optional | One active session per account is **always enforced**; this is the idle window (default 30 min) after which a stale session can be taken over by a new login. |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | optional | **Web Push notifications.** Generate with `npx web-push generate-vapid-keys`. `VAPID_PRIVATE_KEY` is a **secret** — never expose/log it. `VAPID_SUBJECT` is a `mailto:`/`https:` contact URI. When unset, push sending is disabled (503). |
| `MFA_CODE_TTL_MINUTES`, `MFA_MAX_ATTEMPTS`, `MFA_RESEND_COOLDOWN_SECONDS` | optional | MFA tuning (defaults 10 / 5 / 30) |
| `AGENT_URL`, `OLLAMA_URL`, `OLLAMA_MODEL` | optional | Assistant backend; chat degrades gracefully (503) if absent |
| `UPLOAD_DIR` | optional | Ticket/comment attachment dir (default `uploads`) — **must be on a persistent volume** |
| `TICKETING_API_URL`, `TICKETING_API_KEY` | optional | External ticketing mirror (disabled if unset) |

**Frontend env** — set in `client/.env` (or the build environment). `NEXT_PUBLIC_*` is **inlined at
build time**, so it must be present *before* `next build`:

```bash
# client/.env
NEXT_PUBLIC_API_URL="https://app.example.com"   # same origin as the app when proxied under /api
NEXT_PUBLIC_VAPID_PUBLIC_KEY="<same value as server VAPID_PUBLIC_KEY>"  # Web Push; safe to expose
```

> **API base URL / auth cookies:** the browser calls the API **same-origin** via the relative
> `/api` path (proxied by `next.config.js` `rewrites()` to `NEXT_PUBLIC_API_URL`), so the httpOnly
> auth cookie stays **first-party** to the page and the login flow works regardless of host. Keep
> `NEXT_PUBLIC_API_URL` pointed at an address the **Next.js server process** can reach the API at.
> Behind Nginx (everything under one origin) this is automatic.

---

## 5. Build & run

### API (`/server`)

```bash
cd server
npm ci
npm run db:generate          # generate all 4 Prisma clients (REQUIRED before build)
npm run build                # tsc → dist/
npm run db:provision         # create + apply schema for the 4 SQL DBs (idempotent DDL)
pg_restore -d "$ADMIN_TICKETING_DATABASE_URL" ../ticketingDB   # admin store — FRESH/empty DB only (see §3)
npm run db:verify            # fail-fast: confirm all 5 required DBs are reachable + provisioned
npm run db:seed              # first deploy only — creates the initial administrator; review prisma/seed.ts
node dist/server.js          # or run under systemd (below)
```

### Frontend (`/client`)

```bash
cd client
npm ci
npm run build                # next build (reads NEXT_PUBLIC_API_URL)
npm run start                # next start → 127.0.0.1:3000
```

### systemd (single `b2b.service`)

The app runs under **one** systemd unit — `b2b.service` (repo root). It supervises **both**
node processes (API on `:3001`, Next.js on `:3000`) from one wrapper: each runs in its own
subshell with its own `PORT`, and if **either** exits, the unit restarts the pair. It loads
both `server/.env` and `client/.env`, sets `NODE_ENV=production`, and runs under the
unprivileged `b2bapp` user with a hardened sandbox.

`sudo ./deploy.sh` installs and starts it automatically (and removes any legacy
`b2b-api`/`b2b-web` units from a previous release). To install it **manually**:

```bash
# from the repo root — if your path/user differ from /opt/B2B-Site and b2bapp, edit
# b2b.service first (or let deploy.sh substitute them for you)
sudo cp b2b.service /etc/systemd/system/b2b.service
sudo systemctl daemon-reload
sudo systemctl enable --now b2b
sudo systemctl status b2b
journalctl -u b2b -f                     # combined API + Web logs
curl -s http://127.0.0.1:3001/health     # {"status":"ok","databases":{...}}
```

> One unit means `systemctl restart b2b` restarts **both** processes — you can't bounce the
> API or the web independently. If you need that, run them as two units instead and group
> them with a `b2b.target`.

---

## 6. Nginx reverse proxy + HTTPS

Single origin serving the app and proxying the API (recommended):

```nginx
server {
    listen 443 ssl http2;
    server_name app.example.com;

    ssl_certificate     /etc/letsencrypt/live/app.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/app.example.com/privkey.pem;

    client_max_body_size 20m;                 # ticket attachments (multer, 5 files)

    location /api/ { proxy_pass http://127.0.0.1:3001; }
    location /health { proxy_pass http://127.0.0.1:3001; }

    location / { proxy_pass http://127.0.0.1:3000; }

    # shared proxy headers
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;    # SSE (chat stream) + keep-alive
    proxy_set_header Connection "";
    proxy_read_timeout 120s;                   # assistant SSE can stream up to 90s
}
```

Then: `NEXT_PUBLIC_API_URL=https://app.example.com`, `ALLOWED_ORIGINS=https://app.example.com`,
`FRONTEND_URL=https://app.example.com`, `COOKIE_SECURE=true`. Obtain certs with
`sudo certbot --nginx -d app.example.com` and redirect `:80 → :443`.

---

## 7. Integrations

### Assistant (Ollama) — optional
Run Ollama + the Analytics Agent on the host, bound to localhost, and point `AGENT_URL` at it.
The `/api/chat` route proxies the SSE stream. If the agent is down the chat returns a clean 503 —
the rest of the platform is unaffected.

### Slack bots — optional
- No inbound ports required: **Socket Mode** is an outbound WebSocket and **Incoming Webhooks** are
  outbound HTTPS. Administrators paste the `xoxb-`/`xapp-`/webhook values in the UI; they're stored
  **encrypted** with `SLACK_TOKEN_SECRET`.
- **AD credential ingest** (`POST /api/ad-ingest/deliver`) is authenticated by a per-bot API key,
  **not** a session. If your AD automation runs off-host, ensure it can reach `/api/ad-ingest`
  (and restrict that path at the firewall/WAF to the automation's source if possible).

---

## 8. Security checklist

- [ ] `NODE_ENV=production`, `COOKIE_SECURE=true`, served only over **HTTPS** (HSTS at Nginx).
- [ ] All secrets are unique 32+ char random values; **`SLACK_TOKEN_SECRET` and the JWT secrets are
      backed up** in a secrets manager (losing them logs everyone out / bricks encrypted bot & AD data).
- [ ] `ADMIN_DOMAINS` lists only the provider's real **private** admin domain(s) — **never** a public
      mailbox domain (`gmail.com`, etc.), which would let any signup self-grant `ADMINISTRATOR`.
- [ ] One-session-per-account is always enforced; `SESSION_INACTIVITY_MINUTES` is set to a sane idle window (default 30).
- [ ] `ALLOWED_ORIGINS` is the exact public origin — **not** `*`.
- [ ] The service runs under a **dedicated non-root user** (the `b2b.service` unit defaults to `b2bapp`
      with a hardened sandbox). Do **not** deploy as root.
- [ ] `VAPID_PRIVATE_KEY` is set as a secret and never exposed client-side or logged (only the public
      key reaches the browser).
- [ ] PostgreSQL is **not** exposed publicly; strong DB passwords; least-privilege DB roles.
- [ ] SMTP verified end-to-end (do a real login — you must receive the MFA code); `MAIL_FROM` matches
      an address the SMTP account may send as.
- [ ] `UPLOAD_DIR` on a persistent, backed-up volume; Nginx `client_max_body_size` set.
- [ ] Rate limiting is on (global + AD-ingest). **The API sets `trust proxy` so limits key on the real
      client IP behind Nginx** — front with a WAF if internet-facing.
- [ ] Review `prisma/seed.ts` before seeding in production — remove/replace demo accounts.

---

## 9. Backups & upgrades

**Backups (nightly):**
```bash
for db in b2b b2b_chat b2b_ticketing b2b_ticketing_admin b2b_ticket; do
  pg_dump -Fc "$db" > "/backups/${db}-$(date +%F).dump"
done
tar czf /backups/uploads-$(date +%F).tgz /opt/b2b/server/uploads
# also back up: server/.env  (contains SLACK_TOKEN_SECRET + JWT secrets)
```

**Upgrade / redeploy:**
```bash
git pull
# API
cd server && npm ci && npm run db:generate && npm run build
#   BACK UP DBs, then apply any schema change (idempotent — safe to re-run):
npm run db:provision && npm run db:verify
# Frontend
cd ../client && npm ci && npm run build
# restart (single unit runs both API + Web)
sudo systemctl restart b2b
curl -s https://app.example.com/health
```
CI (`.github/workflows/ci-cd.yml`) runs **checks only** (typecheck/lint) — it does not deploy.

---

## 10. Troubleshooting

| Symptom | Likely cause |
|---|---|
| Login "fails" / cookie never sticks | `COOKIE_SECURE=true` on plain HTTP; or the Next `/api` rewrite target (`NEXT_PUBLIC_API_URL`) unreachable from the Next server |
| Login OK but every page bounces to `/login` | ensure `next.config.js` `rewrites()` is present and the `middleware.ts` matcher **excludes `/api`** (and exempts `/sw.js`) — otherwise page-auth redirects the login API call itself; also confirm `NEXT_PUBLIC_API_URL` is reachable from the Next server |
| Verify screen shows "sent to **undefined**" / login can't complete | the `/api` proxy target is unreachable (wrong/stale `NEXT_PUBLIC_API_URL`) or the API is down — the client renders a broken code screen when it can't get a `mfaRequired:false` response |
| "You're already signed in on another device" blocks login | single-session lock (always on); sign out the other device or wait `SESSION_INACTIVITY_MINUTES` for the stale session to expire |
| MFA code never arrives (2FA-enabled users only) | SMTP misconfigured, or `MAIL_FROM` not authorized by the SMTP account (send silently fails); check `SMTP_*`, `MAIL_FROM`, provider logs. MFA is opt-in, so this only blocks accounts that enabled 2FA |
| Push notifications never arrive | `VAPID_*` unset (send returns 503); `NEXT_PUBLIC_VAPID_PUBLIC_KEY` missing/mismatched; not served over HTTPS (push needs a secure context — `localhost` is exempt); browser blocked notifications |
| Admin can't log in | admin's email domain not in `ADMIN_DOMAINS` (public domains excluded by design) |
| `/health` shows a DB `down` | that database's URL is wrong or the DB isn't created/loaded |
| `db:provision` fails: `invalid URI query parameter: "schema"` | a `*_DATABASE_URL` carries Prisma's `?schema=public` suffix, which `psql` rejects. `provision.sh` strips it automatically; on an older copy, remove `?schema=…` from the URLs in `server/.env` (Prisma and node-`pg` don't need it) |
| `db:provision` fails: `extension "pgcrypto" is not available` | the `*-contrib` package isn't installed — but it isn't needed: `gen_random_uuid()` is core (PG 13+). Delete the `CREATE EXTENSION pgcrypto` line from `db/b2b_ticket.sql`, or `dnf/yum install postgresql<N>-contrib` to keep it |
| `db:provision`/`db:verify`: `password authentication failed for user "user"` | a placeholder credential from `.env.example` was left in a `*_DATABASE_URL`; set the real Postgres user/password (match the other DB URLs — only the database name should differ) |
| Slack bot won't connect | bad `xoxb-` token (status shows **Error**), or missing Socket Mode/`xapp-` for the chat bridge |
| Bot tokens/AD secrets won't decrypt after a redeploy | `SLACK_TOKEN_SECRET` changed or was missing (it fell back to `JWT_ACCESS_SECRET`, which then changed) |
| Assistant returns 503 | `AGENT_URL` unreachable — start Ollama/agent or ignore if unused |
| Uploads vanish after redeploy | `UPLOAD_DIR` not on a persistent volume |
| Build fails with missing `@prisma/*-client` types | ran `npm run build` before `npm run db:generate` |

---

Health endpoint for monitoring/uptime checks: **`GET /health`** → `200` with per-database status,
`503` if any database is down.
