# Upgrade runbook — platform IAM, phases 1 & 2

Bare-metal deployment. Takes a server already running the previous release under
`b2b.service` and lands the IAM schema and permission engine.

**Read this first:** phases 1 and 2 are deliberately **inert**. They add tables,
columns and an engine, but change no authorization decision — every user keeps
exactly the access they have today. That is what makes them safe to ship on their
own, and it is also what you are testing: *nothing changed, and the new data is
correct.* If any behaviour changes, something is wrong.

Enforcement lands in phase 4. Do not skip ahead.

---

## What ships

| Change | Effect on running system |
|---|---|
| `PlatformRole` table + 4 seeded roles | New. Nothing reads it for decisions yet. |
| `EmailVerificationToken` table | New. Unused until phase 3. |
| `User.platformRoleId` | Backfilled: every existing `ADMINISTRATOR` → Administration. |
| `User.emailVerifiedAt` | Backfilled: **every existing user marked verified**, so nobody is locked out. |
| CHECK `User_platform_role_ck` | `role='ADMINISTRATOR'` now requires a platform role. |
| Permission engine | Loaded per request; **denies nothing**. |
| `prid` claim in the access JWT | Additive. Old tokens without it resolve to no permissions — harmless while nothing is enforced. |
| `GET /api/saas-admin/roles`, `/roles/catalog` | New, read-only, `roles.manage` gated. |
| `/users/me` response | Gains `emailVerifiedAt`, `platformRole`, `permissions`. Additive — old clients ignore them. |

**Registration fix included.** The CHECK constraint would otherwise have broken
`POST /api/auth/register` for any address on an `ADMIN_DOMAINS` domain — that path
creates an `ADMINISTRATOR` and did not set a platform role, so the INSERT would be
rejected and the request would 500. It now assigns Administration alongside.
Verify it explicitly in step 7; it is the one genuinely new failure mode.

---

## 0. Before you touch the server

- [ ] **Take a database backup and confirm it restores.** The schema change is
      forward-only; the backup is your only way back.
- [ ] Pick a low-traffic window. The service restarts.
- [ ] Have a second terminal open on the server for `journalctl -fu b2b`.

```bash
ssh <production>
cd /opt/B2B-Site

# Record what you are rolling back TO.
git rev-parse --short HEAD | tee ~/rollback-sha.txt

# Back up all five databases.
mkdir -p ~/preupgrade && cd ~/preupgrade
for db in b2b b2b_chat b2b_ticketing b2b_ticketing_admin b2b_ticket; do
  sudo -u postgres pg_dump -Fc "$db" > "${db}-$(date +%F-%H%M).dump"
done
ls -lh
```

---

## 1. Capture a baseline

You cannot prove "nothing changed" without knowing what it looked like. Record
this **before** deploying.

```bash
cd /opt/B2B-Site
curl -fsS http://localhost:3001/health | tee ~/preupgrade/health-before.json
sudo -u postgres psql -d b2b -c \
  "SELECT role, count(*) FROM \"User\" GROUP BY role ORDER BY role;" \
  | tee ~/preupgrade/roles-before.txt
```

Keep `roles-before.txt`. Step 6 compares against it — the counts must be identical.

Also note, from the UI, one working example of each: an administrator opening the
Control Plane, an org admin opening Users, and a normal user opening Ticketing.
Those are your three regression checks.

---

## 2. Deploy

```bash
cd /opt/B2B-Site
git fetch --all
git checkout <release-tag-or-sha>
sudo ./deploy.sh
```

`deploy.sh` installs dependencies, regenerates the Prisma clients (**required** —
there are new models), provisions the database, runs the verify preflight, builds
both bundles, and restarts `b2b.service`.

> ⚠️ **Watch the provisioning line.** `deploy.sh` treats a `db:provision` failure
> as a *warning* and keeps going:
> ```
> ⚠️ Warning: DB provisioning failed. Check DB connection settings & superuser access.
> ```
> If you see that, **stop**. Do not let the deploy continue to systemd. The
> `db:verify` gate that follows catches most cases, but not all — a missing
> `PlatformRole` seed passes verify and fails later at runtime.

