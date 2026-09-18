-- ============================================================================
-- 2026-09-18-squid-telemetry.sql — agent telemetry + live activity feed
-- ----------------------------------------------------------------------------
-- Main database only:  psql -d b2b < server/db/2026-09-18-squid-telemetry.sql
-- Safe to re-run: IF NOT EXISTS + idempotent converges.
--
--   1. squidTelemetry — one snapshot row per agent report window. Counters are
--      cumulative; deltas derived on read (kb/requests/denied per window).
--      Retained ~7 days (pruned on ingest).
--   2. squidLogEntries — recent access.log lines from the agent log tail.
--      Retained ~48h; drives the live Activity viewer and the Sessions list.
--
-- Declared on models SquidTelemetry / SquidLogEntry in prisma/schema.prisma.
-- ============================================================================

CREATE TABLE IF NOT EXISTS "squidTelemetry" (
  "id"            TEXT PRIMARY KEY,
  "proxyId"       TEXT NOT NULL REFERENCES "squidProxies" ("id") ON DELETE CASCADE,
  "customerId"    TEXT NOT NULL,
  "observedAt"    TIMESTAMPTZ NOT NULL DEFAULT now(),
  "seq"           INTEGER NOT NULL,
  "squidVersion"  TEXT,
  "uptimeSeconds" INTEGER,
  "cpuPercent"    DOUBLE PRECISION,
  "memPercent"    DOUBLE PRECISION,
  "diskPercent"   DOUBLE PRECISION,
  "sessions"      JSONB NOT NULL DEFAULT '[]',
  "counters"      JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS "squidTelemetry_customerId_idx"       ON "squidTelemetry" ("customerId");
CREATE INDEX IF NOT EXISTS "squidTelemetry_proxyId_observedAt_idx" ON "squidTelemetry" ("proxyId", "observedAt");

CREATE TABLE IF NOT EXISTS "squidLogEntries" (
  "id"         TEXT PRIMARY KEY,
  "proxyId"    TEXT NOT NULL REFERENCES "squidProxies" ("id") ON DELETE CASCADE,
  "customerId" TEXT NOT NULL,
  "observedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "clientIp"   TEXT NOT NULL DEFAULT '',
  "method"     TEXT NOT NULL DEFAULT '',
  "action"     TEXT NOT NULL DEFAULT '',
  "url"        TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS "squidLogEntries_customerId_idx"        ON "squidLogEntries" ("customerId");
CREATE INDEX IF NOT EXISTS "squidLogEntries_proxyId_observedAt_idx" ON "squidLogEntries" ("proxyId", "observedAt");