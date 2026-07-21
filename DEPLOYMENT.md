# Production Deployment Guide

This guide deploys the B2B SaaS platform: an **Express + TypeScript** API (`/server`) and a
**Next.js 14** frontend (`/client`), backed by **PostgreSQL** (five databases), with an optional
**Ollama assistant** and **Slack bot** integrations.

> The app uses `prisma db push` (not migrations). Schema changes are applied by re-pushing.
> **Always back up before deploying a schema change** — a push can drop columns.

---

## What changed recently

Deploying an existing install? These landed in the latest updates — review before upgrading:

- **Web Push notifications** (new). Adds a `PushSubscription` table to the **main** DB (applied by
  `npm run db:push`) and requires `VAPID_*` on the server + `NEXT_PUBLIC_VAPID_PUBLIC_KEY` on the
  client. Files: `server/src/lib/webpush.ts`, `server/src/modules/push/*`, `client/public/sw.js`,
  `client/src/lib/push-client.ts`, `client/src/components/EnablePushButton.tsx`.
- **Login cookie fix.** The browser now calls the API **same-origin** via the relative `/api` path,
  so the auth cookie is first-party and login works from any host. The Next `middleware.ts` also
  exempts `/sw.js` (the service worker must be publicly served).
- **Ticketing tenant isolation.** Ticket reads/attachments/comments are now scoped to the caller's
  org (closed a cross-org IDOR). No config change.
- **Rate limiting behind Nginx.** The API sets `trust proxy` so limits key on the real client IP.
- **Non-root deploy.** The systemd unit / `deploy_services.py` now run as a dedicated `b2bapp` user
  with a hardened sandbox (was root).
