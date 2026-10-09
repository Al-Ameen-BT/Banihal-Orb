-- ============================================================================
-- b2b_ticketing — full Ticketing system schema (Sequelize-compatible)
-- ----------------------------------------------------------------------------
-- Recreates the b2b_ticketing database to match the real Ticketing tool's
-- Sequelize models (server/models/). Identifiers are quoted to preserve the
-- PascalCase table names and camelCase columns Sequelize generates, and ENUM
-- types follow Sequelize's "enum_<Table>_<column>" naming so the real app can
-- be pointed at this database directly.
--
-- DESTRUCTIVE: drops everything in the `public` schema first (clean rebuild).
-- Apply with:
--   cd server && npx prisma db execute --file prisma/ticketing-full-schema.sql \
--       --schema prisma/ticketing.prisma
-- (uses TICKETING_DATABASE_URL → b2b_ticketing)
-- ============================================================================

DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()

-- ─── ENUM types ─────────────────────────────────────────────────────────────
CREATE TYPE "enum_Users_role"            AS ENUM ('admin', 'manager', 'developer', 'tester');
CREATE TYPE "enum_Projects_type"         AS ENUM ('software', 'marketing', 'research', 'other');
CREATE TYPE "enum_Projects_priority"     AS ENUM ('low', 'medium', 'high');
CREATE TYPE "enum_Tickets_priority"      AS ENUM ('low', 'medium', 'high', 'urgent');
CREATE TYPE "enum_Tickets_type"          AS ENUM ('bug', 'feature', 'task', 'story');
CREATE TYPE "enum_SLAs_priority"         AS ENUM ('low', 'medium', 'high', 'urgent');
CREATE TYPE "enum_SLAs_timeUnit"         AS ENUM ('minutes', 'hours', 'days');
CREATE TYPE "enum_ProjectMembers_role"   AS ENUM ('admin', 'member', 'viewer');
CREATE TYPE "enum_Activities_type"       AS ENUM (
  'created', 'updated', 'commented', 'status_changed',
  'priority_changed', 'assigned', 'attachment_added'
);

