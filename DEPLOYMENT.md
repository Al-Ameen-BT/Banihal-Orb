# Production Deployment Guide

Deploys the B2B SaaS platform: an **Express + TypeScript** API (`/server`) and a **Next.js 14**
frontend (`/client`), backed by **PostgreSQL** (five databases) and **Redis**, with the
**Analytics Agent** and **Slack bot** integrations optional.

Two supported topologies:

| | **Podman** (recommended) | **Bare-metal systemd** (legacy) |
|---|---|---|
| Runs as | Four pods, Quadlet units | One `b2b.service`, two Node processes |
| Rollback | Retag the previous image, restart | Redeploy the previous commit |
| Install | `deploy/podman/install.sh` | `deploy.sh` |

Deploy bare-metal only if you are not ready to containerize. **Keep it installed but stopped
through the container cutover** — it is the rollback.

> 📦 **Deploying with Podman? The runbook is [`deploy/podman/README.md`](deploy/podman/README.md)** (§6).
> This document is the wider reference: architecture, the environment-variable table (§4),
> Redis (§5), CI/CD (§9) and the readiness checklist (§10).

> Database schemas are provisioned by **idempotent SQL DDL** in `server/db/`. Re-running is safe
> and never drops data. Prisma _clients_ are still generated (`npm run db:generate`).
> **Always back up before a schema change.**

---

## What changed in this release

Upgrading an existing install? Read this section before anything else.

- **Redis is now a component.** It backs three things: a read-through cache on the polled dashboard
  aggregates, the rate-limit store, and the Analytics Agent's one-call-at-a-time lock. It is
  **optional** — with `REDIS_URL` unset all three fall back to in-process behaviour and the app
  runs exactly as before. See §5.
- **`TRUST_PROXY` is new and it matters.** The API used to hardcode `trust proxy = loopback`, which
  is only correct while nginx shares a host with the API. **Containerized, you must set it to the
  podman network CIDR** or Express ignores `X-Forwarded-For` and every IP-keyed rate limiter
  silently collapses into one bucket. No error, nothing in the logs. See §4.
- **Ollama is removed.** Nothing has called it since the Analytics Agent began managing its own
  model. `OLLAMA_URL` / `OLLAMA_MODEL` are gone from `env.ts`, the deploy preflight no longer probes
  `:11435`, and `b2b.service` no longer carries `Wants=ollama.service` (which was *starting* it at
  boot). You can uninstall Ollama from the host after redeploying.
- **Podman deployment.** Containerfiles, four pods, and Quadlet units under `deploy/podman/`. See §6.
- **CI now runs tests and builds images.** `.github/workflows/ci-cd.yml` gained a unit-test step, an
  image-build job, and an optional self-hosted deploy job. See §9.
- **`server/.gitignore` no longer excludes `tests`.** A bare `tests` pattern was keeping four test
  files out of version control, so CI checked out a repo missing most of its suite and reported
  green. If you have a fork, check for the same line.

Still current from earlier releases: SQL-first DB provisioning; MFA opt-in (default off); admin
ticket store required with no fallback; Web Push (`VAPID_*`); ticketing tenant isolation.

---

## 1. Architecture & ports

### Containerized (recommended)

```
                       ┌──────── b2b-nginx pod (:80, :443 TLS) ────────┐
   Browser ─────────►  │  /             → b2b-app:3000  (Next.js)      │
                       │  /api, /health → b2b-app:3001  (API)          │
                       └───────────────────────────────────────────────┘
                                        │ podman network "b2b" 10.89.10.0/24
              ┌─────────────────────────┼─────────────────────────┐
              ▼                         ▼                         ▼
      b2b-app pod                b2b-postgres pod          b2b-redis pod
   ┌──────────────────┐        ┌──────────────────┐      ┌───────────────┐
   │ b2b-api   :3001  │        │ postgres:16      │      │ redis:7       │
   │ b2b-web   :3000  │        │ 127.0.0.1:5432   │      │ (no publish)  │
   └──────────────────┘        └──────────────────┘      └───────────────┘
              │
              └──► host.containers.internal:8001  Analytics Agent (host, optional)
                   Slack (outbound WebSocket/HTTPS, optional)
```

