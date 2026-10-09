-- ============================================================================
-- Phase 2 reconciliation: everything reconcile-org-to-customer.sql left behind.
-- Run this AFTER Phase 1. Wrapped in one transaction.
--
-- Brings the remaining tables + the Role enum in line with schema.prisma:
--   1. Role enum value  SAAS_ADMIN -> ADMINISTRATOR  (relabels all rows)
--   2. OrgFeatureFlag.organizationId -> customerId
--   3. ServiceRequest.organizationId -> customerId
--   4. OrganizationService -> customerServices  (+ column renames + drop obsolete)
--   5. Create the serviceCatalog table (ServiceCatalog model)
--
-- ⚠️ Step 4 DROPS three obsolete columns (status / enabled / lastBilledAt). The
--    new CustomerService model derives status from endDate in code and does not
--    use them; leaving them as NOT NULL would break Prisma inserts. Their data is
--    discarded — your pg_dump backup is the only way back. Review before running.
--
-- NOT touched (intentionally): the "ApiUsage" table has no Prisma model. It is
--    left as-is (its organizationId FK auto-follows the Phase 1 table rename).
--    `prisma db push` will later report it as an extra table — drop it only if
--    you're sure nothing reads it.
-- ============================================================================

BEGIN;

-- ── 1. Role enum: SAAS_ADMIN -> ADMINISTRATOR ───────────────────────────────
-- RENAME VALUE relabels in place; every user currently 'SAAS_ADMIN' becomes
-- 'ADMINISTRATOR' with no row rewrite. (Transaction-safe on PostgreSQL 10+.)
ALTER TYPE "Role" RENAME VALUE 'SAAS_ADMIN' TO 'ADMINISTRATOR';

-- ── 2. OrgFeatureFlag.organizationId -> customerId ──────────────────────────
ALTER TABLE "OrgFeatureFlag" RENAME COLUMN "organizationId" TO "customerId";

-- ── 3. ServiceRequest.organizationId -> customerId ──────────────────────────
ALTER TABLE "ServiceRequest" RENAME COLUMN "organizationId" TO "customerId";

-- ── 4. OrganizationService -> customerServices (model: CustomerService) ─────
ALTER TABLE "OrganizationService" RENAME TO "customerServices";
ALTER TABLE "customerServices" RENAME COLUMN "organizationId" TO "customerId";
ALTER TABLE "customerServices" RENAME COLUMN "purchasedAt"    TO "purchaseDate";
ALTER TABLE "customerServices" RENAME COLUMN "renewsAt"       TO "endDate";
-- Drop columns the new model no longer has (would otherwise block inserts):
ALTER TABLE "customerServices"
  DROP COLUMN "status",
  DROP COLUMN "enabled",
  DROP COLUMN "lastBilledAt";
-- endDate drives expiry status; Prisma declares @@index([endDate]).
CREATE INDEX IF NOT EXISTS "customerServices_endDate_idx" ON "customerServices" ("endDate");

-- ── 5. serviceCatalog (global ServiceCatalog model; no source data) ─────────
CREATE TABLE IF NOT EXISTS "serviceCatalog" (
  "id"          TEXT PRIMARY KEY,
  "name"        TEXT NOT NULL,
  "description" TEXT,
  "category"    TEXT,
  "basePrice"   INTEGER NOT NULL DEFAULT 0,
  "enabled"     BOOLEAN NOT NULL DEFAULT true,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "serviceCatalog_enabled_idx" ON "serviceCatalog" ("enabled");

COMMIT;

-- ============================================================================
-- VERIFY (run separately):
--   SELECT DISTINCT role FROM "User";                       -- no SAAS_ADMIN left
--   SELECT "customerId" FROM "ServiceRequest" LIMIT 1;      -- column exists
--   SELECT "customerId","endDate" FROM "customerServices" LIMIT 1;
--   SELECT * FROM "serviceCatalog" LIMIT 1;                 -- table exists (empty)
-- ============================================================================
