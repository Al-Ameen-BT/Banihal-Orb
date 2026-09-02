# Fresh production deployment — Podman

A clean server to a running platform. Linear: every step has a check, and each
one must pass before the next.

**Scope.** This is the *first* deployment onto a host with nothing on it. If you
are migrating an existing bare-metal install, stop — use
[`deploy/podman/README.md`](deploy/podman/README.md) §5b, which dumps and restores
your live data instead of provisioning empty databases. That runbook is also the
reference for day-2 upgrades, rollback, backups and troubleshooting; this document
does not repeat them.

Budget about 45 minutes, most of it waiting on image builds.

---

## What you are building

```
                    ┌──── b2b-nginx pod ─────────────────┐
  Browser ──443──►  │  TLS termination, one origin       │
                    │  /             → b2b-app:3000      │
                    │  /api, /health → b2b-app:3001      │
                    └────────────┬───────────────────────┘
                                 │  b2b network (10.89.10.0/24)
       ┌─────────────────────────┼──────────────────────────┐
┌──────┴───────────┐   ┌─────────┴─────────┐   ┌────────────┴───┐
│ b2b-app pod      │   │ b2b-postgres pod  │   │ b2b-redis pod  │
│  b2b-api  :3001  │   │  127.0.0.1:5432   │   │  not published │
│  b2b-web  :3000  │   │  vol: b2b-pgdata  │   └────────────────┘
│  vol: b2b-uploads│   └───────────────────┘
└──────────────────┘
```

Five databases on one cluster: `b2b`, `b2b_chat`, `b2b_ticketing`, `b2b_ticket`,
`b2b_ticketing_admin`.

Only nginx is exposed. Postgres binds loopback so host `psql` and `pg_dump` work
without putting the database on the network. Redis publishes nothing at all — an
unauthenticated Redis on a reachable port is a remote shell waiting to happen.

---

## 1. Host prerequisites

```bash
podman --version      # 5.0+ — the .pod Quadlet units require it
psql --version        # host client, for provisioning and backups
git --version
```

Podman 4.x cannot read the `.pod` units; `install.sh` refuses to run and tells you
so. Upgrade, or create the pods from an `ExecStartPre` in each `.container`.

**Rootless hosts only** — 80 and 443 are privileged:

```bash
echo 'net.ipv4.ip_unprivileged_port_start=80' | sudo tee /etc/sysctl.d/99-b2b.conf
sudo sysctl --system
```

### TLS certificate

For an internal deployment with no public DNS, self-signed is the correct choice —
ACME proves control of a *public* name and an RFC1918 address has none.

```bash
sudo mkdir -p /etc/nginx/ssl
sudo openssl req -x509 -nodes -days 825 -newkey rsa:2048 \
  -keyout /etc/nginx/ssl/b2b-site.key -out /etc/nginx/ssl/b2b-site.crt \
  -subj "/CN=b2b-site" \
  -addext "subjectAltName=IP:<server-ip>,DNS:<hostname>"
sudo chmod 600 /etc/nginx/ssl/b2b-site.key
```

Put **every** address clients will use in `subjectAltName`. A matching Common Name
has not been accepted since Chrome 58. Trust the certificate on each client
machine afterwards.

**✅ Check:** `openssl x509 -in /etc/nginx/ssl/b2b-site.crt -noout -text | grep -A1 "Alternative Name"` lists your IP and hostname.

---

## 2. Clone and install units

```bash
sudo git clone <repo-url> /opt/B2B-Site
cd /opt/B2B-Site
sudo ./deploy/podman/install.sh
```

Copies the Quadlet units to `/etc/containers/systemd`, installs the container
nginx config to `/etc/b2b/nginx/b2b-site.conf`, creates `/etc/b2b/*.env` stubs at
mode 0600, and reloads systemd. **It starts nothing.**

**✅ Check:** `ls /etc/containers/systemd/` shows the `.pod`, `.container`,
`.network` and `.volume` units.

---

## 3. Generate secrets

