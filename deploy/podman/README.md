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
                    ┌──── b2b-nginx pod ─────────────────┐
  Browser ──443──►  │  TLS termination, one origin       │
                    │  /             → b2b-app:3000      │
                    │  /api, /health → b2b-app:3001      │
                    └────────────┬───────────────────────┘
                                 │  b2b network (10.89.10.0/24)
       ┌─────────────────────────┼──────────────────────────┐
       │                         │                          │
┌──────┴───────────┐   ┌─────────┴────────┐   ┌─────────────┴──┐
│ b2b-app pod      │   │ b2b-postgres pod │   │ b2b-redis pod  │
│  b2b-api  :3001  │   │  :5432 → 127.0.0.1│  │  no published  │
│  b2b-web  :3000  │   │  vol: b2b-pgdata │   │  port          │
│  vol: b2b-uploads│   └──────────────────┘   └────────────────┘
└──────────────────┘
                         Analytics Agent stays on the HOST (:8001),
                         reached via host.containers.internal.
```

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
| `install.sh` `build.sh` `migrate-db.sh` | Scripts |

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
the container nginx config to `/etc/b2b/nginx/b2b-site.conf`, seeds
`/etc/b2b/{server,client,postgres}.env` (mode 0600) from any existing
`server/.env` / `client/.env`, and runs `systemctl daemon-reload`.

**It starts nothing.** Starting is a separate, deliberate step so this is safe to
run on a live host.

---

## 4. Configure

Three files, all `root:root` mode 0600, all on the host — never in an image layer,
which is readable by anyone who can pull it.

### `/etc/b2b/postgres.env`

```ini
POSTGRES_USER=postgres
POSTGRES_PASSWORD=<a real password>     # install.sh writes CHANGE_ME
```

### `/etc/b2b/server.env`

Start from `server/.env.example`. Three values differ from a bare-metal install:

```ini
# Container DNS names, resolved by aardvark-dns on the b2b network.
DATABASE_URL="postgresql://postgres:<pw>@b2b-postgres:5432/b2b?schema=public"
CHAT_DATABASE_URL="postgresql://postgres:<pw>@b2b-postgres:5432/b2b_chat"
TICKETING_DATABASE_URL="postgresql://postgres:<pw>@b2b-postgres:5432/b2b_ticketing"
TICKET_DATABASE_URL="postgresql://postgres:<pw>@b2b-postgres:5432/b2b_ticket"
ADMIN_TICKETING_DATABASE_URL="postgresql://postgres:<pw>@b2b-postgres:5432/b2b_ticketing_admin"

REDIS_URL="redis://b2b-redis:6379"

# ⚠ The single most common containerization mistake. See below.
TRUST_PROXY="10.89.10.0/24"

COOKIE_SECURE="true"
ALLOWED_ORIGINS="https://<your host>"
FRONTEND_URL="https://<your host>"
```

> **`TRUST_PROXY` must be the subnet, not `loopback`.**
> On bare metal nginx reached the API over loopback. It now arrives from its
> address on the `b2b` network, and Express ignores an `X-Forwarded-For` from an
> untrusted hop. Leave the default and every IP-keyed rate limiter collapses into
> a single bucket keyed on nginx's container IP — with nothing in the logs.
> Never set it to `true`: that trusts a client-supplied header and makes the
> limiters bypassable by anyone who sends one.

This is also why `b2b.network` pins the subnet instead of letting Podman allocate
it — an allocated range changes on a network recreate and this value silently
stops matching.

### `/etc/b2b/client.env`

```ini
NEXT_PUBLIC_API_URL="https://<your host>"
NEXT_PUBLIC_VAPID_PUBLIC_KEY="<optional, web push>"
```

> **`NEXT_PUBLIC_*` are build-time, not runtime.** They are inlined into the
> browser bundle by `next build`. `build.sh` sources this file and passes them as
> build args. Setting them in a Quadlet unit does nothing — the server process
> reads them and the browser code never sees them. **To change one, rebuild.**

Because everything is served from one origin behind nginx, `NEXT_PUBLIC_API_URL`
is the site's own `https://` address. That keeps the auth cookie first-party and
CORS out of the picture — do not split the app and API across two addresses.

