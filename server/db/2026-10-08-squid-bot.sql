-- ============================================================================
-- 2026-10-08-squid-bot.sql — Squid host bot control plane (web-first ticketing)
-- ----------------------------------------------------------------------------
-- The vendored Squid Slack bot stops talking to Jira and drives every change
-- through the platform's ticketing instead (tasks/plan-squid-bot-integration.md
-- v2). This migration adds the platform half of that seam:
--
--   slackBots.workerMode     — SLACK_THIN (ADR-002 message forwarder, the
--                              default; existing bots are untouched) or
--                              SQUID_BOT (request/state/command-result dialect).
--   slackBotOrgs.squidProxyId — which SquidProxy the bot's host executes for
--                              (D10: one bot per org; null resolves to the
--                              org's single proxy at runtime).
--   squidChangeRequests      — new DISPATCHED status (approved → command
--                              created → waiting on the bot's ack).
--   squidBotStates           — latest /state snapshot per bot (upsert-latest).
--   squidBotCommands         — exactly-once command ledger (unique per change
--                              request), redelivered by /state until acked.
--   squidBotRules            — active-rules mirror fed by state snapshots.
--
-- Retention (D12): commands/rules trimmed after 90 days by the squid-bot
-- retention job; state is latest-only by construction (one row per bot).
--
-- Main database only:  psql -d b2b < server/db/2026-10-08-squid-bot.sql
-- Safe to re-run: IF NOT EXISTS + idempotent DO blocks + ADD VALUE IF NOT EXISTS.
-- Declared on models SlackBot / SlackBotOrg / SquidBotState / SquidBotCommand /
-- SquidBotRule / SquidChangeStatus in prisma/schema.prisma.
-- ============================================================================

-- ─── Enums ──────────────────────────────────────────────────────────────────
DO $$ BEGIN CREATE TYPE "SlackBotWorkerMode"   AS ENUM ('SLACK_THIN','SQUID_BOT');                 EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "SquidBotCommandStatus" AS ENUM ('PENDING','DISPATCHED','ACKED','FAILED','TIMED_OUT'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "SquidBotCommandType"  AS ENUM ('ALLOW','DENY','EXTEND','FULL_NET','LOCK_NET'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- New status value for the existing enum. ADD VALUE is idempotent and runs
-- outside any transaction here (provision.sh applies each file statement-wise).
ALTER TYPE "SquidChangeStatus" ADD VALUE IF NOT EXISTS 'DISPATCHED';

-- ─── SlackBot / SlackBotOrg columns ─────────────────────────────────────────
ALTER TABLE "slackBots"   ADD COLUMN IF NOT EXISTS "workerMode"   "SlackBotWorkerMode" NOT NULL DEFAULT 'SLACK_THIN';
ALTER TABLE "slackBotOrgs" ADD COLUMN IF NOT EXISTS "squidProxyId" TEXT;
CREATE INDEX IF NOT EXISTS "slackBotOrgs_squidProxyId_idx" ON "slackBotOrgs" ("squidProxyId");

-- ─── squidBotStates — upsert-latest snapshot per bot ────────────────────────
CREATE TABLE IF NOT EXISTS "squidBotStates" (
  "botId"             TEXT PRIMARY KEY REFERENCES "slackBots" ("id") ON DELETE CASCADE,
  "customerId"        TEXT NOT NULL,
  "proxyId"           TEXT REFERENCES "squidProxies" ("id") ON DELETE SET NULL,
  "instanceId"        TEXT,
  "version"           TEXT,
  "status"            "SlackBotStatus" NOT NULL DEFAULT 'DISCONNECTED',
  "socketConnected"   BOOLEAN NOT NULL DEFAULT false,
  "lastEventAt"       TIMESTAMPTZ,
  "msgCount"          INTEGER NOT NULL DEFAULT 0,
  "squidActive"       BOOLEAN NOT NULL DEFAULT false,
  "squidParseOk"      BOOLEAN,
  "squidLastReloadAt" TIMESTAMPTZ,
  "domainCount"       INTEGER NOT NULL DEFAULT 0,
  "discovery"         JSONB,
  "lastError"         TEXT,
  "raw"               JSONB NOT NULL DEFAULT '{}',
  "observedAt"        TIMESTAMPTZ NOT NULL DEFAULT now(),
  "createdAt"         TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "squidBotStates_customerId_idx" ON "squidBotStates" ("customerId");
CREATE INDEX IF NOT EXISTS "squidBotStates_proxyId_idx"    ON "squidBotStates" ("proxyId");

-- ─── squidBotCommands — exactly-once execution ledger ───────────────────────
CREATE TABLE IF NOT EXISTS "squidBotCommands" (
  "id"              TEXT PRIMARY KEY,
  "botId"           TEXT NOT NULL REFERENCES "slackBots" ("id") ON DELETE CASCADE,
  "customerId"      TEXT NOT NULL,
  "proxyId"         TEXT NOT NULL REFERENCES "squidProxies" ("id") ON DELETE CASCADE,
  "changeRequestId" TEXT NOT NULL UNIQUE REFERENCES "squidChangeRequests" ("id") ON DELETE CASCADE,
  "type"            "SquidBotCommandType" NOT NULL,
  "payload"         JSONB NOT NULL DEFAULT '{}',
  "status"          "SquidBotCommandStatus" NOT NULL DEFAULT 'PENDING',
  "attempts"        INTEGER NOT NULL DEFAULT 0,
  "result"          TEXT,
  "createdAt"       TIMESTAMPTZ NOT NULL DEFAULT now(),
  "dispatchedAt"    TIMESTAMPTZ,
  "ackedAt"         TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS "squidBotCommands_botId_status_idx" ON "squidBotCommands" ("botId", "status");
CREATE INDEX IF NOT EXISTS "squidBotCommands_customerId_idx"   ON "squidBotCommands" ("customerId");
CREATE INDEX IF NOT EXISTS "squidBotCommands_createdAt_idx"    ON "squidBotCommands" ("createdAt");

-- ─── squidBotRules — active-rules mirror for the dashboard ──────────────────
CREATE TABLE IF NOT EXISTS "squidBotRules" (
  "id"         TEXT PRIMARY KEY,
  "botId"      TEXT NOT NULL REFERENCES "slackBots" ("id") ON DELETE CASCADE,
  "customerId" TEXT NOT NULL,
  "proxyId"    TEXT REFERENCES "squidProxies" ("id") ON DELETE SET NULL,
  "ip"         TEXT NOT NULL,
  "domain"     TEXT NOT NULL,
  "isDestIp"   BOOLEAN NOT NULL DEFAULT false,
  "app"        TEXT,
  "expiresAt"  TIMESTAMPTZ,
  "lastSeenAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "squidBotRules_ip_domain_key" UNIQUE ("botId", "ip", "domain")
);
CREATE INDEX IF NOT EXISTS "squidBotRules_customerId_idx" ON "squidBotRules" ("customerId");
CREATE INDEX IF NOT EXISTS "squidBotRules_proxyId_idx"    ON "squidBotRules" ("proxyId");
CREATE INDEX IF NOT EXISTS "squidBotRules_lastSeenAt_idx" ON "squidBotRules" ("lastSeenAt");
