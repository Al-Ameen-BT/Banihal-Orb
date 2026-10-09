-- ============================================================================
-- 2026-09-18-service-expiry-reminders.sql — expiry reminders + change records
-- ----------------------------------------------------------------------------
-- Main database only:  psql -d b2b < server/db/2026-09-18-service-expiry-reminders.sql
-- Safe to re-run: IF NOT EXISTS + idempotent blocks converge.
--
--   1. customerServices.lastRemindedAt — watermark so each reminder window
--      (30/14/7/3/1 days) mails exactly once per service.
--   2. squidChangeRequests — an auto "ticket" recorded for every requested
--      config change to a proxy (who, what, when), from any surface.
--
-- Declared on CustomerService / SquidChangeRequest / SquidChangeSource in
-- prisma/schema.prisma.
-- ============================================================================

ALTER TABLE "customerServices" ADD COLUMN IF NOT EXISTS "lastRemindedAt" TIMESTAMPTZ;

DO $$ BEGIN CREATE TYPE "SquidChangeSource" AS ENUM ('WEB','SLACK','API'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "squidChangeRequests" (
  "id"         TEXT PRIMARY KEY,
  "proxyId"    TEXT NOT NULL REFERENCES "squidProxies" ("id") ON DELETE CASCADE,
  "customerId" TEXT NOT NULL,
  "actorId"    TEXT,
  "source"     "SquidChangeSource" NOT NULL DEFAULT 'WEB',
  "action"     TEXT NOT NULL,
  "summary"    TEXT NOT NULL,
  "details"    JSONB NOT NULL DEFAULT '{}',
  "createdAt"  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "squidChangeRequests_customerId_idx" ON "squidChangeRequests" ("customerId");
CREATE INDEX IF NOT EXISTS "squidChangeRequests_proxyId_idx"   ON "squidChangeRequests" ("proxyId");