**`b2b-api` and `b2b-web` share one pod on purpose.** Containers in a pod share a network
namespace, so Next reaches the API on `localhost:3001` exactly as under systemd — which is what the
`next.config.js` rewrite and the nginx SSE bypass both assume. Splitting them breaks both, and the
rewrite breaks *quietly*.

| Component | Port | Public? |
|---|---|---|
| nginx | 80, 443 | **yes** — the only exposed pod |
| API | 3001 | no — via nginx `/api` + `/health` |
| Next.js | 3000 | no — via nginx `/` |
| PostgreSQL | 127.0.0.1:5432 | **no** — loopback only, for host `psql`/`pg_dump` |
| Redis | none | **no** — network-internal only |
| Analytics Agent | 8001 (host) | no |

> **Never publish Redis.** An unauthenticated Redis on a reachable port is a remote shell waiting to
> happen (`CONFIG SET dir` + `SAVE` writes arbitrary files). Debug with
> `podman exec b2b-redis redis-cli`.

### Bare-metal (legacy)

nginx on the host proxies to `127.0.0.1:3000` / `127.0.0.1:3001`, both supervised by one
`b2b.service`. PostgreSQL and (optionally) Redis run on the host.

---

## 2. Prerequisites

**Both topologies:** PostgreSQL 13+ · a TLS certificate (`deploy/nginx/https-nginx.sh` generates a
self-signed one for internal/no-DNS deployments) · SMTP credentials (password reset, and MFA for
users who enable it).

**Containerized:** **Podman 5.0+** (`.pod` Quadlet units need 5.0; on 4.x drop the `.pod` files and
create pods from an `ExecStartPre`). Verify with `podman --version`.

**Bare-metal:** Node 20 · nginx on the host.

**Optional:** the Analytics Agent on `:8001` (chat degrades to 503 without it) · a Slack app with
`xoxb-` and, for the chat bridge, `xapp-` tokens.

---

## 3. Databases

Five databases: `b2b`, `b2b_chat`, `b2b_ticketing`, `b2b_ticketing_admin`, `b2b_ticket`.

```bash
cd server
npm run db:provision   # idempotent SQL DDL — safe to re-run, never drops data
npm run db:verify      # fail-fast preflight; gate every deploy on this
```

`b2b_ticketing_admin` is created by `00_databases.sql`, but its **schema is loaded separately** from
the `ticketingDB` pg dump — and only on a fresh, empty database. The dump is schema-only, so a
`--clean` restore would drop existing tickets.

**Containerized:** the pod publishes on `127.0.0.1:5432`, so both commands work unchanged from the
host. Migrate existing data with `deploy/podman/migrate-db.sh` (§6.4).

---

## 4. Environment variables

Copy `server/.env.example` → `server/.env`. **Generate every secret** with `openssl rand -hex 32`.

