-- ============================================================================
-- 2026-09-17-squid-proxy.sql — Squid proxy management (control plane storage)
-- ----------------------------------------------------------------------------
-- Multi-tenant squid control: per-org SquidProxy rows (one proxy = one squid
-- instance, e.g. a branch office), each with SquidBranch ACL groups. Config
-- lives platform-side (single source of truth); the per-host agent only applies
-- the rendered bundle (atomic write → squid -k parse → squid -k reconfigure).
--
-- Also carries the two Phase A/C schema touches:
--   serviceCatalog.kind  — marks the squid offering as an infra service
--   "User"."slackId"     — verified Slack identity binding (hardening pass)
--
-- Main database only:  psql -d b2b < server/db/2026-09-17-squid-proxy.sql
-- Safe to re-run: IF NOT EXISTS + idempotent indexes converge.
-- Declared on models SquidProxy / SquidBranch in prisma/schema.prisma.
-- ============================================================================

-- ─── Phase A: catalog kind + Phase C: slack identity link ───────────────────
ALTER TABLE "serviceCatalog" ADD COLUMN IF NOT EXISTS "kind" TEXT;
ALTER TABLE "User"           ADD COLUMN IF NOT EXISTS "slackId" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "User_slackId_key" ON "User" ("slackId");

-- ─── Enums ──────────────────────────────────────────────────────────────────
DO $$ BEGIN CREATE TYPE "SquidProxyStatus" AS ENUM ('UNPROVISIONED','PENDING','CONNECTED','OFFLINE','DISABLED','ERROR'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "SquidBranchMode"  AS ENUM ('ADDITIVE','EXCLUSIVE');  EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── SquidProxy ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "squidProxies" (
  "id"                  TEXT PRIMARY KEY,
  "customerId"          TEXT NOT NULL REFERENCES "customers" ("id") ON DELETE CASCADE,
  "name"                TEXT NOT NULL,
  "description"         TEXT,
  "transport"           TEXT NOT NULL DEFAULT 'agent',
  "regKeyHash"          TEXT UNIQUE,
  "regKeyEncrypted"     TEXT,
  "registrationHint"    TEXT,
  "status"              "SquidProxyStatus" NOT NULL DEFAULT 'UNPROVISIONED',
  "lastSeenAt"          TIMESTAMPTZ,
  "lastError"           TEXT,
  "revision"            INTEGER NOT NULL DEFAULT 0,
  "appliedSeq"          INTEGER NOT NULL DEFAULT 0,
  "locked"              BOOLEAN NOT NULL DEFAULT false,
  "safePorts"           JSONB NOT NULL DEFAULT '[]',
  "sslPorts"            JSONB NOT NULL DEFAULT '[]',
  "fullAccess"          JSONB NOT NULL DEFAULT '[]',
  "customerServiceId"   TEXT UNIQUE REFERENCES "customerServices" ("id"),
  "createdAt"           TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "squidProxies_customerId_idx" ON "squidProxies" ("customerId");
CREATE INDEX IF NOT EXISTS "squidProxies_status_idx"     ON "squidProxies" ("status");

-- ─── SquidBranch ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "squidBranches" (
  "id"          TEXT PRIMARY KEY,
  "proxyId"     TEXT NOT NULL REFERENCES "squidProxies" ("id") ON DELETE CASCADE,
  "customerId"  TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "description" TEXT,
  "mode"        "SquidBranchMode" NOT NULL DEFAULT 'ADDITIVE',
  "sources"     JSONB NOT NULL DEFAULT '[]',
  "whitelist"   JSONB NOT NULL DEFAULT '[]',
  "blacklist"   JSONB NOT NULL DEFAULT '[]',
  "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "squidBranches_proxyId_name_key" ON "squidBranches" ("proxyId", "name");
CREATE INDEX        IF NOT EXISTS "squidBranches_customerId_idx"  ON "squidBranches" ("customerId");