Three secrets are **required** and must each be ≥32 characters. The API refuses to
start without them.

```bash
for k in JWT_ACCESS_SECRET JWT_REFRESH_SECRET IMPERSONATION_SECRET \
         SLACK_TOKEN_SECRET PASSWORD_PEPPER; do
  echo "$k=\"$(openssl rand -hex 32)\""
done
POSTGRES_PASSWORD=$(openssl rand -hex 24); echo "POSTGRES_PASSWORD=$POSTGRES_PASSWORD"
```

Keep these somewhere durable now.

- `SLACK_TOKEN_SECRET` encrypts Slack tokens and AD passwords at rest. **Lose it
  and that data is unrecoverable; change it and existing secrets stop decrypting.**
- `PASSWORD_PEPPER` keys the password-reuse fingerprint. Changing it invalidates
  every stored fingerprint.

Both fall back to `JWT_ACCESS_SECRET` if unset, which couples them together —
set them explicitly.

---

## 4. Configure

Three files, all root-owned, mode 0600, on the host — never in an image layer,
which is readable by anyone who can pull it.

### `/etc/b2b/postgres.env`

```ini
POSTGRES_USER=postgres
POSTGRES_PASSWORD=<from step 3>
```

### `/etc/b2b/server.env`

Start from `server/.env.example`. The **9 required** values:

```ini
DATABASE_URL="postgresql://postgres:<pw>@b2b-postgres:5432/b2b?schema=public"
CHAT_DATABASE_URL="postgresql://postgres:<pw>@b2b-postgres:5432/b2b_chat"
TICKETING_DATABASE_URL="postgresql://postgres:<pw>@b2b-postgres:5432/b2b_ticketing"
TICKET_DATABASE_URL="postgresql://postgres:<pw>@b2b-postgres:5432/b2b_ticket"
ADMIN_TICKETING_DATABASE_URL="postgresql://postgres:<pw>@b2b-postgres:5432/b2b_ticketing_admin"

JWT_ACCESS_SECRET="<from step 3>"
JWT_REFRESH_SECRET="<from step 3>"
IMPERSONATION_SECRET="<from step 3>"
COOKIE_SECURE="true"
```

Then these, which are technically optional but wrong-by-default in production:

```ini
NODE_ENV="production"
PORT="3001"
TRUST_PROXY="10.89.10.0/24"          # ⚠ see below
ALLOWED_ORIGINS="https://<host>"      # exact origin, never *
FRONTEND_URL="https://<host>"         # builds password-reset links
ADMIN_DOMAINS="yourcompany.com"       # ⚠ see step 7
SLACK_TOKEN_SECRET="<from step 3>"
PASSWORD_PEPPER="<from step 3>"
REDIS_URL="redis://b2b-redis:6379"
UPLOAD_DIR="/app/uploads"

SMTP_HOST="..."                       # required in practice — MFA and
SMTP_PORT="587"                       # password reset both send mail
SMTP_USER="..."
SMTP_PASS="..."
MAIL_FROM="no-reply@yourcompany.com"  # must be an address SMTP may send as
```

> **`TRUST_PROXY` must be the subnet, not `loopback`.** nginx reaches the API from
> its address on the `b2b` network, and Express ignores `X-Forwarded-For` from an
> untrusted hop. Leave the default and every IP-keyed rate limiter collapses into
> one bucket keyed on nginx's container IP — with nothing in the logs. Never set
> it to `true`: that trusts a client-supplied header and makes the limiters
> bypassable by anyone who sends one.

### `/etc/b2b/client.env`

```ini
NEXT_PUBLIC_API_URL="https://<host>"
NEXT_PUBLIC_VAPID_PUBLIC_KEY=""        # optional, web push
```

> **`NEXT_PUBLIC_*` are build-time.** `next build` inlines them into the browser
> bundle; `build.sh` reads this file and passes them as build args. Setting them
> in a Quadlet unit does nothing. **To change one, rebuild the image.**

