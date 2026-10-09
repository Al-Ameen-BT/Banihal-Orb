-- ============================================================================
-- 2026-10-07-bot-worker.sql — remote Slack bot workers (reverse control plane)
-- ----------------------------------------------------------------------------
-- Implements ADR-002 for a Slack bot whose live connection runs OUTSIDE the
-- platform network (e.g. the Squid host worker): the worker calls home over
-- HTTPS (no inbound port), authenticates every request with a `wrk_` worker key
-- (SHA-256 hash + AES-256-GCM ciphertext for HMAC verification — the same
-- split squidProxies already uses for its `pk_` key), and provisions this bot's
-- Slack tokens exactly once. `executionOwner` decides whether SlackManager
-- (PLATFORM) or the host worker (HOST_WORKER) owns the live Socket Mode
-- connection; a HOST_WORKER bot is skipped by the platform's slackManager so the
-- two never double-connect.
--
-- Main database only:  psql -d b2b < server/db/2026-10-07-bot-worker.sql
-- Safe to re-run: ADD COLUMN IF NOT EXISTS + idempotent DO block.
-- Declared on model SlackBot in prisma/schema.prisma.
-- ============================================================================

-- ─── Execution ownership enum ───────────────────────────────────────────────
DO $$ BEGIN CREATE TYPE "SlackBotExecutionOwner" AS ENUM ('PLATFORM','HOST_WORKER'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── SlackBot worker-key + ownership columns ────────────────────────────────
ALTER TABLE "slackBots" ADD COLUMN IF NOT EXISTS "workerKeyHash"         TEXT;
ALTER TABLE "slackBots" ADD COLUMN IF NOT EXISTS "workerKeyEnc"          TEXT;
ALTER TABLE "slackBots" ADD COLUMN IF NOT EXISTS "workerKeyHint"         TEXT;
ALTER TABLE "slackBots" ADD COLUMN IF NOT EXISTS "workerProvisionedAt"   TIMESTAMPTZ;
ALTER TABLE "slackBots" ADD COLUMN IF NOT EXISTS "activeInstance"        TEXT;
ALTER TABLE "slackBots" ADD COLUMN IF NOT EXISTS "executionOwner"        "SlackBotExecutionOwner" NOT NULL DEFAULT 'PLATFORM';
ALTER TABLE "slackBots" ADD COLUMN IF NOT EXISTS "workerRotationPending" BOOLEAN NOT NULL DEFAULT false;