---

## 5. Database

Start the data tier first; it must be healthy before the API will do anything useful.

```bash
sudo systemctl start b2b-postgres b2b-redis
podman healthcheck run b2b-postgres     # or: podman ps --format '{{.Names}} {{.Status}}'
```

### 5a. Fresh install

Provision from the host repo. The postgres pod publishes on `127.0.0.1:5432`, so
host `psql` reaches it.

> The container hostname `b2b-postgres` **does not resolve from the host**, so
> `server/.env`'s URLs will not work here. Override them for this one command.

```bash
cd server
PW='<POSTGRES_PASSWORD>'
SUPERUSER_PSQL="psql postgresql://postgres:$PW@localhost:5432/postgres" \
DATABASE_URL="postgresql://postgres:$PW@localhost:5432/b2b" \
CHAT_DATABASE_URL="postgresql://postgres:$PW@localhost:5432/b2b_chat" \
TICKETING_DATABASE_URL="postgresql://postgres:$PW@localhost:5432/b2b_ticketing" \
TICKET_DATABASE_URL="postgresql://postgres:$PW@localhost:5432/b2b_ticket" \
ADMIN_TICKETING_DATABASE_URL="postgresql://postgres:$PW@localhost:5432/b2b_ticketing_admin" \
  bash db/provision.sh
```

Idempotent, and safe to re-run: existence guards on databases, `IF NOT EXISTS` on
tables and indexes, `ON CONFLICT DO NOTHING` on seed rows. It never drops or
truncates.

`b2b_ticketing_admin` is *created* by `00_databases.sql`, but upstream loads its
schema from the `ticketingDB` pg dump, which is not in this repo. `provision.sh`
applies the equivalent `b2b_ticket.sql` so a from-scratch install gets a working
admin store rather than a schemaless one.

Then verify and seed:

```bash
npm run db:verify                # fail-fast preflight; gate every deploy on this
npm run db:seed                  # demo data — SKIP on a real production install
```

### 5b. Migrating from an existing host cluster

```bash
sudo systemctl stop b2b.service   # stop writes first
./deploy/podman/migrate-db.sh     # dumps five DBs, restores, compares row counts
```

Read-only against the host cluster: it dumps, never drops. **Run it with the
application stopped** — a dump taken while the app writes silently loses those
writes at cutover. Leave the host cluster stopped-but-intact for at least one
backup cycle; it is your rollback.

---

## 6. Build and start

```bash
./deploy/podman/build.sh                    # tags :latest and :<git sha>
sudo systemctl start b2b-api b2b-web
curl -fsS http://localhost:3001/health      # only if you published the app ports
```

`build.sh` refuses to build when `NEXT_PUBLIC_API_URL` is unset rather than
producing an image whose every browser call fails after deploy.

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
git pull
cd server && npm run db:provision && npm run db:verify   # back up FIRST
cd .. && ./deploy/podman/build.sh
sudo systemctl restart b2b-api b2b-web
curl -fsSk https://localhost/health
```

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

**The API starts, then dies seconds later.** Almost always a database URL. It logs
"Server running" first, so `systemctl restart` returning 0 proves nothing:

```bash
podman logs --tail 50 b2b-api
podman exec b2b-postgres psql -U postgres -l    # do the databases exist?
```

**Attachments 404 after a redeploy.** The uploads volume is not mounted; rows
survive and point at files that are gone. Check `Volume=b2b-uploads.volume` in
`b2b-api.container` and that `UPLOAD_DIR=/app/uploads`.

**Redis is down.** Expected to degrade, not to fail: the cache calls through to
Postgres, rate limiting falls back to in-process counters, the agent lock goes
per-process. If the API is *down* because Redis is, that is a bug — `b2b-api`
declares `Wants=`, not `Requires=`, for exactly this reason.

---

## 9. Destructive commands

```bash
podman volume rm b2b-pgdata       # ⚠ destroys all five databases, irreversibly
podman volume rm b2b-uploads      # ⚠ destroys every ticket attachment
podman system prune -a --volumes  # ⚠ both of the above, plus the images
```

`podman-system-reset` removes everything Podman owns on the host. There is no
undo and no confirmation beyond the first prompt.