- **`SINGLE_SESSION_ENFORCED`** env toggle (default `true`) — set `false` only for multi-device testing.
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
- **PostgreSQL 14+** with the `pgcrypto`/`gen_random_uuid()` function available (default in 14+).
- **Nginx** (reverse proxy + TLS termination) and **certbot** (Let's Encrypt), or your own certs.
- A working **SMTP account** — **mandatory**: every login requires an emailed MFA code, so if
  mail can't send, **no one can log in**.
- (Optional) **Ollama** + the Analytics Agent for the in-app assistant / Slack chat bridge.

---

## 3. Databases (five)

| Database | Env var | Created / schema | Notes |
|---|---|---|---|
| `b2b` (main) | `DATABASE_URL` | `prisma db push` (schema.prisma) | Users, tenants, bots, MFA, audit, AD secrets |
| `b2b_chat` | `CHAT_DATABASE_URL` | `prisma db push --schema prisma/chat.prisma` | Assistant chat history |
| `b2b_ticketing` | `TICKETING_DATABASE_URL` | `prisma db push --schema prisma/ticketing.prisma` | Legacy 2-table store |
| `b2b_ticketing_admin` | `ADMIN_TICKETING_DATABASE_URL` | manual push (see below); optional | Administrators' isolated ticket store |
| `b2b_ticket` | `TICKET_DATABASE_URL` | load `prisma/ticketing-full-schema.sql`, then `prisma db pull` | 14-table external ticket platform |

```bash
sudo -u postgres psql -c "CREATE DATABASE b2b;"
sudo -u postgres psql -c "CREATE DATABASE b2b_chat;"
sudo -u postgres psql -c "CREATE DATABASE b2b_ticketing;"
sudo -u postgres psql -c "CREATE DATABASE b2b_ticketing_admin;"
sudo -u postgres psql -c "CREATE DATABASE b2b_ticket;"

# 14-table ticket DB is loaded from SQL (it is NOT managed by prisma db push):
sudo -u postgres psql -d b2b_ticket -f server/prisma/ticketing-full-schema.sql
```

> ⚠️ `npm run db:push` pushes **main + chat + ticketing** and **can wipe/recreate** the 2-table
> `b2b_ticketing`. It does **not** touch `b2b_ticket` (external) or `b2b_ticketing_admin`. Push the
> admin store separately after pointing the URL at it:
> ```bash
> cd server && DATABASE_URL="$ADMIN_TICKETING_DATABASE_URL" \
>   npx prisma db push --schema prisma/ticketing.prisma
> ```

---

## 4. Environment variables

Copy `server/.env.example` → `server/.env` and fill in. **Generate every secret** with
`openssl rand -hex 32`. Beyond the example file, set these (added by recent features):

| Var | Required | Purpose |
|---|---|---|
| `DATABASE_URL`, `CHAT_DATABASE_URL`, `TICKETING_DATABASE_URL`, `TICKET_DATABASE_URL` | ✅ | The four core DBs |
| `ADMIN_TICKETING_DATABASE_URL` | optional | Admin ticket store (falls back to `TICKETING_DATABASE_URL`) |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `IMPERSONATION_SECRET` | ✅ (≥32 chars) | Token signing |
| `SLACK_TOKEN_SECRET` | ✅ if using bots | **Encrypts Slack bot tokens, webhook URLs, and AD temp-passwords at rest.** Falls back to `JWT_ACCESS_SECRET`. **Back it up — if lost, all encrypted secrets become unrecoverable; if changed, existing ones stop decrypting.** |
| `NODE_ENV` | ✅ | Set to `production` |
| `PORT` | ✅ | `3001` |
| `COOKIE_SECURE` | ✅ | `true` under HTTPS (else the browser drops the auth cookie) |
| `ALLOWED_ORIGINS` | ✅ | Exact public origin(s) of the frontend, comma-separated (e.g. `https://app.example.com`) |
| `FRONTEND_URL` | ✅ | Public app URL — used to build password-reset links in emails |
| `ADMIN_DOMAINS` | ✅ | Comma-separated email domains allowed to hold `ADMINISTRATOR`. **Empty = admin login disabled.** ⚠ **Use only PRIVATE work domains you control** — registration grants `ADMINISTRATOR` from the email domain, so listing a public mailbox domain (`gmail.com`, `outlook.com`, …) lets ANY signup on that domain become a platform super-admin. |
| `SMTP_HOST/PORT/USER/PASS`, `MAIL_FROM` | ✅ | MFA + password-reset email. **`MAIL_FROM` must be an address the SMTP account is authorized to send as** (e.g. Outlook/Gmail reject a mismatched From), or MFA codes silently fail to send. |
| `SESSION_INACTIVITY_MINUTES` | optional | Idle window before a new login can take over a session (default 30) |
| `SINGLE_SESSION_ENFORCED` | optional | One active session per account (default `true`). Set `false` to allow the same account on multiple devices at once — for LAN/dev testing only; keep `true` in production. |
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
# First deploy only — apply schema + seed the first administrator:
npm run db:push              # main + chat + ticketing (back up first!)
npm run db:seed              # optional; creates seed accounts — review prisma/seed.ts
node dist/server.js          # or run under systemd (below)
```

### Frontend (`/client`)

```bash
cd client
npm ci
npm run build                # next build (reads NEXT_PUBLIC_API_URL)
npm run start                # next start → 127.0.0.1:3000
```

### systemd units

`/etc/systemd/system/b2b-api.service`:
```ini
[Unit]
Description=B2B SaaS API
After=network.target postgresql.service

[Service]
Type=simple
WorkingDirectory=/opt/b2b/server
EnvironmentFile=/opt/b2b/server/.env
ExecStart=/usr/bin/node dist/server.js
Restart=always
RestartSec=5
User=b2b
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/b2b-web.service`:
```ini
[Unit]
Description=B2B SaaS Web (Next.js)
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/b2b/client
ExecStart=/usr/bin/npm run start
Restart=always
RestartSec=5
User=b2b
Environment=NODE_ENV=production
Environment=PORT=3000

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now b2b-api b2b-web
sudo systemctl status b2b-api
curl -s http://127.0.0.1:3001/health   # {"status":"ok","databases":{...}}
```

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
- [ ] `SINGLE_SESSION_ENFORCED` is `true` (or unset) in production.
- [ ] `ALLOWED_ORIGINS` is the exact public origin — **not** `*`.
- [ ] Services run under a **dedicated non-root user** (the systemd units default to `b2bapp` with a
      hardened sandbox). Do **not** deploy as root.
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
#   BACK UP DBs, then apply any schema change:
npm run db:push
# Frontend
cd ../client && npm ci && npm run build
# restart
sudo systemctl restart b2b-api b2b-web
curl -s https://app.example.com/health
```
CI (`.github/workflows/ci-cd.yml`) runs **checks only** (typecheck/lint) — it does not deploy.

---

## 10. Troubleshooting

| Symptom | Likely cause |
|---|---|
| Login "fails" / cookie never sticks | `COOKIE_SECURE=true` on plain HTTP; or the Next `/api` rewrite target (`NEXT_PUBLIC_API_URL`) unreachable from the Next server |
| Login OK but every page bounces to `/login` | old symptom of a cross-origin auth cookie — fixed by same-origin `/api` calls; ensure `next.config.js` `rewrites()` is present and `/sw.js` is exempt in `middleware.ts` |
| "You're already signed in on another device" blocks login | single-session lock; sign out the other device, wait `SESSION_INACTIVITY_MINUTES`, or set `SINGLE_SESSION_ENFORCED=false` for testing |
| No MFA email arrives → can't log in | SMTP misconfigured, or `MAIL_FROM` not authorized by the SMTP account (send silently fails); check `SMTP_*`, `MAIL_FROM`, provider logs |
| Push notifications never arrive | `VAPID_*` unset (send returns 503); `NEXT_PUBLIC_VAPID_PUBLIC_KEY` missing/mismatched; not served over HTTPS (push needs a secure context — `localhost` is exempt); browser blocked notifications |
| Admin can't log in | admin's email domain not in `ADMIN_DOMAINS` (public domains excluded by design) |
| `/health` shows a DB `down` | that database's URL is wrong or the DB isn't created/loaded |
| Slack bot won't connect | bad `xoxb-` token (status shows **Error**), or missing Socket Mode/`xapp-` for the chat bridge |
| Bot tokens/AD secrets won't decrypt after a redeploy | `SLACK_TOKEN_SECRET` changed or was missing (it fell back to `JWT_ACCESS_SECRET`, which then changed) |
| Assistant returns 503 | `AGENT_URL` unreachable — start Ollama/agent or ignore if unused |
| Uploads vanish after redeploy | `UPLOAD_DIR` not on a persistent volume |
| Build fails with missing `@prisma/*-client` types | ran `npm run build` before `npm run db:generate` |

---

Health endpoint for monitoring/uptime checks: **`GET /health`** → `200` with per-database status,
`503` if any database is down.
