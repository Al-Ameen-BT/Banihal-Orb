# Database Reconciliation — Migration Guide

The running `b2b` database was built from an **older schema** than the current
code. The app cannot work against it until they're reconciled (e.g. `login`
returns `500 — column User.customerId does not exist`). This guide brings the DB
in line with `server/prisma/schema.prisma`, **without dropping your data**.

| Live DB today | Code/schema expects |
|---|---|
| table `Organization` | `customers` |
| `User.organizationId` | `User.customerId` |
| `customers.domain` / `mailId` / contact fields | missing → added + backfilled |
| `AuditLog` (no `customerId`) | `AuditLog.customerId` |
| `OrgFeatureFlag/ServiceRequest.organizationId` | `…​.customerId` |
| `OrganizationService` | `customerServices` (`CustomerService`) |
| Role enum `SAAS_ADMIN` | `ADMINISTRATOR` |
| _(no table)_ | `serviceCatalog` |
| `ApiUsage` | _(no model — left as-is)_ |

Two SQL scripts do the work, both wrapped in a transaction:
- `server/prisma/reconcile-org-to-customer.sql` — **Phase 1** (orgs, users, domain, audit)
- `server/prisma/reconcile-remaining.sql` — **Phase 2** (other tables + Role enum)

> Run from the `server/` directory. Commands shown for **PowerShell** (Windows).
> `prisma db execute` reads `DATABASE_URL` from `server/.env`.

---

## 0. Back up first (non-negotiable)

Phase 2 **drops** three obsolete columns. A backup is your only rollback.

```powershell
cd C:\Users\admin\Desktop\B2B-Site\server
# Uses DATABASE_URL from .env; adjust if pg_dump isn't on PATH (it ships with Postgres).
pg_dump "postgresql://USER:PASS@localhost:5432/b2b" -f ..\backup_before_migration.sql
```

No `pg_dump`? Export via a DB GUI (pgAdmin/DBeaver → "Backup") before continuing.

## 1. Stop the dev server

The Node process locks the Prisma engine DLL and would block `prisma generate`
later. Stop `npm run dev` (Ctrl-C), or:

```powershell
Get-NetTCPConnection -LocalPort 3001 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

## 2. Apply Phase 1 — orgs / users / domain / audit

```powershell
npx prisma db execute --file prisma/reconcile-org-to-customer.sql --schema prisma/schema.prisma
```

Backfills `customers.domain` from each org admin's work email, adds
`AuditLog.customerId`, renames `Organization`→`customers` and
`User.organizationId`→`customerId`, adds the unique index on `domain`.

## 3. Apply Phase 2 — remaining tables + Role enum

```powershell
npx prisma db execute --file prisma/reconcile-remaining.sql --schema prisma/schema.prisma
```

Relabels `SAAS_ADMIN`→`ADMINISTRATOR`, renames the remaining `organizationId`
columns, converts `OrganizationService`→`customerServices` (dropping the 3
obsolete columns), and creates `serviceCatalog`.

## 4. Regenerate the Prisma client & confirm zero drift

```powershell
npx prisma generate
# Exit 0 = schema and database now match. Exit 2 = residual drift (inspect with --script).
npx prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --exit-code
```

If drift remains, see what's left and apply it:

```powershell
npx prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --script
```

## 5. (Optional) Baseline migration history

The project currently uses `db push` and has no `migrations/` folder, but the
CI/CD workflow runs `prisma migrate deploy`. Baseline once so it has history:

```powershell
New-Item -ItemType Directory -Force prisma\migrations\0_init | Out-Null
npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script `
  | Out-File -Encoding utf8 prisma\migrations\0_init\migration.sql
npx prisma migrate resolve --applied 0_init
```

From here, `prisma migrate deploy` (used by `.github/workflows/ci-cd.yml`) is the
deploy path; generate a new migration per schema change with `prisma migrate dev`.

---

## 6. Verify it actually works (runtime, not types)

Restart the server (`npm run dev`) and drive the API:

```powershell
# Login should now succeed (no more "column User.customerId does not exist")
curl.exe -s -i -X POST http://localhost:3001/api/auth/login `
  -H "Content-Type: application/json" `
  -d '{\"email\":\"<an-admin-email>\",\"password\":\"<password>\"}'
```

Then, end-to-end:
1. **Register an org** (Org tab) → confirm a `customers` row with `domain` set from the admin's work email, and a `CUSTOMER_CREATED` audit row.
2. **Register a user** with a matching work-email domain (User tab) → joins that org; `USER_REGISTERED` audit row.
3. **Log in / out** as a USER and an ORG_ADMIN → `LOGIN` / `LOGOUT` rows for all roles.
4. As the **Administrator**, open the Users page → the **System Activity Log** lists those events; test the action / role / org / date filters.

```sql
-- spot-check the audit trail
SELECT a.action, a."createdAt", u.email, u.role, c.name AS org
FROM "AuditLog" a
JOIN "User" u ON u.id = a."performedById"
JOIN "customers" c ON c.id = a."customerId"
ORDER BY a."createdAt" DESC LIMIT 20;
```

---

## Rollback

Everything is transactional, so a failed script leaves the DB untouched. If a
script **succeeds** but you want to undo it (e.g. Phase 2's dropped columns):

```powershell
# Restore the pre-migration snapshot from step 0
psql "postgresql://USER:PASS@localhost:5432/b2b" -f ..\backup_before_migration.sql
```

## Notes
- Run **Phase 1 before Phase 2** — Phase 2's column renames assume Phase 1's table rename has happened.
- Scripts are safe to re-run only partially: a second run will error on already-renamed objects. If a phase half-fails, restore from backup and re-run that phase.
- `ApiUsage` is intentionally left in place; remove it manually only if nothing depends on it.