| Var | Required | Purpose |
|---|---|---|
| `DATABASE_URL`, `CHAT_DATABASE_URL`, `TICKETING_DATABASE_URL`, `TICKET_DATABASE_URL` | ✅ | The four core DBs |
| `ADMIN_TICKETING_DATABASE_URL` | ✅ | Administrators' isolated store (`b2b_ticketing_admin`) — **no fallback**; the API won't start without it |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `IMPERSONATION_SECRET` | ✅ (≥32 chars) | Token signing |
| `TRUST_PROXY` | ✅ | Which upstream may be believed for `X-Forwarded-For`. `loopback` when nginx shares the host; **the podman CIDR (`10.89.10.0/24`) when containerized**. ⚠ **Never `true`** — that trusts a client-supplied header and makes every rate limiter bypassable |
| `REDIS_URL` | Optional | Cache + rate-limit store + agent lock. Unset ⇒ in-process fallbacks. Containerized: `redis://b2b-redis:6379` |
| `SLACK_TOKEN_SECRET` | ✅ if using bots | Encrypts Slack tokens, webhook URLs and AD temp-passwords at rest. Falls back to `JWT_ACCESS_SECRET`. **Back it up** — lost ⇒ unrecoverable; changed ⇒ existing secrets stop decrypting |
| `PASSWORD_PEPPER` | Optional | Keys the shared-password fingerprint. Falls back to `JWT_ACCESS_SECRET`. **Keep stable** — changing it invalidates every stored fingerprint |
| `NODE_ENV` | ✅ | `production` |
| `PORT` | ✅ | `3001` |
| `COOKIE_SECURE` | ✅ | `true` under HTTPS (else the browser drops the auth cookie) |
| `ALLOWED_ORIGINS` | ✅ | Exact public origin(s), comma-separated — **not** `*` |
| `FRONTEND_URL` | ✅ | Public app URL — builds password-reset links |
| `ADMIN_DOMAINS` | ✅ | Domains allowed to hold `ADMINISTRATOR`. Empty = admin login disabled. ⚠ **PRIVATE work domains only** — listing a public mailbox domain lets any signup self-grant super-admin |
| `SMTP_HOST/PORT/USER/PASS`, `MAIL_FROM` | ✅ | MFA + password reset. `MAIL_FROM` must be an address the SMTP account may send as, or mail silently fails |
| `SESSION_INACTIVITY_MINUTES` | Optional | Idle window before a stale session can be taken over (default 30) |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Optional | Web Push. `npx web-push generate-vapid-keys`. The private key is a **secret** |
| `MFA_CODE_TTL_MINUTES`, `MFA_MAX_ATTEMPTS`, `MFA_RESEND_COOLDOWN_SECONDS` | Optional | MFA tuning (10 / 5 / 30) |
| `AGENT_URL`, `AGENT_BASE_URL`, `AGENT_CHAT_*`, `AGENT_COMPLAINTS_*` | Optional | Assistant backend; chat degrades to 503 if absent |
| `UPLOAD_DIR` | Optional | Attachment directory — **must be a persistent volume** |
| `TICKETING_API_URL`, `TICKETING_API_KEY` | Optional | External ticketing mirror (disabled if unset) |

**Frontend env** — `client/.env`. `NEXT_PUBLIC_*` is **inlined at build time**, so it must be set
*before* `next build` (containerized: passed as a build arg by `build.sh`; setting it in the
Quadlet unit does nothing):

```bash
NEXT_PUBLIC_API_URL="https://app.example.com"          # the app's own origin when proxied under /api
NEXT_PUBLIC_VAPID_PUBLIC_KEY="<same as server VAPID_PUBLIC_KEY>"
```

**Containerized secrets** live in `/etc/b2b/{server.env,client.env,postgres.env}`, mode `0600`,
mounted via `EnvironmentFile=`. They are never baked into an image layer — a layer is readable by
anyone who can pull it. `install.sh` seeds them from `server/.env` / `client/.env` if present.

---

## 5. Redis

Optional, but recommended in production. Three jobs:

1. **Cache** — read-through on `dashboard`, `stats`, `analytics`, `reports`, `sla-breaches`,
   `chat-analytics`, `top-complaints`, `projects`, `assignees`. 30s TTL for dashboards, 60s for
   reference data. These endpoints run full-table scans and are polled every 15–60s by every open
   dashboard, so each connected admin was triggering their own scan on every tick.
2. **Rate-limit store** — limits now survive a restart and hold across instances. Without it,
   "restart the API" is a way to clear an attacker's login counter.
3. **Agent lock** — the Analytics Agent processes one `/v1/chat` at a time across all clients. The
   in-process queue only holds while exactly one API process exists.

**Cache keys include the ticket-DB scope** (`default` vs `admin`), which is what stops the shared and
platform-admin stores from ever serving each other's rows.

**Degradation is tested, not assumed.** Redis down at boot, dying mid-flight, and returning without
an app restart are all verified: the app serves throughout, limits fall back to in-process, and Redis
resumes being authoritative on its own. Persistence is deliberately **off** — everything Redis holds
here is reconstructible.

---

## 6. Containerized deployment

**→ [`deploy/podman/README.md`](deploy/podman/README.md)** is the runbook: prerequisites,
install, configure, provision, build, cutover, day-2 upgrade/rollback/backup, and
troubleshooting. It is kept in step with the Quadlet units it sits beside.

The two values that most often go wrong, repeated here because they are also referenced
from §4 and §8:

