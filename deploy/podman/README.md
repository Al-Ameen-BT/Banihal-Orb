# Podman deployment guide

Operational runbook for deploying B2B-Site with Podman Quadlet units. Follow it
top to bottom on a fresh host; jump to [Day-2 operations](#7-day-2-operations)
once you are running.

`../../DEPLOYMENT.md` is the wider reference — architecture rationale, the full
environment-variable table, CI/CD and the production readiness checklist. This
file is the commands.

---

## 1. What gets deployed

Four pods on one user-defined network, plus two volumes:

```
                    ┌──── b2b-nginx pod (.5) ─────────────┐
  Browser ──443──►  │  TLS termination, one origin        │
                    │  /             → b2b-app:3000       │
                    │  /api, /health → b2b-app:3001       │
                    └────────────┬────────────────────────┘
                                 │  b2b network (10.89.10.0/24)
       ┌─────────────────────────┼──────────────────────────┐
       │                         │                          │
┌──────┴───────────┐   ┌─────────┴────────┐   ┌─────────────┴──┐
│ b2b-app pod (.4) │   │ b2b-postgres(.2) │   │ b2b-redis (.3) │
│  b2b-api  :3001  │   │  :5432 → 127.0.0.1│  │  no published  │
│  b2b-web  :3000  │   │  vol: b2b-pgdata │   │  port          │
│  vol: b2b-uploads│   └──────────────────┘   └────────────────┘
└──────────────────┘
                         Analytics Agent stays on the HOST (:8001),
                         reached via host.containers.internal.
```

All pods have **static IPs** pinned via `IP=` in their `.pod` units, so
addresses survive restarts, rebuilds, and full stack recreations:

| Pod | IP | Notes |
|---|---|---|
| `b2b-postgres` | `10.89.10.2` | |
| `b2b-redis` | `10.89.10.3` | |
| `b2b-app` | `10.89.10.4` | API + web share this address (same pod) |
| `b2b-nginx` | `10.89.10.5` | |

| Exposed | Where | Why |
|---|---|---|
| 80, 443 | LAN | The only public surface. |
| 5432 | `127.0.0.1` only | Host `psql`, `pg_dump`, `provision.sh`. Never `0.0.0.0`. |
| Redis | nothing | Network-internal. An unauthenticated Redis on a published port is a remote shell waiting to happen. |
| 3000 / 3001 | nothing | nginx reaches them over the `b2b` network. |

**Why the API and web share one pod:** they share a network namespace, so Next's
server-side rewrite and the nginx SSE bypass both find the API on
`localhost:3001`. Split them into separate pods and the rewrite breaks silently.

### Files

| Unit | Purpose |
|---|---|
| `b2b.network` | Network, subnet **pinned** at `10.89.10.0/24` |
| `b2b-app.pod` / `b2b-api.container` / `b2b-web.container` | Application |
| `b2b-postgres.pod` / `.container` | Database |
| `b2b-redis.pod` / `.container` | Cache, rate-limit store, agent lock |
| `b2b-nginx.pod` / `.container` | TLS + reverse proxy |
| `b2b-pgdata.volume` | **The stateful volume.** Everything else is reconstructible. |
| `b2b-uploads.volume` | Ticket attachments |
| `install.sh` | Installs the Quadlet units + nginx conf. Starts nothing. |
| `build.sh` | Writes `/etc/b2b/*.env`, builds both images, provisions + verifies the databases. Idempotent. |
| `drop.sh` | Tears the stack down. `--all-gone` also destroys volumes and images. |
| `migrate-db.sh` | Copies five databases off an existing host cluster. |
| `test-envfile.sh` | Self-check for `build.sh`'s env-file helpers. No root, no podman. |

---

## 2. Prerequisites

```bash
podman --version          # 5.0+ required — the .pod Quadlet units need it
psql --version            # host client, for provisioning and backups
```

On Podman 4.x, drop the `.pod` files and create the pods from an `ExecStartPre`
in each `.container`. `install.sh` refuses to run and says so.

Also needed: a TLS certificate at `/etc/nginx/ssl/b2b-site.{crt,key}`. For an
internal deployment with no public DNS a self-signed cert is the correct choice —
ACME proves control of a *public* name and an RFC1918 address has none. Put every
IP and hostname clients will use in `subjectAltName`; a matching Common Name has
not been accepted since Chrome 58.

```bash
sudo mkdir -p /etc/nginx/ssl
sudo openssl req -x509 -nodes -days 825 -newkey rsa:2048 \
  -keyout /etc/nginx/ssl/b2b-site.key -out /etc/nginx/ssl/b2b-site.crt \
  -subj "/CN=b2b-site" \
  -addext "subjectAltName=IP:172.17.121.200,DNS:b2b.internal"
```

**Rootless only:** ports 80/443 are privileged. Either run rootful, or

```bash
echo 'net.ipv4.ip_unprivileged_port_start=80' | sudo tee /etc/sysctl.d/99-b2b.conf
sudo sysctl --system
```

---

## 3. Install the units

```bash
sudo ./deploy/podman/install.sh
```

Idempotent. It copies the Quadlet units to `/etc/containers/systemd`, installs
the container nginx config to `/etc/b2b/nginx/b2b-site.conf`, and runs
`systemctl daemon-reload`.

**It writes no env files.** `build.sh` owns `/etc/b2b/{server,client,postgres}.env`
— see §4 for why that matters.

**It starts nothing.** Starting is a separate, deliberate step so this is safe to
run on a live host.

---

## 4. Configure and build

One command. `build.sh` writes all three env files, builds both images, and
creates and verifies the five databases:

```bash
sudo ./deploy/podman/build.sh
```

It asks **once** for the three things it cannot derive — this host's public
origin, the admin email domains, and SMTP — then remembers them. Every later run
prompts for nothing and regenerates nothing.

| It generates | It derives | It asks for |
|---|---|---|
| `POSTGRES_PASSWORD`, `JWT_ACCESS_SECRET`, `IMPERSONATION_SECRET`, `SLACK_TOKEN_SECRET`, `PASSWORD_PEPPER`, the VAPID pair (server-side only) | the five `*_DATABASE_URL`, `REDIS_URL`, `TRUST_PROXY`, `COOKIE_SECURE`, `UPLOAD_DIR`, `NEXT_PUBLIC_API_URL` | `FRONTEND_URL`, `ADMIN_DOMAINS`, `SMTP_*` |

Non-interactive (CI, or a re-run on a fresh host):

```bash
FRONTEND_URL=https://b2b.example.com ADMIN_DOMAINS=example.com \
SMTP_HOST=smtp.example.com SMTP_USER=… SMTP_PASS=… \
  sudo -E ./deploy/podman/build.sh
```

### ⚠ Never quote a value in `/etc/b2b/*.env`

This is the one rule. Quadlet's `EnvironmentFile=` is **not** systemd's — it
becomes `podman run --env-file`, which reads the file **verbatim**:

```console
$ printf 'DATABASE_URL="postgresql://…"\n' > env
$ podman run --rm --env-file env alpine sh -c 'echo "[$DATABASE_URL]"'
["postgresql://…"]          ← the quotes are part of the value
```

`config/env.ts` then rejects it as `Invalid url`, the API exits 1, and
`Restart=always` turns that into a restart loop whose only visible symptom is
`systemctl restart b2b-api` failing. `build.sh` writes these files unquoted and
strips quotes from anything hand-edited, so if you edit one by hand, just re-run
`build.sh`.

### `TRUST_PROXY` is read from `b2b.network`, not typed

`build.sh` takes it from `Subnet=` so the two cannot drift apart. On bare metal
nginx reached the API over loopback; it now arrives from its address on the `b2b`
network, and Express ignores an `X-Forwarded-For` from an untrusted hop. Left at
the `loopback` default, every IP-keyed rate limiter collapses into a single
bucket keyed on nginx's container IP — with nothing in the logs. Never set it to
`true`: that trusts a client-supplied header and makes the limiters bypassable by
anyone who sends one.

### `NEXT_PUBLIC_*` are build-time, not runtime

They are inlined into the browser bundle by `next build`. `build.sh` passes them
as build args. Setting one in a Quadlet unit does nothing — the server process
reads it and the browser code never sees it. **To change one, rebuild.**

`NEXT_PUBLIC_API_URL` is now the only one. The VAPID public key used to be here
too, and that is exactly why push broke: the key baked into the web image drifted
from the pair in `server.env` with nothing able to detect it. The browser fetches
it from `/api/push/vapid-public-key` at runtime instead, so a key rotation needs
no web rebuild.

Because everything is served from one origin behind nginx, `NEXT_PUBLIC_API_URL`
is the site's own `https://` address. That keeps the auth cookie first-party and
CORS out of the picture — do not split the app and API across two addresses.

---

## 5. Database

### 5a. Fresh install

Nothing to do — `build.sh` phase 5 already did it. It starts `b2b-postgres`,
waits for the healthcheck, then runs [`server/db/provision.sh`](../../server/db/provision.sh)
*through the container* (`DB_CONTAINER=b2b-postgres`), so no host
`postgresql-client` is needed. Idempotent and non-destructive: existence guards on
databases, `IF NOT EXISTS` on tables and indexes, `ON CONFLICT DO NOTHING` on seed
rows.

`b2b_ticketing_admin` is *created* by `00_databases.sql`, but upstream loads its
schema from the `ticketingDB` pg dump, which is not in this repo. `provision.sh`
applies the equivalent `b2b_ticket.sql` so a from-scratch install gets a working
admin store rather than a schemaless one.

Demo data, if you want it (**skip on a real production install**):

```bash
podman exec b2b-api npm run db:seed
```

### 5b. Migrating from an existing host cluster

Run this **after** `build.sh` and **before** starting the app. `build.sh` has
already created the five databases with their schemas; this copies the data in.

```bash
sudo systemctl stop b2b.service   # stop writes first
./deploy/podman/migrate-db.sh     # dumps five DBs, restores, compares row counts
```

Read-only against the host cluster: it dumps, never drops. **Run it with the
application stopped** — a dump taken while the app writes silently loses those
writes at cutover. Leave the host cluster stopped-but-intact for at least one
backup cycle; it is your rollback.

---

## 6. Start

Images are built and databases provisioned (§4), so this is just starting things.

```bash
sudo systemctl start b2b-api b2b-web
curl -fsS http://localhost:3001/health      # only if you published the app ports
```

Smoke-test before nginx takes `:80`/`:443` by temporarily adding to `b2b-app.pod`:

```ini
PublishPort=127.0.0.1:3010:3000
PublishPort=127.0.0.1:3011:3001
```

Then cut over:

```bash
sudo systemctl stop nginx                   # host nginx releases the ports
sudo systemctl start b2b-nginx
curl -fsSk https://localhost/health
sudo systemctl enable b2b-postgres b2b-redis b2b-api b2b-web b2b-nginx
```

`enable` is what makes the stack survive a reboot. It is easy to forget and only
discovered at the worst moment.

### Verify — do not assume

```bash
podman ps --format '{{.Names}}\t{{.Status}}'     # all five healthy
curl -fsSk https://<host>/health                  # {"status":"ok", ...}
```

Then in a browser: sign in, create a ticket **with an image attachment**, open
the assistant and confirm the reply streams token by token, and check the
notification bell. Those four exercise the API, the uploads volume, the SSE
bypass and the polling endpoints respectively — the paths a container migration
most often breaks.

Confirm the rate limiter sees real client IPs (this is the `TRUST_PROXY` check):

```bash
podman logs b2b-api | grep -i 'rate' | tail
```

---

## 7. Day-2 operations

### Upgrade

```bash
git pull                                    # back up FIRST
sudo ./deploy/podman/build.sh               # re-provisions and re-verifies too
sudo systemctl restart b2b-api b2b-web
curl -fsSk https://localhost/health
```

`build.sh` regenerates no secret and prompts for nothing on a re-run, so this is
the routine path as well as the first-run one.

### Roll back

The main thing containers buy over an in-place deploy. Every build is tagged with
its git sha:

```bash
podman images localhost/b2b-api                   # find the previous sha
podman tag localhost/b2b-api:<sha> localhost/b2b-api:latest
podman tag localhost/b2b-web:<sha> localhost/b2b-web:latest
sudo systemctl restart b2b-api b2b-web
```

**Roll back both together.** A new web bundle against an old API is worse than
either version alone.

### Back up

```bash
for db in b2b b2b_chat b2b_ticketing b2b_ticketing_admin b2b_ticket; do
  podman exec b2b-postgres pg_dump -U postgres -Fc "$db" \
    > "/backups/${db}-$(date +%F).dump"
done
podman volume export b2b-uploads > "/backups/uploads-$(date +%F).tar"
# and /etc/b2b/server.env — it holds SLACK_TOKEN_SECRET and the JWT secrets
```

> **Repoint your existing backup cron at the container.** A cron still dumping the
> old host cluster will happily back up an empty database — the most common way a
> container migration loses data weeks after it appeared to succeed.

---

## 8. Troubleshooting

**A unit will not start.** Quadlet generates systemd units from these files at
`daemon-reload`; a syntax error surfaces there, not at boot.

```bash
sudo systemctl daemon-reload
systemctl status b2b-api
journalctl -u b2b-api -n 50 --no-pager
/usr/lib/systemd/system-generators/podman-system-generator --dryrun   # what Quadlet produced
```

**`host not found in upstream "b2b-app"`.** nginx resolves upstreams once at
startup and caches the address. Recreate the app pod and nginx keeps the old one:

```bash
sudo systemctl restart b2b-nginx
```

**Rate limits behave as if every user is one client.** `TRUST_PROXY` does not
match the network. Confirm the subnet and that `server.env` names it:

```bash
podman network inspect b2b --format '{{range .Subnets}}{{.Subnet}}{{end}}'
```

**A browser API call goes to the wrong host.** `NEXT_PUBLIC_API_URL` was wrong at
*build* time. Fix `/etc/b2b/client.env` and rebuild — restarting cannot fix it.

**`systemctl restart b2b-api` fails and the app never starts.** Read the logs
before anything else — `Restart=always` hides a config rejection as a restart
loop:

```bash
podman logs --tail 50 b2b-api
```

`❌ Invalid environment variables: { DATABASE_URL: [ 'Invalid url' ], … }` means
something re-quoted `/etc/b2b/server.env`. Re-run `build.sh`; it strips them. Ask
the API itself what it sees, which is the check `build.sh` phase 6 runs:

```bash
podman run --rm --env-file /etc/b2b/server.env localhost/b2b-api:latest \
  node -e 'require("/app/dist/config/env.js")'
podman exec b2b-postgres psql -U postgres -l    # do the databases exist?
```

**The API starts, then dies seconds later.** Almost always a database URL. It logs
"Server running" first, so `systemctl restart` returning 0 proves nothing.

**Attachments 404 after a redeploy.** The uploads volume is not mounted; rows
survive and point at files that are gone. Check `Volume=b2b-uploads.volume` in
`b2b-api.container` and that `UPLOAD_DIR=/app/uploads`.

**Redis is down.** Expected to degrade, not to fail: the cache calls through to
Postgres, rate limiting falls back to in-process counters, the agent lock goes
per-process. If the API is *down* because Redis is, that is a bug — `b2b-api`
declares `Wants=`, not `Requires=`, for exactly this reason.

---

## 9. Tearing down

```bash
sudo ./deploy/podman/drop.sh              # containers, pods, network
sudo ./deploy/podman/drop.sh --all-gone   # ⚠ ALSO volumes (all DBs + uploads) and images
```

The default is safe to run at any time: it removes everything reconstructible and
touches no data. Use it when a build or cutover went wrong and you want the
containers recreated from scratch.

`--all-gone` destroys `b2b-pgdata` (all five databases) and `b2b-uploads` (every
ticket attachment). It prompts for a typed `all-gone` first and takes no backup.
`--yes` skips the prompt for scripted use.

Neither mode touches the Quadlet units or `/etc/b2b/*.env`, so recovery from
either is one command — no `install.sh`, no re-prompting, secrets reused:

```bash
sudo ./deploy/podman/build.sh
sudo systemctl start b2b-api b2b-web b2b-nginx
```

### Blunter instruments

```bash
podman system prune -a --volumes  # everything above, plus unrelated containers
podman system reset               # everything Podman owns on this host
```

Both reach outside this deployment. Prefer `drop.sh`, which only touches `b2b-*`.
