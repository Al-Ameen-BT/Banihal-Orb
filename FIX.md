# Production Update Guide

**Last updated:** 2026-06-02

This guide covers deploying the current round of changes to a running production
instance. Read the whole thing before starting — this update contains
**destructive database changes** that drop tables/columns and add required
columns.

---

## 1. What's in this update

| Area | Change | Production impact |
|------|--------|-------------------|
| **Chatbot** | `/chat` proxies server-side to the **Analytics Agent** SSE endpoint at `:8050`; tokens are buffered into one `{ reply }`. | New env var; the agent must be running. |
| **DB — billing** | `ApiUsage` table **removed**. | Table dropped. |
| **DB — tenant** | `Organization` → **`Customer`** (table `customers`); FK `organizationId` → `customerId`; new **required** columns `mailId`, `contactPerson`, `contactNumber` + nullable `domain`. | Table/columns renamed; new NOT NULL columns. |
| **DB — services** | `OrganizationService` **dropped**; added **`services`** (catalog, main→sub) and **`customerServices`** (purchases w/ `endDate`). | Tables dropped/added. |
| **API** | Auth `register` now requires `contactNumber`; new SaaS-admin endpoints under `/api/saas-admin/catalog`, `/services`, `/customers/:id/services`. | Clients must send `contactNumber`. |

> ⚠️ Because of the model/column renames and dropped tables, **existing rows in
> the affected tables cannot be migrated automatically.** Plan for either a
> data backfill (migration SQL you write) or a reseed on a fresh database.

---

## 2. Prerequisites

- [ ] **Full database backup** taken (see §6 rollback).
- [ ] **PostgreSQL** reachable; `server/.env` `DATABASE_URL` correct.
- [ ] **Analytics Agent** running on the app host (port 8050):
  ```bash
  curl -s -m 8 -X POST http://localhost:8050/api/chat \
    -H "Content-Type: application/json" -d '{"message":"ping","history":[]}'
  # expect a text/event-stream with `data: {"token": ...}` lines, ending in `data: [DONE]`
  ```
- [ ] The agent's own model backend (e.g. Ollama `qwen2.5:3b` on `:11435`) available, if the agent depends on it: `ollama list`.
- [ ] Node 20+ and Python 3 on the host (the deployer uses both).

---

## 3. Environment variables

Add/confirm these in **`server/.env`** (defaults shown; the server falls back to
these if unset, but set them explicitly in production):

```ini
# Chatbot backend — Analytics Agent (SSE) on the same host
AGENT_URL="http://localhost:8050"

# Legacy Ollama settings (the agent manages its own model now; used by the deploy preflight)
OLLAMA_URL="http://localhost:11435"
OLLAMA_MODEL="qwen2.5:3b"
```

No client env changes are required.

---

## 4. Apply the update

### Option A — unified deployer (recommended)

The repo ships [`deploy_services.py`](deploy_services.py), which installs/refreshes
the `b2bweb.service` systemd unit and, during preparation, runs: `npm install` →
`prisma generate` → `prisma db push` → `db:seed` → `build`, plus an **Ollama
preflight** (checks reachability + auto-pulls the model if missing). The unit also
now declares `After=/Wants=ollama.service`.

```bash
git pull
sudo python3 deploy_services.py --install         # production build + systemd
# preview the generated unit without writing anything:
# sudo python3 deploy_services.py --install --dry-run
```

> The deployer's `db push` step is **best-effort** and will warn (not abort) on
> failure. For a production DB with data you care about, prefer Option B so you
> control the migration explicitly, then run the deployer to (re)start services.

### Option B — manual, controlled steps

```bash
git pull

# ---- server ----
cd server
npm install
npm run db:generate          # regenerate Prisma client

# Choose ONE database path:

#  (B1) Fresh / non-critical data — accept the destructive reset, then reseed:
npm run db:push              # drops/renames per the new schema (DATA LOSS)
npm run db:seed              # repopulates catalog + customers + purchases

#  (B2) Production data you must keep — generate a reviewed migration instead:
#   npx prisma migrate dev --create-only --name customer_services_redesign
#   # edit the generated SQL to backfill mailId/contactPerson/contactNumber and
#   # migrate OrganizationService rows -> services + customerServices, THEN:
#   npx prisma migrate deploy

npm run build                # compile TypeScript -> dist/

# ---- client ----
cd ../client
npm install
npm run build                # Next.js production build
```

Then restart services (if not using the deployer):
```bash
sudo systemctl restart b2bweb.service
```

---

## 5. Verify

```bash
# Service + logs
systemctl status b2bweb.service
journalctl -u b2bweb.service -f -n 100

# Health
curl -s http://localhost:3001/health        # {"status":"ok"}
```

Smoke test in the app:
- [ ] **Login** as the seeded SaaS admin (`admin@platform.com` / `SaasAdmin1!` if reseeded).
- [ ] **Register** a new org — the form now requires **Contact number**; submit succeeds.
- [ ] **/chat** shows the **Live** badge and returns a grounded reply (confirms Ollama).
- [ ] **/services** (org view) lists subscriptions with Active/Expiring/Expired badges.
- [ ] **/saas-admin/services** → *Customer Services* tab filters by status; Renew/Remove work.
- [ ] **/saas-admin/services** → *Catalog* tab: add a main service + a sub-service.
- [ ] **/saas-admin/orgs/[id]**: assign a catalog service to a customer with an end date.

---

## 6. Rollback

1. **Code:** redeploy the previous commit (`git checkout <prev-sha>` → rebuild → restart),
   or `git revert` the update commit.
2. **Database:** restore from the backup taken in §2. The schema changes are
   destructive and not reversible by `prisma` alone — the DB backup is the only
   reliable rollback for data.
3. **Ollama:** no rollback needed; if the chat backend is unavailable the app
   stays up and `/chat` returns a friendly "assistant unavailable" message.

---

## 7. Notes & gotchas

- **Required contact fields:** any external script/integration that calls
  `POST /api/auth/register` must now include `contactNumber` (min 7 chars), or it
  gets `400 VALIDATION_ERROR`.
- **`domain`** is derived server-side from the contact email (the part after `@`,
  `null` for `gmail.com`) — it is not a form input.
- **Service status is computed** from `customerServices.endDate` (ACTIVE / EXPIRING
  <30d / EXPIRED) — there is no stored status column to update.
- **Catalog deletes** are blocked (`409 SERVICE_IN_USE`) for services that have
  customer purchases; deactivate instead.
- **Agent host & exposure:** `/api/chat` proxies **server-side** to `AGENT_URL`
  (default `http://localhost:8050`, same host). Keep the agent internal — do **not**
  expose port 8050 publicly; the browser only ever talks to your Express API (with
  the auth cookie). If the agent runs on another machine, set `AGENT_URL` to its address.
- **Buffered streaming:** the agent streams tokens, but the server reads the full
  stream and returns one `{ reply }`, so the chat UI shows the answer once (no live
  typing). The client contract is unchanged.
- The orphaned `ServiceStatus` enum remains in the schema as a derived/UI type only.
