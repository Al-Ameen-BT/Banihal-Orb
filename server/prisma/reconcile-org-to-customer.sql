-- ============================================================================
-- Non-destructive reconciliation: Organization → customers
--
-- Brings the live `b2b` database in line with the current Prisma schema for the
-- org/user/domain parts ONLY. No table is dropped and no row is deleted; data is
-- preserved via RENAME + ADD COLUMN + backfill, all inside one transaction.
--
-- Scope (exactly what was requested):
--   1. Rename table  "Organization"            -> "customers"
--   2. Rename column "User"."organizationId"   -> "customerId"
--  2b. Add "AuditLog"."customerId" (+ backfill + index) for the audit-log feature
--   3. Add columns   domain, mailId, contactPerson, contactNumber to customers
--   4. Backfill domain (and mailId/contactPerson) from each org's ORG_ADMIN work email
--   5. Add the UNIQUE index on customers.domain
--   Index/constraint names are also realigned to Prisma's naming so a later
--   `prisma migrate` / `db push` sees no drift on these objects.
--
-- NOT in scope (still diverges from schema.prisma after this runs — see notes):
--   OrganizationService, ApiUsage, OrgFeatureFlag/ServiceRequest.customerId,
--   ServiceCatalog/CustomerService, and the Role enum (live has SAAS_ADMIN, code
--   expects ADMINISTRATOR).
--
-- Run AFTER reviewing, e.g.:
--   psql "$DATABASE_URL" -f prisma/reconcile-org-to-customer.sql
--   (or)  npx prisma db execute --file prisma/reconcile-org-to-customer.sql
-- Take a backup first:  pg_dump "$DATABASE_URL" > backup_before_reconcile.sql
-- ============================================================================

BEGIN;

-- ── 1. Rename the org table and realign its index/constraint names ──────────
ALTER TABLE "Organization" RENAME TO "customers";
ALTER INDEX "Organization_pkey"     RENAME TO "customers_pkey";
ALTER INDEX "Organization_slug_key" RENAME TO "customers_slug_key";
ALTER INDEX "Organization_slug_idx" RENAME TO "customers_slug_idx";

-- ── 2. Rename User.organizationId -> customerId (FK + index follow) ──────────
ALTER TABLE "User" RENAME COLUMN "organizationId" TO "customerId";
ALTER TABLE "User" RENAME CONSTRAINT "User_organizationId_fkey" TO "User_customerId_fkey";
ALTER INDEX "User_organizationId_idx" RENAME TO "User_customerId_idx";

-- ── 2b. AuditLog.customerId (required by the audit-log feature) ─────────────
-- Add the scoping column, backfill from each entry's performer org, enforce
-- NOT NULL, and add the index Prisma expects (@@index([customerId])).
ALTER TABLE "AuditLog" ADD COLUMN "customerId" TEXT;

UPDATE "AuditLog" a
SET "customerId" = u."customerId"
FROM "User" u
WHERE u.id = a."performedById";

-- Safety net: any orphaned audit rows (performer no longer exists) get pinned
-- to the earliest org so NOT NULL can be enforced without dropping history.
UPDATE "AuditLog"
SET "customerId" = (SELECT id FROM "customers" ORDER BY "createdAt" ASC LIMIT 1)
WHERE "customerId" IS NULL;

ALTER TABLE "AuditLog" ALTER COLUMN "customerId" SET NOT NULL;
CREATE INDEX "AuditLog_customerId_idx" ON "AuditLog" ("customerId");

-- ── 3. Add the new columns (nullable for now, so existing rows don't break) ──
ALTER TABLE "customers"
  ADD COLUMN "mailId"        TEXT,
  ADD COLUMN "contactPerson" TEXT,
  ADD COLUMN "contactNumber" TEXT,
  ADD COLUMN "domain"        TEXT;

-- ── 4. Backfill from each org's primary admin ───────────────────────────────
-- Pick one representative user per org, preferring an ORG_ADMIN, then earliest.
-- domain is ONLY derived when that representative is an ORG_ADMIN with a real
-- (non-gmail) work-email domain — exactly "the org admin's work email".
UPDATE "customers" c
SET
  "mailId"        = COALESCE(rep.email, 'unknown@' || c.slug || '.invalid'),
  "contactPerson" = COALESCE(rep.name, c.name),
  "domain"        = CASE
                      WHEN rep.role = 'ORG_ADMIN'
                       AND split_part(rep.email, '@', 2) NOT IN ('', 'gmail.com')
                      THEN lower(split_part(rep.email, '@', 2))
                      ELSE NULL
                    END
FROM (
  SELECT DISTINCT ON ("customerId")
         "customerId", email, name, role
  FROM "User"
  ORDER BY "customerId", (role = 'ORG_ADMIN') DESC, "createdAt" ASC
) rep
WHERE rep."customerId" = c.id;

-- Safety net for any org that has no users at all (keeps NOT NULL satisfiable).
UPDATE "customers"
SET "mailId"        = COALESCE("mailId", 'unknown@' || slug || '.invalid'),
    "contactPerson" = COALESCE("contactPerson", name)
WHERE "mailId" IS NULL OR "contactPerson" IS NULL;

-- contactNumber has no source in the old schema; default to empty string.
UPDATE "customers" SET "contactNumber" = '' WHERE "contactNumber" IS NULL;

-- ── 5. Enforce NOT NULL to match schema.prisma (domain stays nullable) ───────
ALTER TABLE "customers"
  ALTER COLUMN "mailId"        SET NOT NULL,
  ALTER COLUMN "contactPerson" SET NOT NULL,
  ALTER COLUMN "contactNumber" SET NOT NULL;

-- ── 6. Unique index on domain (one org per domain; multiple NULLs allowed) ───
CREATE UNIQUE INDEX "customers_domain_key" ON "customers" ("domain");

COMMIT;

-- ============================================================================
-- VERIFY (run separately after commit; not part of the transaction):
--
--   SELECT name, slug, "mailId", domain FROM customers ORDER BY name;
--   SELECT domain, COUNT(*) FROM customers WHERE domain IS NOT NULL
--     GROUP BY domain HAVING COUNT(*) > 1;            -- expect 0 rows
--   SELECT "customerId" FROM "User" LIMIT 1;          -- column should exist
-- ============================================================================