Because everything is served from one origin behind nginx, this is the site's own
`https://` address — which keeps the auth cookie first-party and CORS out of the
picture. Do not split the app and API across two addresses.

**✅ Check:** `sudo ls -l /etc/b2b/*.env` — all three, mode `-rw-------`.

---

## 5. Start the data tier and provision

```bash
sudo systemctl start b2b-postgres b2b-redis
sleep 10 && podman ps --format '{{.Names}}\t{{.Status}}'
```

Both must read `healthy`. Now create the five databases and their schemas.

> The container hostname `b2b-postgres` **does not resolve from the host**, so the
> URLs in `server.env` will not work here. Postgres publishes on `127.0.0.1:5432`,
> so override them for this one command.

```bash
cd /opt/B2B-Site/server
PW='<POSTGRES_PASSWORD>'
SUPERUSER_PSQL="psql postgresql://postgres:$PW@localhost:5432/postgres" \
DATABASE_URL="postgresql://postgres:$PW@localhost:5432/b2b" \
CHAT_DATABASE_URL="postgresql://postgres:$PW@localhost:5432/b2b_chat" \
TICKETING_DATABASE_URL="postgresql://postgres:$PW@localhost:5432/b2b_ticketing" \
TICKET_DATABASE_URL="postgresql://postgres:$PW@localhost:5432/b2b_ticket" \
ADMIN_TICKETING_DATABASE_URL="postgresql://postgres:$PW@localhost:5432/b2b_ticketing_admin" \
  bash db/provision.sh
```

Idempotent and safe to re-run: existence guards on databases, `IF NOT EXISTS` on
tables and indexes, `ON CONFLICT DO NOTHING` on seed rows. It never drops.

**✅ Check — the platform roles seeded.** The app cannot create an administrator
without these:

```bash
psql "postgresql://postgres:$PW@localhost:5432/b2b" \
  -c 'SELECT key, jsonb_array_length(permissions) AS keys FROM "PlatformRole" ORDER BY key;'
```

Expect exactly four rows: `administration 0`, `employee 8`, `hr_admin 13`,
`intern 5`. **`administration` holding 0 is correct** — its permissions are
computed as "everything" in code and never stored, which is what makes the role
impossible to strip.

**❌ Do NOT run `npm run db:seed`.** It creates demo organizations and fake users.
Development only.

---

## 6. Build and start

```bash
cd /opt/B2B-Site
sudo ./deploy/podman/build.sh          # tags :latest and :<git-sha>
```

The `:<git-sha>` tag is your rollback artifact. `build.sh` **refuses to build**
when `NEXT_PUBLIC_API_URL` is unset, rather than producing an image whose every
browser call fails after deploy.

```bash
sudo systemctl start b2b-api b2b-web
sleep 20
podman logs --tail 30 b2b-api
```

**✅ Check:** logs show the server listening, with no `Invalid environment
variables` block and no Prisma errors. A bad database URL logs "Server running"
and *then* exits — so wait the 20 seconds and look.

```bash
sudo systemctl start b2b-nginx
curl -fsSk https://localhost/health
```

**✅ Check:** `{"status":"ok","databases":{...all "connected"...}}`.

```bash
sudo systemctl enable b2b-postgres b2b-redis b2b-api b2b-web b2b-nginx
```

**`enable` is what makes the stack survive a reboot.** It is easy to forget and
only discovered at the worst possible moment.

---

## 7. Create the first administrator

There is no seeded admin on a production install and no CLI to make one. The
first administrator is created by **registering through the UI with an email whose
domain is listed in `ADMIN_DOMAINS`**.

1. Browse to `https://<host>/register`.
2. Choose **Organization**, and register with e.g. `you@yourcompany.com`.
3. `ADMIN_DOMAINS` matches, so the account is created as `ADMINISTRATOR` with the
   Administration platform role.

**✅ Check:**

```sql
SELECT email, role, "platformRoleId" FROM "User" WHERE role = 'ADMINISTRATOR';
-- platformRoleId must be plr_administration, not NULL
```