Expected tail:

```
🔎 Verifying required databases are available (fail-fast preflight)...
✅ ...
🟢 Restarting service...
🎉 Native systemd deployment process completed successfully!
```

---

## 3. Service is actually up

`systemctl restart` returning 0 only means the process started. A bad database URL
exits seconds later and systemd restarts it forever.

```bash
systemctl is-active b2b.service
sleep 15 && systemctl is-active b2b.service     # still active 15s later?
journalctl -u b2b -n 40 --no-pager | grep -Ei 'error|listen|running'
curl -fsS http://localhost:3001/health
```

`/health` must report every database `connected`. A `degraded` response here means
one store is unreachable — fix that before going further.

---

## 4. The schema landed

```bash
sudo -u postgres psql -d b2b
```

```sql
-- 4a. The four roles, with the expected key counts.
SELECT key, system, jsonb_array_length(permissions) AS keys
  FROM "PlatformRole" ORDER BY key;
```

Expect exactly:

| key | system | keys |
|---|---|---|
| `administration` | t | **0** |
| `employee` | t | 8 |
| `hr_admin` | t | 13 |
| `intern` | t | 5 |

`administration` holding **0** is correct, not a failed seed. Its permissions are
computed as "everything" in code, never stored — that is what makes the role
impossible to strip and means future permission keys are automatically held.

```sql
-- 4b. Every platform admin got a role. MUST be 0.
SELECT count(*) FROM "User" WHERE role = 'ADMINISTRATOR' AND "platformRoleId" IS NULL;

-- 4c. Nobody is locked out by the verification column. MUST be 0.
SELECT count(*) FROM "User" WHERE "emailVerifiedAt" IS NULL;

-- 4d. The constraint exists.
SELECT conname, convalidated FROM pg_constraint WHERE conname = 'User_platform_role_ck';

-- 4e. The new token table exists.
SELECT to_regclass('public."EmailVerificationToken"');
```

**If 4b or 4c returns anything but 0, stop and roll back.** A non-zero 4c means
existing users will be locked out the moment phase 3 ships.

`convalidated = f` in 4d is expected — the constraint was added `NOT VALID`, which
skips a scan of existing rows while still enforcing on every write.

---

## 5. Provisioning is still idempotent

The single most important property of `db/provision.sh` is that re-running it is
safe. Prove it on production, because a future deploy will do exactly this.

```bash
cd /opt/B2B-Site/server
sudo -u <service-user> npm run db:provision
sudo -u <service-user> npm run db:verify
```

Then re-run **4a–4c**. Every number must be unchanged.

> This step specifically catches the most dangerous failure mode in the release:
> if the `emailVerifiedAt` backfill were written without its
> `information_schema` guard, this re-run would silently mark every *pending*
> signup as verified. 4c staying at 0 with no new verified rows is the proof it
> is guarded correctly.

---

## 6. Nothing regressed

This is the real test. Everything below worked before the upgrade and must still
work identically.

```bash
sudo -u postgres psql -d b2b -c \
  "SELECT role, count(*) FROM \"User\" GROUP BY role ORDER BY role;" \
  > ~/roles-after.txt
diff ~/preupgrade/roles-before.txt ~/roles-after.txt && echo "role counts unchanged ✅"
```

Then in a browser, against the three baselines from step 1:

- [ ] **Administrator** — sign in; Control Plane, Customer Services, Service
      Catalog and Slack Bots all load; the Platform nav section is unchanged.
- [ ] **Org admin** — sign in; Users and Services load; team list renders.
- [ ] **Regular user** — sign in; Ticketing and the Assistant load.
- [ ] **Create a ticket with an image attachment** — exercises uploads, which the
      Prisma client regeneration touches.
- [ ] **Assistant streams** token by token — confirms SSE is unaffected.
- [ ] **Sign out and back in** — confirms the new `prid` JWT claim mints and
      verifies cleanly.