- `TRUST_PROXY="10.89.10.0/24"` — **not** `loopback`. nginx now reaches the API from the
  container network, so Express discards `X-Forwarded-For` and every IP-keyed rate limiter
  collapses into one bucket, silently.
- `NEXT_PUBLIC_API_URL` is **build-time**. It is inlined into the browser bundle by
  `next build`; setting it in a Quadlet unit does nothing. To change it, rebuild.

Migrating off an existing bare-metal install? Run `deploy/podman/migrate-db.sh` with the
application **stopped** — a dump taken while it writes loses those writes at cutover — and
keep the host cluster stopped-but-intact for at least one backup cycle as the rollback.

---

## 7. Bare-metal deployment (legacy / rollback)

```bash
sudo ./deploy.sh                        # builds, provisions, verifies, installs b2b.service
sudo systemctl restart b2b
curl -s https://app.example.com/health
```

Runs as a dedicated non-root user with a hardened systemd sandbox. `deploy.sh` removes the older
split `b2b-api` / `b2b-web` units on upgrade.

---

## 8. Nginx reverse proxy + HTTPS

```bash
sudo ./deploy/nginx/https-nginx.sh              # auto-detects the LAN IP
sudo ./deploy/nginx/https-nginx.sh 172.17.121.200
```

Generates a self-signed certificate with the server's IPs/hostnames in `subjectAltName` (a matching
Common Name has not been accepted since Chrome 58) and prints the per-OS trust steps.

Two configs, both current:

- `deploy/nginx/b2b-site.conf` — host nginx → `127.0.0.1:3000/3001`. Bare-metal and rollback.
- `deploy/nginx/b2b-site.container.conf` — nginx container → `b2b-app:3000/3001`. Installed to
  `/etc/b2b/nginx/b2b-site.conf`.

Both serve **everything from one origin** so the auth cookie stays first-party and CORS never
enters the picture. Do not split the app and API across two addresses — the login flow depends on it.

**HSTS is deliberately off.** It does nothing on an IP-literal host (RFC 6797), and on an internal
hostname it removes the browser's "proceed anyway" escape hatch before the self-signed certificate
is trusted — turning a warning into a hard lockout. Enable it only once the certificate is in every
client's trust store *and* you reach the app by hostname.

---

## 9. CI/CD

`.github/workflows/ci-cd.yml`:

| Job | Runner | Runs on |
|---|---|---|
| `server-check` | hosted | typecheck + unit tests |
| `client-check` | hosted | typecheck + production build |
| `images` | hosted | builds both Containerfiles |
| `deploy` | **self-hosted** | `main` pushes only; build → restart → health gate → auto-rollback |

**The deploy job must be self-hosted.** The target has no public DNS and no inbound route, so
GitHub-hosted runners cannot reach it. Give the runner narrowly scoped sudo:

```bash
sudo tee /etc/sudoers.d/b2b-deploy <<'EOF'
github-runner ALL=(root) NOPASSWD: /usr/bin/systemctl restart b2b-api b2b-web, \
                                   /usr/bin/systemctl is-active b2b-api b2b-web
EOF
```

A runner that can run *any* `systemctl` is a runner that can be talked into running anything.

Unit tests run a **narrow selection** — most of the suite needs a live PostgreSQL. Widening it
without adding a `postgres` service container turns the pipeline permanently red, which is worse
than a narrow green one. Secrets stay on the server and never enter CI.

---

## 10. Production readiness checklist

### Before you deploy

**Secrets & identity**
- [ ] Every secret is a unique 32+ char random value (`openssl rand -hex 32`).
- [ ] `JWT_*`, `IMPERSONATION_SECRET`, `SLACK_TOKEN_SECRET`, `PASSWORD_PEPPER` are **backed up in a
      secrets manager**. Losing `SLACK_TOKEN_SECRET` permanently bricks encrypted bot and AD data.
- [ ] `ADMIN_DOMAINS` lists only **private** domains you control — never a public mailbox domain.
- [ ] `VAPID_PRIVATE_KEY` is set as a secret and never logged.
- [ ] `/etc/b2b/*.env` are mode `0600`, owned by root. No secret is in an image layer or in CI.

