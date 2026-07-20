# Production Deployment Guide

This guide deploys the B2B SaaS platform: an **Express + TypeScript** API (`/server`) and a
**Next.js 14** frontend (`/client`), backed by **PostgreSQL** (five databases), with an optional
**Ollama assistant** and **Slack bot** integrations.

> The app uses `prisma db push` (not migrations). Schema changes are applied by re-pushing.
> **Always back up before deploying a schema change** — a push can drop columns.

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
| `ADMIN_DOMAINS` | ✅ | Comma-separated email domains allowed to hold `ADMINISTRATOR`. **Empty = admin login disabled.** |
| `SMTP_HOST/PORT/USER/PASS`, `MAIL_FROM` | ✅ | MFA + password-reset + Slack-nothing email |
| `SESSION_INACTIVITY_MINUTES` | optional | Idle window before a new login can take over a session (default 30) |
| `MFA_CODE_TTL_MINUTES`, `MFA_MAX_ATTEMPTS`, `MFA_RESEND_COOLDOWN_SECONDS` | optional | MFA tuning (defaults 10 / 5 / 30) |
| `AGENT_URL`, `OLLAMA_URL`, `OLLAMA_MODEL` | optional | Assistant backend; chat degrades gracefully (503) if absent |
| `UPLOAD_DIR` | optional | Ticket/comment attachment dir (default `uploads`) — **must be on a persistent volume** |
| `TICKETING_API_URL`, `TICKETING_API_KEY` | optional | External ticketing mirror (disabled if unset) |

**Frontend env** — set in `client/.env` (or the build environment). `NEXT_PUBLIC_*` is **inlined at
build time**, so it must be present *before* `next build`:

```bash
# client/.env
NEXT_PUBLIC_API_URL="https://app.example.com"   # same origin as the app when proxied under /api
```

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
- [ ] `ADMIN_DOMAINS` lists only the provider's real admin domain(s).
- [ ] `ALLOWED_ORIGINS` is the exact public origin — **not** `*`.
- [ ] PostgreSQL is **not** exposed publicly; strong DB passwords; least-privilege DB roles.
- [ ] SMTP verified end-to-end (do a real login — you must receive the MFA code).
- [ ] `UPLOAD_DIR` on a persistent, backed-up volume; Nginx `client_max_body_size` set.
- [ ] Rate limiting is on by default (global + AD-ingest); front with a WAF if internet-facing.
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
| Login "fails" / cookie never sticks | `COOKIE_SECURE=true` on plain HTTP, or `ALLOWED_ORIGINS`/`NEXT_PUBLIC_API_URL` origin mismatch |
| No MFA email arrives → can't log in | SMTP misconfigured; check `SMTP_*`, `MAIL_FROM`, provider logs |
| Admin can't log in | admin's email domain not in `ADMIN_DOMAINS` |
| `/health` shows a DB `down` | that database's URL is wrong or the DB isn't created/loaded |
| Slack bot won't connect | bad `xoxb-` token (status shows **Error**), or missing Socket Mode/`xapp-` for the chat bridge |
| Bot tokens/AD secrets won't decrypt after a redeploy | `SLACK_TOKEN_SECRET` changed or was missing (it fell back to `JWT_ACCESS_SECRET`, which then changed) |
| Assistant returns 503 | `AGENT_URL` unreachable — start Ollama/agent or ignore if unused |
| Uploads vanish after redeploy | `UPLOAD_DIR` not on a persistent volume |
| Build fails with missing `@prisma/*-client` types | ran `npm run build` before `npm run db:generate` |

---

Health endpoint for monitoring/uptime checks: **`GET /health`** → `200` with per-database status,
`503` if any database is down.
