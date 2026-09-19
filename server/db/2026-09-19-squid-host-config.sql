-- ============================================================================
-- 2026-09-19-squid-host-config.sql — read-only snapshot of the host squid conf
-- ----------------------------------------------------------------------------
-- Main database only:  psql -d b2b < server/db/2026-09-19-squid-host-config.sql
-- Safe to re-run: IF NOT EXISTS.
--
--   1. squidHostConfigs — one row per proxy, upserted by the agent when it
--      reports a conf snapshot (previous hash != current). The org dashboard
--      "Host config" tab and the platform admin store read this to show the
--      CURRENT squid config actually applied on the bot host (read-only).
--
-- Declared on model SquidHostConfig in prisma/schema.prisma.
-- ============================================================================

CREATE TABLE IF NOT EXISTS "squidHostConfigs" (
  "proxyId"    TEXT PRIMARY KEY REFERENCES "squidProxies" ("id") ON DELETE CASCADE,
  "customerId" TEXT NOT NULL,
  "hash"       TEXT NOT NULL,
  "capturedAt" TIMESTAMPTZ NOT NULL,
  "files"      JSONB NOT NULL DEFAULT '[]',
  "createdAt"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "squidHostConfigs_customerId_idx" ON "squidHostConfigs" ("customerId");