**Config**
- [ ] `NODE_ENV=production`, `COOKIE_SECURE=true`, HTTPS only.
- [ ] `ALLOWED_ORIGINS` is the exact public origin, not `*`.
- [ ] **`TRUST_PROXY` matches the topology** — `loopback` bare-metal, the podman CIDR containerized.
      Getting this wrong is silent.
- [ ] `NEXT_PUBLIC_API_URL` is the app's public origin and was set **before** the image build.
- [ ] `UPLOAD_DIR` points at a persistent volume; nginx `client_max_body_size` ≥ 55m.
- [ ] `SESSION_INACTIVITY_MINUTES` set to a sane idle window.

**Data**
- [ ] All five databases provisioned; `npm run db:verify` passes.
- [ ] PostgreSQL is not reachable from the LAN (`127.0.0.1` bind only).
- [ ] Strong DB passwords, least-privilege roles.
- [ ] A **fresh dump exists, taken immediately before cutover**.
- [ ] Container Postgres tuning compared against the host's `postgresql.conf`
      (`shared_buffers`, `work_mem`, `max_connections` — the image ships upstream defaults).
- [ ] `prisma/seed.ts` reviewed — demo accounts removed.

**Infrastructure**
- [ ] Podman 5.0+ (`.pod` units).
- [ ] TLS certificate carries the server's current IP in `subjectAltName`.
- [ ] `host.containers.internal` resolves from a container, and the Agent `:8001` answers through it.
- [ ] Redis is **not** published on any host port.

### Deploy

- [ ] Application stopped before `migrate-db.sh`.
- [ ] Row counts match host vs container for all five databases.
- [ ] Parallel run smoke-tested on `3010`/`3011` before touching nginx.
- [ ] Host nginx stopped before starting `b2b-nginx` (port conflict).
- [ ] Images tagged with the git sha, not only `:latest`.

### After cutover — verify, do not assume

- [ ] `systemctl status b2b-postgres b2b-redis b2b-api b2b-web b2b-nginx` — all active.
- [ ] `curl -sk https://<host>/health` → `200` with every database `connected`.
- [ ] **Login end to end**, including a password reset email.
- [ ] **Rate limiting keys on the real client IP** — exceed the auth cap from one IP and confirm a
      second IP is still allowed. If both throttle together, `TRUST_PROXY` is wrong.
- [ ] `podman exec b2b-redis redis-cli keys '*'` shows `rl:*` keys, and the counter increments.
- [ ] **Cache is scope-correct** — load the ops dashboard as an ORG_ADMIN and as an ADMINISTRATOR.
      They read different stores; if the second sees the first's data, the cache key is wrong.
- [ ] **Attachment persistence** — upload an image, `systemctl restart b2b-api`, download it again.
- [ ] **Chat SSE streams incrementally** rather than arriving in one block.
- [ ] **Redis-down drill** — stop `b2b-redis`, confirm the app still serves, then start it and
      confirm `rl:*` keys reappear without an app restart.
- [ ] **Reboot the host** and confirm all pods return unattended.
- [ ] **Backups repointed at the container database.** A cron still dumping the host cluster will
      silently back up an empty database — the most common way a container migration loses data
      weeks later.
- [ ] `b2b.service` disabled but still installed, and the host cluster stopped but intact.

---

## 11. Backups, upgrades & rollback

**Nightly:**
```bash
for db in b2b b2b_chat b2b_ticketing b2b_ticketing_admin b2b_ticket; do
  podman exec b2b-postgres pg_dump -U postgres -Fc "$db" > "/backups/${db}-$(date +%F).dump"
done
podman volume export b2b-uploads > "/backups/uploads-$(date +%F).tar"
# also back up /etc/b2b/server.env — it holds SLACK_TOKEN_SECRET and the JWT secrets
```

**Upgrade:**
```bash
git pull
cd server && npm run db:provision && npm run db:verify   # back up FIRST
cd .. && ./deploy/podman/build.sh
systemctl restart b2b-api b2b-web
curl -sk https://localhost/health
```

**Rollback:**
```bash
podman tag localhost/b2b-api:<previous-sha> localhost/b2b-api:latest
podman tag localhost/b2b-web:<previous-sha> localhost/b2b-web:latest
systemctl restart b2b-api b2b-web
```

