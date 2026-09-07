-- ============================================================================
-- b2b_ticket.sql — full 14-table Ticketing Platform schema (TICKET_DATABASE_URL)
-- ----------------------------------------------------------------------------
-- Idempotent DDL mirroring prisma/ticket.prisma (the live, introspected schema
-- of the external ticketing platform; the app's ticket-client expects it).
-- UUID PKs (gen_random_uuid), TIMESTAMPTZ, Sequelize-style "enum_<Table>_<col>"
-- types and PascalCase table names. This same schema also backs the platform
-- Administrators' isolated store when ADMIN_TICKETING_DATABASE_URL is set —
-- which we are NOT provisioning here (it falls back to this database).
--
-- Apply with:  psql -d b2b_ticket -f server/db/b2b_ticket.sql
--
-- NOTE: unlike the older prisma/ticketing-full-schema.sql, this file is
-- non-destructive (no DROP SCHEMA) and re-runnable.
-- ============================================================================

-- gen_random_uuid() is built into PostgreSQL core since v13, so pgcrypto is optional.
-- Try to enable it (for older servers) but DON'T fail the script if the contrib
-- package isn't installed — the UUID defaults work from core regardless.
DO $$ BEGIN
  EXECUTE 'CREATE EXTENSION IF NOT EXISTS pgcrypto';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pgcrypto unavailable; using built-in gen_random_uuid() (PostgreSQL 13+)';
END $$;

-- ─── ENUM types ─────────────────────────────────────────────────────────────
DO $$ BEGIN CREATE TYPE "enum_Users_role"          AS ENUM ('admin','manager','developer','tester');                                        EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "enum_Projects_type"       AS ENUM ('software','marketing','research','other');                                     EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "enum_Projects_priority"   AS ENUM ('low','medium','high');                                                         EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "enum_Tickets_priority"    AS ENUM ('low','medium','high','urgent');                                                EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "enum_Tickets_type"        AS ENUM ('bug','feature','task','story');                                                EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "enum_SLAs_priority"       AS ENUM ('low','medium','high','urgent');                                                EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "enum_SLAs_timeUnit"       AS ENUM ('minutes','hours','days');                                                      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "enum_ProjectMembers_role" AS ENUM ('admin','member','viewer');                                                     EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "enum_Activities_type"     AS ENUM ('created','updated','commented','status_changed','priority_changed','assigned','attachment_added'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- Added after the type already existed on deployed databases, so it cannot go in
-- the CREATE above. ALTER TYPE ... ADD VALUE may NOT run inside a transaction
-- block, which is why this is a bare standalone statement and not wrapped in the
-- DO $$ ... $$ form used everywhere else in this file.
ALTER TYPE "enum_Activities_type" ADD VALUE IF NOT EXISTS 'mentioned';

-- ─── Users ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "Users" (
  "id"                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "firstName"              VARCHAR(255) NOT NULL,
  "lastName"               VARCHAR(255) NOT NULL,
  "email"                  VARCHAR(255) NOT NULL,
  "password"               VARCHAR(255) NOT NULL,
  "role"                   "enum_Users_role" NOT NULL DEFAULT 'developer',
  "isActive"               BOOLEAN NOT NULL DEFAULT true,
  "avatar"                 VARCHAR(255),
  "lastLogin"              TIMESTAMPTZ,
  "ticketApiKeyHash"       VARCHAR(255),
  "ticketApiKeyEnabled"    BOOLEAN NOT NULL DEFAULT false,
  "ticketApiKeyCreatedAt"  TIMESTAMPTZ,
  "ticketApiKeyLastUsedAt" TIMESTAMPTZ,
  "createdAt"              TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "Users_email_key" ON "Users" ("email");

-- ─── Customers ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "Customers" (
  "id"            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "name"          VARCHAR(255) NOT NULL,
  "contactPerson" VARCHAR(255),
  "email"         VARCHAR(255),
  "phone"         VARCHAR(255),
  "company"       VARCHAR(255),
  "address"       TEXT,
  "password"      VARCHAR(255),
  "createdAt"     TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── SLAs ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "SLAs" (
  "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "name"           VARCHAR(255) NOT NULL,
  "description"    TEXT,
  "priority"       "enum_SLAs_priority",
  "responseTime"   INTEGER NOT NULL,
  "resolutionTime" INTEGER NOT NULL,
  "timeUnit"       "enum_SLAs_timeUnit" NOT NULL DEFAULT 'hours',
  "businessHours"  JSONB,
  "workingDays"    INTEGER[] NOT NULL DEFAULT ARRAY[1,2,3,4,5],
  "isActive"       BOOLEAN NOT NULL DEFAULT true,
  "createdAt"      TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Organizations (config) ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "Organizations" (
  "id"        SERIAL PRIMARY KEY,
  "name"      VARCHAR(255),
  "domain"    VARCHAR(255),
  "logo"      VARCHAR(255),
  "address"   TEXT,
  "phone"     VARCHAR(255),
  "email"     VARCHAR(255),
  "website"   VARCHAR(255),
  "appName"   VARCHAR(255) NOT NULL DEFAULT 'Ticketing',
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Roles (config) ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "Roles" (
  "id"          SERIAL PRIMARY KEY,
  "name"        VARCHAR(255) NOT NULL,
  "permissions" JSON NOT NULL DEFAULT '[]',
  "description" TEXT,
  "isActive"    BOOLEAN NOT NULL DEFAULT true,
  "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "Roles_name_key" ON "Roles" ("name");

-- ─── EmailIntegrations (config) ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "EmailIntegrations" (
  "id"          SERIAL PRIMARY KEY,
  "smtpHost"    VARCHAR(255) NOT NULL,
  "smtpPort"    INTEGER NOT NULL,
  "username"    VARCHAR(255) NOT NULL,
  "password"    VARCHAR(255) NOT NULL,
  "senderEmail" VARCHAR(255) NOT NULL,
  "senderName"  VARCHAR(255) NOT NULL,
  "secure"      BOOLEAN NOT NULL DEFAULT false,
  "isActive"    BOOLEAN NOT NULL DEFAULT true,
  "lastTested"  TIMESTAMPTZ,
  "lastError"   TEXT,
  "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Projects ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "Projects" (
  "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "name"        VARCHAR(255) NOT NULL,
  "description" TEXT,
  "status"      VARCHAR(255) NOT NULL DEFAULT 'active',
  "category"    VARCHAR(255) NOT NULL,
  "type"        "enum_Projects_type"     NOT NULL DEFAULT 'software',
  "priority"    "enum_Projects_priority" NOT NULL DEFAULT 'medium',
  "startDate"   TIMESTAMPTZ,
  "endDate"     TIMESTAMPTZ,
  "leadId"      UUID NOT NULL REFERENCES "Users" ("id"),
  "settings"    JSONB,
  "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Tickets ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "Tickets" (
  "id"                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "ticketNumber"          VARCHAR(255) NOT NULL,
  "title"                 VARCHAR(255) NOT NULL,
  "description"           TEXT NOT NULL,
  "status"                VARCHAR(255) NOT NULL DEFAULT 'todo',
  "priority"              "enum_Tickets_priority" NOT NULL DEFAULT 'medium',
  "type"                  "enum_Tickets_type"     NOT NULL DEFAULT 'task',
  "projectId"             UUID NOT NULL REFERENCES "Projects" ("id"),
  "reporterId"            UUID NOT NULL REFERENCES "Users" ("id"),
  "assigneeId"            UUID REFERENCES "Users" ("id"),
  "customerId"            UUID REFERENCES "Customers" ("id"),
  "storyPoints"           INTEGER,
  "dueDate"               TIMESTAMPTZ,
  "labels"                VARCHAR(255)[] NOT NULL DEFAULT ARRAY[]::VARCHAR(255)[],
  "SLAId"                 UUID REFERENCES "SLAs" ("id"),
  "pausedTime"            TIMESTAMPTZ,
  "totalPausedTime"       INTEGER NOT NULL DEFAULT 0,
  "createdBy"             UUID NOT NULL REFERENCES "Users" ("id"),
  "reasonForDelay"        TEXT,
  "branch"                VARCHAR(255),
  "onSiteSupportRequired" BOOLEAN NOT NULL DEFAULT false,
  "resolvedMethods"       TEXT,
  "createdAt"             TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "Tickets_ticketNumber_key" ON "Tickets" ("ticketNumber");
CREATE INDEX IF NOT EXISTS "Tickets_SLAId_idx"      ON "Tickets" ("SLAId");
CREATE INDEX IF NOT EXISTS "Tickets_assigneeId_idx" ON "Tickets" ("assigneeId");
CREATE INDEX IF NOT EXISTS "Tickets_customerId_idx" ON "Tickets" ("customerId");
CREATE INDEX IF NOT EXISTS "Tickets_priority_idx"   ON "Tickets" ("priority");
CREATE INDEX IF NOT EXISTS "Tickets_projectId_idx"  ON "Tickets" ("projectId");
CREATE INDEX IF NOT EXISTS "Tickets_reporterId_idx" ON "Tickets" ("reporterId");
CREATE INDEX IF NOT EXISTS "Tickets_status_idx"     ON "Tickets" ("status");

-- ─── ProjectMembers (User ↔ Project) ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "ProjectMembers" (
  "id"        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "projectId" UUID NOT NULL REFERENCES "Projects" ("id") ON DELETE CASCADE,
  "userId"    UUID NOT NULL REFERENCES "Users" ("id") ON DELETE CASCADE,
  "role"      "enum_ProjectMembers_role" NOT NULL DEFAULT 'member',
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "ProjectMembers_projectId_userId_uk" ON "ProjectMembers" ("projectId", "userId");

-- ─── TicketWatchers (User ↔ Ticket) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "TicketWatchers" (
  "id"        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "ticketId"  UUID NOT NULL REFERENCES "Tickets" ("id") ON DELETE CASCADE,
  "userId"    UUID NOT NULL REFERENCES "Users" ("id") ON DELETE CASCADE,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "TicketWatchers_ticketId_userId_uk" ON "TicketWatchers" ("ticketId", "userId");

-- ─── Comments ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "Comments" (
  "id"        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "content"   TEXT NOT NULL,
  "userId"    UUID NOT NULL REFERENCES "Users" ("id"),
  "ticketId"  UUID NOT NULL REFERENCES "Tickets" ("id") ON DELETE CASCADE,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "Comments_ticketId_idx" ON "Comments" ("ticketId");
CREATE INDEX IF NOT EXISTS "Comments_userId_idx"   ON "Comments" ("userId");

-- ─── CommentAttachments ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "CommentAttachments" (
  "id"           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "commentId"    UUID NOT NULL REFERENCES "Comments" ("id") ON DELETE CASCADE,
  "filename"     VARCHAR(255),
  "originalName" VARCHAR(255),
  "mimeType"     VARCHAR(255),
  "size"         INTEGER,
  "path"         VARCHAR(255),
  "uploadedBy"   UUID REFERENCES "Users" ("id"),
  "createdAt"    TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "CommentAttachments_commentId_idx" ON "CommentAttachments" ("commentId");

-- ─── TicketAttachments ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "TicketAttachments" (
  "id"           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "ticketId"     UUID NOT NULL REFERENCES "Tickets" ("id") ON DELETE CASCADE,
  "filename"     VARCHAR(255),
  "originalName" VARCHAR(255),
  "mimeType"     VARCHAR(255),
  "size"         INTEGER,
  "path"         VARCHAR(255),
  "uploadedBy"   UUID REFERENCES "Users" ("id"),
  "createdAt"    TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "TicketAttachments_ticketId_idx"   ON "TicketAttachments" ("ticketId");
CREATE INDEX IF NOT EXISTS "TicketAttachments_uploadedBy_idx" ON "TicketAttachments" ("uploadedBy");

-- ─── Activities (audit log) ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "Activities" (
  "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "type"        "enum_Activities_type" NOT NULL,
  "field"       VARCHAR(255),
  "oldValue"    JSONB,
  "newValue"    JSONB,
  "description" TEXT,
  "ticketId"    UUID NOT NULL REFERENCES "Tickets" ("id") ON DELETE CASCADE,
  "userId"      UUID NOT NULL REFERENCES "Users" ("id"),
  "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "Activities_ticketId_idx" ON "Activities" ("ticketId");
CREATE INDEX IF NOT EXISTS "Activities_userId_idx"   ON "Activities" ("userId");
