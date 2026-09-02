-- ============================================================================
-- b2b.sql — main platform database (DATABASE_URL)
-- ----------------------------------------------------------------------------
-- Idempotent DDL: safe to re-run against a populated database. Mirrors
-- prisma/schema.prisma exactly (table names honour @@map; the rest keep the
-- PascalCase model name). All datetime columns are TIMESTAMPTZ so JS Date
-- comparisons via node-postgres are timezone-correct regardless of the DB
-- session TimeZone (fixes the announcements expiresAt skew).
--
-- Apply with:  psql -d b2b -f server/db/b2b.sql
--
-- `id` columns are TEXT with NO default — cuids are generated in the app
-- (Prisma @default(cuid()) and db.ts newId() are both client-side).
-- ============================================================================

-- ─── ENUM types ─────────────────────────────────────────────────────────────
DO $$ BEGIN CREATE TYPE "Role"              AS ENUM ('USER','ORG_ADMIN','ADMINISTRATOR');                         EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "Plan"              AS ENUM ('FREE','PRO','ENTERPRISE');                                   EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "ServiceStatus"     AS ENUM ('ACTIVE','EXPIRING','EXPIRED','SUSPENDED');                   EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "RequestType"       AS ENUM ('SUPPORT','INCIDENT','FEATURE_REQUEST','ONBOARDING','BILLING'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "RequestStatus"     AS ENUM ('OPEN','IN_PROGRESS','RESOLVED','CLOSED','ESCALATED');        EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "Priority"          AS ENUM ('CRITICAL','HIGH','MEDIUM','LOW');                            EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "AnnouncementLevel" AS ENUM ('INFO','WARNING','CRITICAL');                                EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "EscalationStatus"  AS ENUM ('OPEN','ACKNOWLEDGED','RESOLVED');                           EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "SlackBotStatus"    AS ENUM ('CONNECTED','DISCONNECTED','ERROR');                         EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "BotFieldType"      AS ENUM ('TEXT','TEXTAREA','NUMBER','SELECT','CHECKBOX','USER_EMAIL'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "AdSecretStatus"    AS ENUM ('PENDING','DELIVERED','VIEWED','EXPIRED');                    EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── customers (Customer) ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "customers" (
  "id"            TEXT PRIMARY KEY,
  "name"          TEXT    NOT NULL,
  "slug"          TEXT    NOT NULL,
  "plan"          "Plan"  NOT NULL DEFAULT 'FREE',
  "suspended"     BOOLEAN NOT NULL DEFAULT false,
  "ssoEnabled"    BOOLEAN NOT NULL DEFAULT false,
  "mfaRequired"   BOOLEAN NOT NULL DEFAULT false,
  "creditLimit"   INTEGER NOT NULL DEFAULT 1000,
  "mailId"        TEXT    NOT NULL,
  "contactPerson" TEXT    NOT NULL,
  "contactNumber" TEXT    NOT NULL,
  "domain"        TEXT,
  "orgCode"       TEXT,
  "industry"      TEXT,
  "contractValue" INTEGER NOT NULL DEFAULT 0,
  "healthScore"   INTEGER NOT NULL DEFAULT 100,
  "csm"           TEXT,
  "createdAt"     TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "customers_slug_key"    ON "customers" ("slug");
CREATE UNIQUE INDEX IF NOT EXISTS "customers_domain_key"  ON "customers" ("domain");
CREATE UNIQUE INDEX IF NOT EXISTS "customers_orgCode_key" ON "customers" ("orgCode");

-- ─── TicketNumberSetting ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "TicketNumberSetting" (
  "id"             TEXT PRIMARY KEY DEFAULT 'default',
  "prefix"         TEXT    NOT NULL DEFAULT 'TKT',
  "includeOrgCode" BOOLEAN NOT NULL DEFAULT false,
  "separator"      TEXT    NOT NULL DEFAULT '-',
  "padWidth"       INTEGER NOT NULL DEFAULT 3,
  "updatedById"    TEXT,
  "updatedAt"      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── PlatformRole ────────────────────────────────────────────────────────────
-- Vendor-staff roles. Declared BEFORE "User" because User.platformRoleId
-- references it. `permissions` is a jsonb string[] of keys from
-- src/config/permissions.ts.
CREATE TABLE IF NOT EXISTS "PlatformRole" (
  "id"          TEXT PRIMARY KEY,
  "key"         TEXT    NOT NULL,
  "name"        TEXT    NOT NULL,
  "description" TEXT,
  "system"      BOOLEAN NOT NULL DEFAULT false,
  "permissions" JSONB   NOT NULL DEFAULT '[]'::jsonb,
  "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "PlatformRole_key_key" ON "PlatformRole" ("key");

-- The four seeded roles.
--
-- ON CONFLICT DO NOTHING is load-bearing: provision.sh is re-run on every deploy,
-- and a DO UPDATE here would silently revert whatever an administrator has since
-- changed in the roles matrix. Editing a seeded role's defaults in this file
-- therefore only affects FRESH installs — that is intended.
--
-- 'administration' is seeded with an EMPTY array on purpose. Its permissions are
-- never read from this column; platformRoles.service returns the whole registry
-- for it. That is what makes the role impossible to strip and what makes every
-- newly-shipped key automatically held by administrators.
INSERT INTO "PlatformRole" ("id","key","name","description","system","permissions") VALUES
  ('plr_administration','administration','Administration',
   'Full access to every platform feature.', true, '[]'::jsonb),

  ('plr_hr_admin','hr_admin','HR Admin',
   'Business operations: organizations, users, services and the catalog.', true,
   '["nav.control_plane","catalog.manage","customer_services.manage","orgs.manage",
     "platform_audit.view","revenue.view","users.manage","staff.invite","roles.manage",
     "services.view","nav.chat","tickets.view","tickets.write","ticket.store.admin"]'::jsonb),

  ('plr_employee','employee','Employee',
   'Support staff: the internal ticket queue, credentials and Slack bots.', true,
   '["nav.chat","tickets.view","tickets.write","ticket.store.admin",
     "credentials.view","credentials.reveal","bots.view","bots.manage"]'::jsonb),

  ('plr_intern','intern','Intern',
   'Same surfaces as Employee, read-only: no ticket edits, no secret reveal, no bot changes.', true,
   '["nav.chat","tickets.view","ticket.store.admin","credentials.view","bots.view"]'::jsonb)
ON CONFLICT ("key") DO NOTHING;

-- Additive grants for keys introduced AFTER a role row already existed. The
-- INSERT above is ON CONFLICT DO NOTHING, so it only shapes fresh installs —
-- an upgraded database keeps whatever its hr_admin row already had, and would
-- otherwise never receive a newly-shipped key.
--
-- Idempotent and non-destructive: appends only when absent, and touches nothing
-- an administrator has changed in the roles matrix. `administration` needs no
-- entry here — its permissions are computed, never stored.
UPDATE "PlatformRole"
   SET "permissions" = "permissions" || '["revenue.view"]'::jsonb
 WHERE "key" = 'hr_admin'
   AND NOT ("permissions" @> '["revenue.view"]'::jsonb);

-- ─── User ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "User" (
  "id"           TEXT PRIMARY KEY,
  "email"        TEXT    NOT NULL,
  "passwordHash" TEXT    NOT NULL,
  -- HMAC-SHA256(PASSWORD_PEPPER, password): lets us detect/block the SAME password being
  -- used by more than one account. bcrypt salts randomly, so passwordHash can't reveal that.
  -- Nullable: only written when the plaintext passes through (register/change/reset).
  "passwordFingerprint" TEXT,
  "name"         TEXT    NOT NULL,
  "role"         "Role"  NOT NULL DEFAULT 'USER',
  "mfaEnabled"   BOOLEAN NOT NULL DEFAULT false,
  "lastLoginAt"  TIMESTAMPTZ,
  "createdAt"    TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"    TIMESTAMPTZ NOT NULL DEFAULT now(),
  "customerId"   TEXT    NOT NULL REFERENCES "customers" ("id") ON DELETE CASCADE
);
-- CREATE TABLE IF NOT EXISTS above is a no-op on databases that already have "User",
-- so add the column separately for existing installs (no-op when already present).
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "passwordFingerprint" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "User_email_key"        ON "User" ("email");
CREATE INDEX        IF NOT EXISTS "User_customerId_idx"   ON "User" ("customerId");
CREATE INDEX        IF NOT EXISTS "User_passwordFingerprint_idx" ON "User" ("passwordFingerprint");

-- ─── User: platform role (IAM) ───────────────────────────────────────────────
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "platformRoleId" TEXT
  REFERENCES "PlatformRole" ("id");
CREATE INDEX IF NOT EXISTS "User_platformRoleId_idx" ON "User" ("platformRoleId");

-- Every pre-existing ADMINISTRATOR becomes Administration, so nobody loses access
-- on deploy. Idempotent, and it is ALSO the guard that stops the first-user
-- bootstrap in auth.service from ever firing on an upgraded database.
UPDATE "User" SET "platformRoleId" = 'plr_administration'
  WHERE "role" = 'ADMINISTRATOR' AND "platformRoleId" IS NULL;

-- role=ADMINISTRATOR with no platform role is an invalid state: it would mean
-- "vendor staff with no permission set". NOT VALID skips a scan of existing rows
-- (the UPDATE above just fixed them all) while still enforcing on every write.
DO $$ BEGIN
  ALTER TABLE "User" ADD CONSTRAINT "User_platform_role_ck"
    CHECK (("role" <> 'ADMINISTRATOR') OR ("platformRoleId" IS NOT NULL)) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── User: email verification ────────────────────────────────────────────────
-- ⚠ The backfill MUST run ONLY when the column is first added. The obvious
-- unconditional form —
--     UPDATE "User" SET "emailVerifiedAt" = now() WHERE "emailVerifiedAt" IS NULL
-- — would silently verify every pending signup on the NEXT provision.sh run,
-- defeating the whole feature. Hence the information_schema guard.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'User' AND column_name = 'emailVerifiedAt') THEN
    ALTER TABLE "User" ADD COLUMN "emailVerifiedAt" TIMESTAMPTZ;
    -- Grandfather every account that existed before verification was introduced.
    UPDATE "User" SET "emailVerifiedAt" = "createdAt";
  END IF;
END $$;

-- ─── PushSubscription ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "PushSubscription" (
  "id"         TEXT PRIMARY KEY,
  "endpoint"   TEXT NOT NULL,
  "p256dh"     TEXT NOT NULL,
  "auth"       TEXT NOT NULL,
  "userId"     TEXT NOT NULL REFERENCES "User" ("id") ON DELETE CASCADE,
  "tenantId"   TEXT NOT NULL,
  "userAgent"  TEXT,
  "createdAt"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  "lastUsedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "PushSubscription_endpoint_key" ON "PushSubscription" ("endpoint");
CREATE INDEX        IF NOT EXISTS "PushSubscription_userId_idx"   ON "PushSubscription" ("userId");
CREATE INDEX        IF NOT EXISTS "PushSubscription_tenantId_idx" ON "PushSubscription" ("tenantId");

-- ─── RefreshToken ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "RefreshToken" (
  "id"         TEXT PRIMARY KEY,
  "tokenHash"  TEXT NOT NULL,
  "userId"     TEXT NOT NULL REFERENCES "User" ("id") ON DELETE CASCADE,
  "sessionId"  TEXT NOT NULL,
  "lastUsedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "expiresAt"  TIMESTAMPTZ NOT NULL,
  "createdAt"  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "RefreshToken_tokenHash_key" ON "RefreshToken" ("tokenHash");
CREATE INDEX        IF NOT EXISTS "RefreshToken_userId_idx"    ON "RefreshToken" ("userId");
CREATE INDEX        IF NOT EXISTS "RefreshToken_tokenHash_idx" ON "RefreshToken" ("tokenHash");
CREATE INDEX        IF NOT EXISTS "RefreshToken_sessionId_idx" ON "RefreshToken" ("sessionId");

-- ─── PasswordResetToken ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "PasswordResetToken" (
  "id"        TEXT PRIMARY KEY,
  "tokenHash" TEXT NOT NULL,
  "userId"    TEXT NOT NULL REFERENCES "User" ("id") ON DELETE CASCADE,
  "expiresAt" TIMESTAMPTZ NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "PasswordResetToken_tokenHash_key" ON "PasswordResetToken" ("tokenHash");
CREATE INDEX        IF NOT EXISTS "PasswordResetToken_userId_idx"    ON "PasswordResetToken" ("userId");

-- ─── EmailVerificationToken ──────────────────────────────────────────────────
-- Proof-of-ownership token emailed at signup. SHA-256 rather than bcrypt (unlike
-- PasswordResetToken): the token is 32 CSPRNG bytes, so a KDF adds nothing and
-- bcrypt would force the same scan-every-row compare loop.
CREATE TABLE IF NOT EXISTS "EmailVerificationToken" (
  "id"         TEXT PRIMARY KEY,
  "tokenHash"  TEXT NOT NULL,
  "userId"     TEXT NOT NULL REFERENCES "User" ("id") ON DELETE CASCADE,
  "expiresAt"  TIMESTAMPTZ NOT NULL,
  "lastSentAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "createdAt"  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "EmailVerificationToken_tokenHash_key" ON "EmailVerificationToken" ("tokenHash");
CREATE INDEX        IF NOT EXISTS "EmailVerificationToken_userId_idx"    ON "EmailVerificationToken" ("userId");

-- ─── EmailMfaChallenge ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "EmailMfaChallenge" (
  "id"         TEXT PRIMARY KEY,
  "userId"     TEXT NOT NULL REFERENCES "User" ("id") ON DELETE CASCADE,
  "codeHash"   TEXT NOT NULL,
  "attempts"   INTEGER NOT NULL DEFAULT 0,
  "expiresAt"  TIMESTAMPTZ NOT NULL,
  "lastSentAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "consumedAt" TIMESTAMPTZ,
  "createdAt"  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "EmailMfaChallenge_userId_idx" ON "EmailMfaChallenge" ("userId");

-- ─── TrustedDevice ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "TrustedDevice" (
  "id"         TEXT PRIMARY KEY,
  "userId"     TEXT NOT NULL REFERENCES "User" ("id") ON DELETE CASCADE,
  "tokenHash"  TEXT NOT NULL,
  "expiresAt"  TIMESTAMPTZ NOT NULL,
  "createdAt"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  "lastUsedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "TrustedDevice_userId_idx" ON "TrustedDevice" ("userId");

-- ─── AuditLog ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "AuditLog" (
  "id"            TEXT PRIMARY KEY,
  "action"        TEXT NOT NULL,
  "performedById" TEXT REFERENCES "User" ("id") ON DELETE SET NULL,
  "targetId"      TEXT,
  "metadata"      JSONB,
  "createdAt"     TIMESTAMPTZ NOT NULL DEFAULT now(),
  "customerId"    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS "AuditLog_customerId_idx"    ON "AuditLog" ("customerId");
CREATE INDEX IF NOT EXISTS "AuditLog_performedById_idx" ON "AuditLog" ("performedById");
CREATE INDEX IF NOT EXISTS "AuditLog_createdAt_idx"     ON "AuditLog" ("createdAt");

-- ─── FeatureFlag ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "FeatureFlag" (
  "id"          TEXT PRIMARY KEY,
  "key"         TEXT    NOT NULL,
  "value"       BOOLEAN NOT NULL DEFAULT false,
  "description" TEXT,
  "updatedAt"   TIMESTAMPTZ NOT NULL DEFAULT now(),
  "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "FeatureFlag_key_key" ON "FeatureFlag" ("key");

-- ─── OrgFeatureFlag ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "OrgFeatureFlag" (
  "id"         TEXT PRIMARY KEY,
  "customerId" TEXT    NOT NULL REFERENCES "customers" ("id") ON DELETE CASCADE,
  "key"        TEXT    NOT NULL,
  "value"      BOOLEAN NOT NULL DEFAULT false,
  "updatedAt"  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "OrgFeatureFlag_customerId_key_key" ON "OrgFeatureFlag" ("customerId", "key");
CREATE INDEX        IF NOT EXISTS "OrgFeatureFlag_customerId_idx"     ON "OrgFeatureFlag" ("customerId");

-- ─── ServiceRequest ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "ServiceRequest" (
  "id"                TEXT PRIMARY KEY,
  "customerId"        TEXT NOT NULL REFERENCES "customers" ("id") ON DELETE CASCADE,
  "createdById"       TEXT REFERENCES "User" ("id") ON DELETE SET NULL,
  "type"              "RequestType"   NOT NULL DEFAULT 'SUPPORT',
  "status"            "RequestStatus" NOT NULL DEFAULT 'OPEN',
  "priority"          "Priority"      NOT NULL DEFAULT 'MEDIUM',
  "subject"           TEXT NOT NULL,
  "description"       TEXT,
  "service"           TEXT,
  "assignedTo"        TEXT,
  "internalNotes"     TEXT,
  "externalId"        TEXT,
  "externalSyncedAt"  TIMESTAMPTZ,
  "externalSyncError" TEXT,
  "createdAt"         TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"         TIMESTAMPTZ NOT NULL DEFAULT now(),
  "resolvedAt"        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS "ServiceRequest_customerId_idx"  ON "ServiceRequest" ("customerId");
CREATE INDEX IF NOT EXISTS "ServiceRequest_createdById_idx" ON "ServiceRequest" ("createdById");
CREATE INDEX IF NOT EXISTS "ServiceRequest_status_idx"      ON "ServiceRequest" ("status");
CREATE INDEX IF NOT EXISTS "ServiceRequest_priority_idx"    ON "ServiceRequest" ("priority");
CREATE INDEX IF NOT EXISTS "ServiceRequest_createdAt_idx"   ON "ServiceRequest" ("createdAt");

-- ─── TicketEscalation ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "TicketEscalation" (
  "id"            TEXT PRIMARY KEY,
  "customerId"    TEXT NOT NULL REFERENCES "customers" ("id") ON DELETE CASCADE,
  "ticketId"      TEXT NOT NULL,
  "subject"       TEXT NOT NULL,
  "issueType"     TEXT NOT NULL,
  "priority"      "Priority"         NOT NULL DEFAULT 'MEDIUM',
  "note"          TEXT,
  "status"        "EscalationStatus" NOT NULL DEFAULT 'OPEN',
  "escalatedById" TEXT REFERENCES "User" ("id") ON DELETE SET NULL,
  "createdAt"     TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "TicketEscalation_customerId_ticketId_key" ON "TicketEscalation" ("customerId", "ticketId");
CREATE INDEX        IF NOT EXISTS "TicketEscalation_customerId_idx"          ON "TicketEscalation" ("customerId");
CREATE INDEX        IF NOT EXISTS "TicketEscalation_status_idx"              ON "TicketEscalation" ("status");
CREATE INDEX        IF NOT EXISTS "TicketEscalation_createdAt_idx"           ON "TicketEscalation" ("createdAt");

-- ─── Announcement ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "Announcement" (
  "id"          TEXT PRIMARY KEY,
  "title"       TEXT NOT NULL,
  "message"     TEXT NOT NULL,
  "level"       "AnnouncementLevel" NOT NULL DEFAULT 'INFO',
  "customerId"  TEXT REFERENCES "customers" ("id") ON DELETE CASCADE,
  "active"      BOOLEAN NOT NULL DEFAULT true,
  "expiresAt"   TIMESTAMPTZ,
  "createdById" TEXT REFERENCES "User" ("id") ON DELETE SET NULL,
  "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "Announcement_customerId_idx" ON "Announcement" ("customerId");
CREATE INDEX IF NOT EXISTS "Announcement_active_idx"     ON "Announcement" ("active");

-- ─── serviceCatalog (ServiceCatalog) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "serviceCatalog" (
  "id"          TEXT PRIMARY KEY,
  "name"        TEXT NOT NULL,
  "description" TEXT,
  "category"    TEXT,
  "basePrice"   INTEGER NOT NULL DEFAULT 0,
  "enabled"     BOOLEAN NOT NULL DEFAULT true,
  "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "serviceCatalog_enabled_idx" ON "serviceCatalog" ("enabled");

-- ─── customerServices (CustomerService) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS "customerServices" (
  "id"           TEXT PRIMARY KEY,
  "customerId"   TEXT NOT NULL REFERENCES "customers" ("id") ON DELETE CASCADE,
  "name"         TEXT NOT NULL,
  "description"  TEXT,
  "monthlyPrice" INTEGER NOT NULL DEFAULT 0,
  "purchaseDate" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "endDate"      TIMESTAMPTZ NOT NULL,
  "notes"        TEXT,
  "createdAt"    TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "customerServices_customerId_idx" ON "customerServices" ("customerId");
CREATE INDEX IF NOT EXISTS "customerServices_endDate_idx"    ON "customerServices" ("endDate");

-- ─── slackBots (SlackBot) ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "slackBots" (
  "id"            TEXT PRIMARY KEY,
  "name"          TEXT NOT NULL,
  "slug"          TEXT NOT NULL,
  "description"   TEXT,
  "botTokenEnc"   TEXT NOT NULL,
  "appTokenEnc"   TEXT,
  "webhookUrlEnc" TEXT,
  "apiKeyHash"    TEXT,
  "apiKeyHint"    TEXT,
  "botUserId"     TEXT,
  "teamName"      TEXT,
  "status"        "SlackBotStatus" NOT NULL DEFAULT 'DISCONNECTED',
  "lastError"     TEXT,
  "lastCheckedAt" TIMESTAMPTZ,
  "ticketUserId"  TEXT,
  "enabled"       BOOLEAN NOT NULL DEFAULT true,
  "createdAt"     TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "slackBots_slug_key" ON "slackBots" ("slug");

-- ─── slackBotFormFields (SlackBotFormField) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS "slackBotFormFields" (
  "id"          TEXT PRIMARY KEY,
  "botId"       TEXT NOT NULL REFERENCES "slackBots" ("id") ON DELETE CASCADE,
  "key"         TEXT NOT NULL,
  "label"       TEXT NOT NULL,
  "type"        "BotFieldType" NOT NULL DEFAULT 'TEXT',
  "required"    BOOLEAN NOT NULL DEFAULT false,
  "options"     JSONB,
  "placeholder" TEXT,
  "helpText"    TEXT,
  "order"       INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS "slackBotFormFields_botId_key_key" ON "slackBotFormFields" ("botId", "key");
CREATE INDEX        IF NOT EXISTS "slackBotFormFields_botId_idx"     ON "slackBotFormFields" ("botId");

-- ─── slackBotOrgs (SlackBotOrg) ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "slackBotOrgs" (
  "id"         TEXT PRIMARY KEY,
  "botId"      TEXT NOT NULL REFERENCES "slackBots" ("id") ON DELETE CASCADE,
  "customerId" TEXT NOT NULL,
  "createdAt"  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "slackBotOrgs_botId_customerId_key" ON "slackBotOrgs" ("botId", "customerId");
CREATE INDEX        IF NOT EXISTS "slackBotOrgs_customerId_idx"       ON "slackBotOrgs" ("customerId");

-- ─── botTicketSubmissions (BotTicketSubmission) ──────────────────────────────
CREATE TABLE IF NOT EXISTS "botTicketSubmissions" (
  "id"           TEXT PRIMARY KEY,
  "botId"        TEXT NOT NULL,
  "customerId"   TEXT NOT NULL,
  "ticketId"     TEXT NOT NULL,
  "ticketNumber" TEXT NOT NULL,
  "values"       JSONB NOT NULL,
  "createdById"  TEXT NOT NULL,
  "createdAt"    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "botTicketSubmissions_customerId_idx" ON "botTicketSubmissions" ("customerId");
CREATE INDEX IF NOT EXISTS "botTicketSubmissions_botId_idx"      ON "botTicketSubmissions" ("botId");

-- ─── adCredentialDeliveries (AdCredentialDelivery) ───────────────────────────
CREATE TABLE IF NOT EXISTS "adCredentialDeliveries" (
  "id"                TEXT PRIMARY KEY,
  "botId"             TEXT NOT NULL,
  "customerId"        TEXT NOT NULL,
  "ticketId"          TEXT NOT NULL,
  "ticketNumber"      TEXT NOT NULL,
  "targetUserId"      TEXT,
  "targetEmail"       TEXT NOT NULL,
  "requestedById"     TEXT NOT NULL,
  "secretEnc"         TEXT,
  "status"            "AdSecretStatus" NOT NULL DEFAULT 'DELIVERED',
  "viewedByTarget"    BOOLEAN NOT NULL DEFAULT false,
  "viewedByRequester" BOOLEAN NOT NULL DEFAULT false,
  "expiresAt"         TIMESTAMPTZ NOT NULL,
  "deliveredAt"       TIMESTAMPTZ NOT NULL DEFAULT now(),
  "viewedAt"          TIMESTAMPTZ,
  "createdAt"         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "adCredentialDeliveries_botId_ticketNumber_key" ON "adCredentialDeliveries" ("botId", "ticketNumber");
CREATE INDEX        IF NOT EXISTS "adCredentialDeliveries_customerId_idx"    ON "adCredentialDeliveries" ("customerId");
CREATE INDEX        IF NOT EXISTS "adCredentialDeliveries_targetUserId_idx"  ON "adCredentialDeliveries" ("targetUserId");
CREATE INDEX        IF NOT EXISTS "adCredentialDeliveries_requestedById_idx" ON "adCredentialDeliveries" ("requestedById");