Roll back **both** images together — a new web bundle against an old API is worse than either alone.

**Full revert to bare-metal:** stop `b2b-nginx` and `b2b-app`, restore the host nginx config, start
host PostgreSQL, `systemctl start b2b.service`. Anything written to the container database after
cutover must be dumped back — keep the cutover window short.

---

## 12. Troubleshooting

### Containers

| Symptom | Cause |
|---|---|
| API exits at boot: `MaxRetriesPerRequestError` | `rate-limit-redis` issues a command from its constructor before ioredis connects. `lib/redis.ts` must keep `enableOfflineQueue: true` |
| `Prisma Client could not locate the Query Engine for debian-openssl-3.0.x` | openssl missing from the **build** stage, so Prisma's platform sniff at generate time picked the 1.1.x engine. It must be installed in `deps`, not only in runtime |
| Every request returns 500 while Redis is down | the rate-limit store error is propagating. `rateLimiter.ts` must fall back to the in-memory limiter |
| Limits stay per-process after Redis returns | the store cached a script hash against a dead server. The limiter must be built lazily while the client is `ready` and discarded on error |
| Healthcheck never runs | `HEALTHCHECK` in a Containerfile is **discarded** by Podman's default OCI format. Use `HealthCmd=` in the Quadlet unit |
| Rate limits collapse into one bucket | `TRUST_PROXY` still `loopback` behind the nginx container |
| `Invalid url` for every `*_DATABASE_URL` | quoted values via `podman --env-file`, which does not strip quotes (systemd's `EnvironmentFile=` does) |
| Static assets 404 but pages render | `.next/static` not copied alongside `.next/standalone` |
| Browser API calls fail after deploy | `NEXT_PUBLIC_API_URL` wrong at **build** time — rebuild, runtime env cannot fix it |
| Attachments vanish on redeploy | `b2b-uploads` volume not mounted |
| Pod won't bind :80/:443 rootless | needs `net.ipv4.ip_unprivileged_port_start=80`, or run rootful |

### Application

| Symptom | Cause |
|---|---|
| Login "fails" / cookie never sticks | `COOKIE_SECURE=true` on plain HTTP, or the `/api` rewrite target unreachable from the Next server |
| Login OK but every page bounces to `/login` | `middleware.ts` matcher must exclude `/api` and exempt `/sw.js` |
| "sent to **undefined**" on the verify screen | the `/api` proxy target is unreachable or the API is down |
| "You're already signed in on another device" | single-session lock; wait `SESSION_INACTIVITY_MINUTES` |
| MFA code never arrives | SMTP misconfigured, or `MAIL_FROM` not authorized by the SMTP account |
| Push never arrives | `VAPID_*` unset (503), key mismatch, or not served over HTTPS |
| Admin can't log in | email domain not in `ADMIN_DOMAINS` |
| `/health` shows a DB `down` | that URL is wrong, or the database isn't created/loaded |
| `db:provision`: `invalid URI query parameter: "schema"` | a `*_DATABASE_URL` carries `?schema=public`, which `psql` rejects — `provision.sh` strips it; remove it manually on an older copy |
| `db:provision`: `extension "pgcrypto" is not available` | not needed — `gen_random_uuid()` is core in PG 13+. Delete the `CREATE EXTENSION` line |
| `password authentication failed for user "user"` | a placeholder from `.env.example` left in a `*_DATABASE_URL` |
| Slack bot won't connect | bad `xoxb-`, or missing Socket Mode / `xapp-` for the chat bridge |
| Bot tokens won't decrypt after redeploy | `SLACK_TOKEN_SECRET` changed or fell back to a changed `JWT_ACCESS_SECRET` |
| Assistant returns 503 | run `npm run chat:doctor` — it names the layer (closed port, untrusted cert, clock skew, unknown credential, ungranted role) |
| Administrators get end-user answers | the `ext-*` credential isn't granted `l3`; ask the agent admin to widen it — no redeploy needed |
| Build fails on missing `@prisma/*-client` | ran `npm run build` before `npm run db:generate` |

---

Health endpoint for monitoring: **`GET /health`** → `200` with per-database status, `503` if any
database is down.
