-- ============================================================================
-- b2b_ticketing.sql — internal Ticketing-tool fallback store (TICKETING_DATABASE_URL)
-- ----------------------------------------------------------------------------
-- Idempotent DDL mirroring prisma/ticketing.prisma (the 2-table store that
-- persists tickets/projects until the external ticketing API is connected).
-- customerId links to the main `b2b` DB in the service layer.
--
-- Apply with:  psql -d b2b_ticketing -f server/db/b2b_ticketing.sql
-- ============================================================================

DO $$ BEGIN CREATE TYPE "TicketStatus"   AS ENUM ('TODO','IN_PROGRESS','COMPLETED');       EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "TicketPriority" AS ENUM ('LOW','MEDIUM','HIGH','CRITICAL');        EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── Project ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "Project" (
  "id"          TEXT PRIMARY KEY,
  "customerId"  TEXT NOT NULL,   -- → b2b.customers.id (service-layer link)
  "name"        TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "category"    TEXT NOT NULL DEFAULT 'other',
  "priority"    "TicketPriority" NOT NULL DEFAULT 'MEDIUM',
  "assignees"   TEXT[] NOT NULL DEFAULT '{}',
  "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "Project_customerId_idx" ON "Project" ("customerId");

-- ─── Ticket ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "Ticket" (
  "id"            TEXT PRIMARY KEY,
  "customerId"    TEXT NOT NULL,   -- → b2b.customers.id (service-layer link)
  "subject"       TEXT NOT NULL,
  "description"   TEXT NOT NULL DEFAULT '',
  "issueType"     TEXT NOT NULL,
  "status"        "TicketStatus"   NOT NULL DEFAULT 'TODO',
  "priority"      "TicketPriority" NOT NULL DEFAULT 'MEDIUM',
  "projectId"     TEXT REFERENCES "Project" ("id") ON DELETE SET NULL,
  "assignee"      TEXT,
  "raisedByName"  TEXT,
  "raisedByEmail" TEXT,
  "clientName"    TEXT,
  "clientEmail"   TEXT,
  "branch"        TEXT,
  "onSiteSupport" BOOLEAN NOT NULL DEFAULT false,
  "createdAt"     TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"     TIMESTAMPTZ NOT NULL DEFAULT now(),
  "completedAt"   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS "Ticket_customerId_idx"        ON "Ticket" ("customerId");
CREATE INDEX IF NOT EXISTS "Ticket_customerId_status_idx" ON "Ticket" ("customerId", "status");
CREATE INDEX IF NOT EXISTS "Ticket_projectId_idx"         ON "Ticket" ("projectId");
CREATE INDEX IF NOT EXISTS "Ticket_createdAt_idx"         ON "Ticket" ("createdAt");
