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
nginx config to `/etc/b2b/nginx/b2b-site.conf`, and reloads systemd. **It starts
nothing and writes no env files** — `build.sh` owns those (step 3).

**✅ Check:** `ls /etc/containers/systemd/` shows the `.pod`, `.container`,
`.network` and `.volume` units.

---

## 3. Configure, build and provision

One command does all of it:

```bash
cd /opt/B2B-Site
sudo ./deploy/podman/build.sh
```

It asks **once** for three things it cannot derive, then remembers them:

| Prompt | Example | Why it can't be generated |
|---|---|---|
| Public origin | `https://b2b.example.com` | Only you know this host's address. Becomes `FRONTEND_URL`, `ALLOWED_ORIGINS`, `NEXT_PUBLIC_API_URL`, and decides `COOKIE_SECURE`. |
| Admin email domains | `yourcompany.com` | ⚠ See step 6 — this is a self-service admin door. |
| SMTP host / port / user / password | `smtp.example.com` | A 6-digit MFA code is emailed on **every** login. No SMTP, no logins. |

Everything else it handles:

- **Generates** `POSTGRES_PASSWORD` (hex-24) and `JWT_ACCESS_SECRET`,
  `JWT_REFRESH_SECRET`, `IMPERSONATION_SECRET`, `SLACK_TOKEN_SECRET`,
  `PASSWORD_PEPPER` (hex-32 each), plus a VAPID key pair for Web Push — using the
  API image's own `web-push`, so no network fetch.
- **Derives** the five `*_DATABASE_URL` pointing at `b2b-postgres`, `REDIS_URL`,
  `UPLOAD_DIR`, and `TRUST_PROXY` (read from `Subnet=` in `b2b.network`, so the two
  cannot drift apart).
- **Builds** `b2b-api` and `b2b-web`, tagged `:latest` and `:<git-sha>`. That second
  tag is your rollback artifact.
- **Creates and verifies** the five databases, by running `server/db/provision.sh`
  inside the postgres container — no host `postgresql-client` needed.

Non-interactive:

```bash
FRONTEND_URL=https://b2b.example.com ADMIN_DOMAINS=yourcompany.com \
SMTP_HOST=smtp.example.com SMTP_PORT=587 SMTP_USER=… SMTP_PASS=… \
  sudo -E ./deploy/podman/build.sh
```

> **Keep the generated secrets somewhere durable now.** Copy
> `/etc/b2b/server.env` into your secrets manager. `SLACK_TOKEN_SECRET` encrypts
> Slack tokens and AD passwords at rest — lose it and that data is unrecoverable;
> change it and existing secrets stop decrypting. `PASSWORD_PEPPER` keys the
> password-reuse fingerprint; changing it invalidates every stored fingerprint.
> `build.sh` never regenerates a secret that already exists, precisely for this
> reason.

### ⚠ Never quote a value in `/etc/b2b/*.env`

The one rule, and the one that has already bitten this deployment. Quadlet's
`EnvironmentFile=` is **not** systemd's — it becomes `podman run --env-file`,
which reads the file **verbatim**:

```console
$ printf 'TRUST_PROXY="10.89.10.0/24"   # comment\n' > env
$ podman run --rm --env-file env alpine sh -c 'echo "[$TRUST_PROXY]"'
["10.89.10.0/24"   # comment]
```

Quotes *and* inline comments become part of the value. `config/env.ts` then
rejects the database URLs as `Invalid url`, the API exits 1, and `Restart=always`
turns that into a restart loop whose only symptom is `systemctl restart b2b-api`
failing with nothing obviously wrong.

`build.sh` writes these files unquoted and strips quotes from anything
hand-edited. **If you edit one by hand, re-run `build.sh`.**

---

## 4. Verify the config before starting anything

`build.sh` already ran both of these as its last phase; run them again any time
you touch `/etc/b2b/server.env`.

```bash
# What the API itself makes of the config — this is the exact module whose
# process.exit(1) shows up as a failed `systemctl restart`.
podman run --rm --env-file /etc/b2b/server.env localhost/b2b-api:latest \
  node -e 'require("/app/dist/config/env.js")' && echo "config OK"

# All five databases reachable, with their schemas.
podman run --rm --network b2b --env-file /etc/b2b/server.env \
  localhost/b2b-api:latest npm run db:verify
```

Migrating from an existing bare-metal cluster? Copy the data in now, with the old
application **stopped**:

```bash
sudo systemctl stop b2b.service
./deploy/podman/migrate-db.sh
```

---

## 5. Start the application

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

## 6. Create the first administrator

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

## 7. Verify before announcing

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

## 8. Before you call it done

- [ ] **Set up backups and point them at the container**, not at any host cluster:
      ```bash
      for db in b2b b2b_chat b2b_ticketing b2b_ticketing_admin b2b_ticket; do
        podman exec b2b-postgres pg_dump -U postgres -Fc "$db" > "/backups/${db}-$(date +%F).dump"
      done
      podman volume export b2b-uploads > "/backups/uploads-$(date +%F).tar"
      ```
- [ ] **Back up `/etc/b2b/server.env`** separately — it holds the generated secrets,
      and losing `SLACK_TOKEN_SECRET` is unrecoverable.
- [ ] **Restore-test one dump** into a scratch database. An untested backup is not a backup.
- [ ] **Reboot the host** and confirm every pod returns unattended.
- [ ] `ADMIN_DOMAINS` narrowed or `/register` restricted (step 6).
- [ ] Certificate trusted on the machines that will use the app.
- [ ] `COOKIE_SECURE=true` and `ALLOWED_ORIGINS` is an exact origin, not `*`.

---

## If something fails

| Symptom | Cause |
|---|---|
| API exits seconds after starting | A database URL. `podman logs --tail 50 b2b-api`. |
| `Invalid environment variables` | A missing var, or a **quoted** one (step 3). The log names each. Re-run `build.sh`. |
| `host not found in upstream "b2b-app"` | nginx cached the address. `systemctl restart b2b-nginx`. |
| Browser calls go to the wrong host | `NEXT_PUBLIC_API_URL` was wrong at *build* time. Fix `client.env`, rebuild. |
| Rate limits treat everyone as one client | `TRUST_PROXY` does not match the network. |
| Registration returns 503 `PLATFORM_ROLES_MISSING` | `provision.sh` did not seed `PlatformRole`. Re-run `build.sh`. |
| Attachments 404 after redeploy | Uploads volume not mounted; check `UPLOAD_DIR=/app/uploads`. |

Fuller troubleshooting, and all day-2 operations, are in
[`deploy/podman/README.md`](deploy/podman/README.md).

---

## Never run these on production

```bash
sudo ./deploy/podman/drop.sh --all-gone   # destroys all five databases AND every attachment
podman volume rm b2b-pgdata               # destroys all five databases, irreversibly
podman volume rm b2b-uploads              # destroys every ticket attachment
podman system prune -a --volumes          # both of the above, plus the images
npm run db:seed                           # inserts demo organizations and fake users
```

`sudo ./deploy/podman/drop.sh` **without** `--all-gone` is the safe one: it removes
the containers, pods and network but leaves both volumes intact. That is the
"redeploy from scratch after a bad build" command.