> Existing sessions keep tokens with no `prid` claim. That is fine and expected:
> they resolve to an empty permission set, and nothing is enforced yet. They pick
> up the claim on their next login or token refresh, well before phase 4.

---

## 7. The new surface

```bash
# As an administrator, in the browser devtools console or with a session cookie:
#   GET /api/users/me   → must now include platformRole and permissions
curl -fsS -b "accessToken=<token>" http://localhost:3001/api/users/me | python3 -m json.tool
```

Expect `"platformRole": {"key": "administration", "name": "Administration"}` and a
`permissions` array of all 17 keys. For a customer account, `platformRole` is
`null` and `permissions` is `[]`.

```bash
# The read-only roles endpoint (administrators only).
curl -fsS -b "accessToken=<token>" http://localhost:3001/api/saas-admin/roles \
  | python3 -m json.tool | head -30
```

**Then verify the registration fix** — the one new failure mode:

- [ ] Register a throwaway account whose email is on an `ADMIN_DOMAINS` domain.
      It must succeed (**201**), not 500. Confirm the row is valid, then remove it:

```sql
SELECT email, role, "platformRoleId" FROM "User" WHERE email = '<throwaway>';
-- role=ADMINISTRATOR AND platformRoleId IS NOT NULL
DELETE FROM "User" WHERE email = '<throwaway>';
```

If that registration 500s, the fix did not deploy — check you are on the right
commit and that `npm run build` actually reran.

---

## 8. Watch it for an hour

```bash
journalctl -fu b2b | grep -Ei 'error|warn|prisma|constraint'
```

Specifically watch for `User_platform_role_ck` violations. One would mean some
code path still creates an `ADMINISTRATOR` without a platform role — the exact bug
step 7 tests for.

---

## Rollback

Bare metal has no image to retag, so rollback is a redeploy of the previous commit.

```bash
cd /opt/B2B-Site
git checkout "$(cat ~/rollback-sha.txt)"
sudo ./deploy.sh
```

> ⚠️ **The database does not roll back with the code, and one part of it must.**
>
> The new columns are harmless to old code — it simply ignores them. The CHECK
> constraint is **not**: old code creates `ADMINISTRATOR` rows without a platform
> role, so with the constraint still in place, registration on an `ADMIN_DOMAINS`
> address fails. Drop it as part of any rollback:
>
> ```sql
> ALTER TABLE "User" DROP CONSTRAINT IF EXISTS "User_platform_role_ck";
> ```
>
> Leave the tables and columns in place — re-running `provision.sh` on the next
> attempt is idempotent and will not re-backfill `emailVerifiedAt`.

Restore from the step-0 dump only if data is actually wrong; the schema change
alone does not warrant it.

---

## Do not, on production

- ❌ `npm run db:seed` — creates demo organizations and users. Development only.
- ❌ `npm run db:seed:tickets` — same.
- ❌ Skip the backup. The schema change is forward-only.
- ❌ Continue past a `db:provision` warning in step 2.
- ❌ Ship phase 3 in the same window. It changes `POST /api/auth/register` from
      `201` + session cookies to `202`, and its server and client halves must land
      together. It is a separate deployment with its own runbook.

---

## Sign-off

- [ ] Backup taken **and** restore-tested
- [ ] `deploy.sh` completed with no provisioning warning
- [ ] `b2b.service` active, still active after 15s, `/health` all-connected
- [ ] 4a role counts: 0 / 8 / 13 / 5
- [ ] 4b and 4c both **0**
- [ ] `provision.sh` re-run leaves 4a–4c unchanged
- [ ] Role counts identical to the pre-upgrade baseline
- [ ] All three roles sign in and reach their usual pages
- [ ] Ticket with attachment; assistant streams
- [ ] `/users/me` carries `platformRole` + `permissions`
- [ ] Admin-domain registration returns 201, not 500
- [ ] One hour of logs with no constraint violations

Deployed by ................... Date ................... Rollback sha ...................