-- ─── Users ──────────────────────────────────────────────────────────────────
CREATE TABLE "Users" (
  "id"                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "firstName"                VARCHAR(255) NOT NULL,
  "lastName"                 VARCHAR(255) NOT NULL,
  "email"                    VARCHAR(255) NOT NULL UNIQUE,
  "password"                 VARCHAR(255) NOT NULL,
  "role"                     "enum_Users_role" NOT NULL DEFAULT 'developer',
  "isActive"                 BOOLEAN NOT NULL DEFAULT TRUE,
  "avatar"                   VARCHAR(255),
  "lastLogin"                TIMESTAMPTZ,
  "ticketApiKeyHash"         VARCHAR(255),
  "ticketApiKeyEnabled"      BOOLEAN NOT NULL DEFAULT FALSE,
  "ticketApiKeyCreatedAt"    TIMESTAMPTZ,
  "ticketApiKeyLastUsedAt"   TIMESTAMPTZ,
  "createdAt"                TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"                TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Customers ──────────────────────────────────────────────────────────────
CREATE TABLE "Customers" (
  "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "name"           VARCHAR(255) NOT NULL,
  "contactPerson"  VARCHAR(255),
  "email"          VARCHAR(255),
  "phone"          VARCHAR(255),
  "company"        VARCHAR(255),
  "address"        TEXT,
  "password"       VARCHAR(255),               -- bcrypt-hashed, for client login
  "createdAt"      TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── SLAs ───────────────────────────────────────────────────────────────────
CREATE TABLE "SLAs" (
  "id"              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "name"            VARCHAR(255) NOT NULL,
  "description"     TEXT,
  "priority"        "enum_SLAs_priority",
  "responseTime"    INTEGER NOT NULL CHECK ("responseTime" >= 1),
  "resolutionTime"  INTEGER NOT NULL CHECK ("resolutionTime" >= 1),
  "timeUnit"        "enum_SLAs_timeUnit" NOT NULL DEFAULT 'hours',
  "businessHours"   JSONB,                      -- { start, end }
  "workingDays"     INTEGER[] NOT NULL DEFAULT ARRAY[1,2,3,4,5],
  "isActive"        BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt"       TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Projects ───────────────────────────────────────────────────────────────
CREATE TABLE "Projects" (
  "id"           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "name"         VARCHAR(255) NOT NULL,
  "description"  TEXT,
  "status"       VARCHAR(255) NOT NULL DEFAULT 'active',
  "category"     VARCHAR(255) NOT NULL,
  "type"         "enum_Projects_type" NOT NULL DEFAULT 'software',
  "priority"     "enum_Projects_priority" NOT NULL DEFAULT 'medium',
  "startDate"    TIMESTAMPTZ,
  "endDate"      TIMESTAMPTZ,
  "leadId"       UUID NOT NULL REFERENCES "Users"("id"),
  "settings"     JSONB,                         -- roles / roundRobin / assignees config
  "createdAt"    TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"    TIMESTAMPTZ NOT NULL DEFAULT now(),
  "deletedAt"    TIMESTAMPTZ                    -- set on the built-in "Retained tickets" bucket only
);

-- ─── Tickets ────────────────────────────────────────────────────────────────
CREATE TABLE "Tickets" (
  "id"                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "ticketNumber"           VARCHAR(255) NOT NULL UNIQUE,
  "title"                  VARCHAR(255) NOT NULL,
  "description"            TEXT NOT NULL,
  "status"                 VARCHAR(255) NOT NULL DEFAULT 'todo'
                             CHECK ("status" IN ('todo', 'in_progress', 'client_pending', 'completed')),
  "priority"               "enum_Tickets_priority" NOT NULL DEFAULT 'medium',
  "type"                   "enum_Tickets_type" NOT NULL DEFAULT 'task',
  "projectId"              UUID NOT NULL REFERENCES "Projects"("id"),
  "reporterId"             UUID NOT NULL REFERENCES "Users"("id"),
  "assigneeId"             UUID REFERENCES "Users"("id"),
  "customerId"             UUID REFERENCES "Customers"("id"),
  "storyPoints"            INTEGER CHECK ("storyPoints" BETWEEN 0 AND 100),
  "dueDate"                TIMESTAMPTZ,
  "labels"                 VARCHAR(255)[] NOT NULL DEFAULT ARRAY[]::VARCHAR(255)[],
  "SLAId"                  UUID REFERENCES "SLAs"("id"),
  "pausedTime"             TIMESTAMPTZ,
  "totalPausedTime"        INTEGER NOT NULL DEFAULT 0,    -- seconds
  "createdBy"              UUID NOT NULL REFERENCES "Users"("id"),
  "reasonForDelay"         TEXT,
  "branch"                 VARCHAR(255),
  "onSiteSupportRequired"  BOOLEAN NOT NULL DEFAULT FALSE,
  "resolvedMethods"        TEXT,
  "resolvedAt"             TIMESTAMPTZ,
  "createdAt"              TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX "Tickets_projectId_idx"   ON "Tickets" ("projectId");
CREATE INDEX "Tickets_reporterId_idx"  ON "Tickets" ("reporterId");
CREATE INDEX "Tickets_assigneeId_idx"  ON "Tickets" ("assigneeId");
CREATE INDEX "Tickets_customerId_idx"  ON "Tickets" ("customerId");
CREATE INDEX "Tickets_status_idx"      ON "Tickets" ("status");
CREATE INDEX "Tickets_priority_idx"    ON "Tickets" ("priority");
CREATE INDEX "Tickets_SLAId_idx"       ON "Tickets" ("SLAId");

-- ─── ProjectMembers (User ↔ Project) ────────────────────────────────────────
CREATE TABLE "ProjectMembers" (
  "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "projectId"   UUID NOT NULL REFERENCES "Projects"("id") ON DELETE CASCADE,
  "userId"      UUID NOT NULL REFERENCES "Users"("id") ON DELETE CASCADE,
  "role"        "enum_ProjectMembers_role" NOT NULL DEFAULT 'member',
  "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "ProjectMembers_projectId_userId_uk" UNIQUE ("projectId", "userId")
);

-- ─── TicketWatchers (User ↔ Ticket) ─────────────────────────────────────────
CREATE TABLE "TicketWatchers" (
  "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "ticketId"    UUID NOT NULL REFERENCES "Tickets"("id") ON DELETE CASCADE,
  "userId"      UUID NOT NULL REFERENCES "Users"("id") ON DELETE CASCADE,
  "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "TicketWatchers_ticketId_userId_uk" UNIQUE ("ticketId", "userId")
);

-- ─── Comments ───────────────────────────────────────────────────────────────
CREATE TABLE "Comments" (
  "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "content"     TEXT NOT NULL,
  "userId"      UUID NOT NULL REFERENCES "Users"("id"),
  "ticketId"    UUID NOT NULL REFERENCES "Tickets"("id") ON DELETE CASCADE,
  "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX "Comments_ticketId_idx" ON "Comments" ("ticketId");
CREATE INDEX "Comments_userId_idx"   ON "Comments" ("userId");

-- ─── CommentAttachments ─────────────────────────────────────────────────────
CREATE TABLE "CommentAttachments" (
  "id"            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "commentId"     UUID NOT NULL REFERENCES "Comments"("id") ON DELETE CASCADE,
  "filename"      VARCHAR(255),
  "originalName"  VARCHAR(255),
  "mimeType"      VARCHAR(255),
  "size"          INTEGER,
  "path"          VARCHAR(255),
  "uploadedBy"    UUID REFERENCES "Users"("id"),
  "createdAt"     TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX "CommentAttachments_commentId_idx" ON "CommentAttachments" ("commentId");

-- ─── TicketAttachments ──────────────────────────────────────────────────────
CREATE TABLE "TicketAttachments" (
  "id"            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "ticketId"      UUID NOT NULL REFERENCES "Tickets"("id") ON DELETE CASCADE,
  "filename"      VARCHAR(255),
  "originalName"  VARCHAR(255),
  "mimeType"      VARCHAR(255),
  "size"          INTEGER,
  "path"          VARCHAR(255),
  "uploadedBy"    UUID REFERENCES "Users"("id"),   -- nullable: guest uploads
  "createdAt"     TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX "TicketAttachments_ticketId_idx"   ON "TicketAttachments" ("ticketId");
CREATE INDEX "TicketAttachments_uploadedBy_idx" ON "TicketAttachments" ("uploadedBy");

-- ─── Activities (audit log) ─────────────────────────────────────────────────
CREATE TABLE "Activities" (
  "id"            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "type"          "enum_Activities_type" NOT NULL,
  "field"         VARCHAR(255),
  "oldValue"      JSONB,
  "newValue"      JSONB,
  "description"   TEXT,
  "ticketId"      UUID NOT NULL REFERENCES "Tickets"("id") ON DELETE CASCADE,
  "userId"        UUID NOT NULL REFERENCES "Users"("id"),
  "createdAt"     TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX "Activities_ticketId_idx" ON "Activities" ("ticketId");
CREATE INDEX "Activities_userId_idx"   ON "Activities" ("userId");

-- ─── Organizations (config) ─────────────────────────────────────────────────
CREATE TABLE "Organizations" (
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
CREATE TABLE "Roles" (
  "id"            SERIAL PRIMARY KEY,
  "name"          VARCHAR(255) NOT NULL UNIQUE,
  "permissions"   JSON NOT NULL DEFAULT '[]',
  "description"   TEXT,
  "isActive"      BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt"     TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── EmailIntegrations (config) ─────────────────────────────────────────────
CREATE TABLE "EmailIntegrations" (
  "id"            SERIAL PRIMARY KEY,
  "smtpHost"      VARCHAR(255) NOT NULL,
  "smtpPort"      INTEGER NOT NULL,
  "username"      VARCHAR(255) NOT NULL,
  "password"      VARCHAR(255) NOT NULL,
  "senderEmail"   VARCHAR(255) NOT NULL,
  "senderName"    VARCHAR(255) NOT NULL,
  "secure"        BOOLEAN NOT NULL DEFAULT FALSE,
  "isActive"      BOOLEAN NOT NULL DEFAULT TRUE,
  "lastTested"    TIMESTAMPTZ,
  "lastError"     TEXT,
  "createdAt"     TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"     TIMESTAMPTZ NOT NULL DEFAULT now()
);