> ### ⚠️ `ADMIN_DOMAINS` is a self-service admin door
>
> While a domain is listed, **anyone who can reach `/register` with an address on
> it becomes a platform administrator** — no invite, no approval. On a fresh
> install that is how you bootstrap; it is not something to leave open.
>
> Immediately after creating your first admin, do one of:
>
> - **Narrow it** to a single address' domain that only you control; or
> - **Restrict `/register`** at nginx to your office network; or
> - **Empty `ADMIN_DOMAINS`** and restart. Existing administrators keep working
>   only if their domain stays listed — the login guard re-checks it, so emptying
>   it locks *every* admin out. Narrowing is usually the right move.
>
> Invite-only staff onboarding replaces this mechanism in a later release.

---

## 8. Verify before announcing

Do all of these in a browser. Each exercises a path that a container deployment
commonly breaks.

- [ ] Sign in as the administrator; the Control Plane loads.
- [ ] Create a client organization; register a user on its domain; that user signs in.
- [ ] **Create a ticket with an image attachment**, then reload and re-open it —
      proves the uploads volume is mounted, not just written to a container layer.
- [ ] **Open the assistant and confirm the reply streams** token by token, not in
      one lump — proves nginx's SSE bypass is working.
- [ ] The notification bell polls without errors.
- [ ] **Sign out, sign in again** — proves cookies are first-party over TLS.
- [ ] Trigger a password reset and confirm the email arrives with a working link.

```bash
# Rate limiting sees real client IPs, not nginx's — the TRUST_PROXY check.
podman logs b2b-api | grep -i 'rate' | tail
```

---

## 9. Before you call it done

- [ ] **Set up backups and point them at the container**, not at any host cluster:
      ```bash
      for db in b2b b2b_chat b2b_ticketing b2b_ticketing_admin b2b_ticket; do
        podman exec b2b-postgres pg_dump -U postgres -Fc "$db" > "/backups/${db}-$(date +%F).dump"
      done
      podman volume export b2b-uploads > "/backups/uploads-$(date +%F).tar"
      ```
- [ ] **Back up `/etc/b2b/server.env`** separately — it holds the secrets from
      step 3, and losing `SLACK_TOKEN_SECRET` is unrecoverable.
- [ ] **Restore-test one dump** into a scratch database. An untested backup is not a backup.
- [ ] **Reboot the host** and confirm every pod returns unattended.
- [ ] `ADMIN_DOMAINS` narrowed or `/register` restricted (step 7).
- [ ] Certificate trusted on the machines that will use the app.
- [ ] `COOKIE_SECURE=true` and `ALLOWED_ORIGINS` is an exact origin, not `*`.

---

## If something fails

| Symptom | Cause |
|---|---|
| API exits seconds after starting | A database URL. `podman logs --tail 50 b2b-api`. |
| `Invalid environment variables` | A required var missing from `server.env` — the log names each one. |
| `host not found in upstream "b2b-app"` | nginx cached the address. `systemctl restart b2b-nginx`. |
| Browser calls go to the wrong host | `NEXT_PUBLIC_API_URL` was wrong at *build* time. Fix `client.env`, rebuild. |
| Rate limits treat everyone as one client | `TRUST_PROXY` does not match the network. |
| Registration returns 503 `PLATFORM_ROLES_MISSING` | `provision.sh` did not seed `PlatformRole`. Re-run step 5. |
| Attachments 404 after redeploy | Uploads volume not mounted; check `UPLOAD_DIR=/app/uploads`. |

Fuller troubleshooting, and all day-2 operations, are in
[`deploy/podman/README.md`](deploy/podman/README.md).

---

## Never run these on production

```bash
podman volume rm b2b-pgdata        # destroys all five databases, irreversibly
podman volume rm b2b-uploads       # destroys every ticket attachment
podman system prune -a --volumes   # both of the above, plus the images
npm run db:seed                    # inserts demo organizations and fake users
```
