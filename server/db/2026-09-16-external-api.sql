-- ============================================================================
-- 2026-09-16-external-api.sql — external ticketing API credentials
-- ----------------------------------------------------------------------------
-- Two platform-global tables backing the machine-facing ticketing API:
--   externalApiKeys   — standing client credentials (OAuth client_credentials)
--   externalWebhooks  — per-key event delivery endpoints
--
-- Main database only (they belong to the platform directory, not a ticket
-- store):  psql -d b2b < server/db/2026-09-16-external-api.sql
--
-- Safe to re-run: CREATE TABLE IF NOT EXISTS + IF NOT EXISTS indexes converge.
-- Declared on models ExternalApiKey / ExternalWebhook in prisma/schema.prisma.
-- JSONB fields hold validated arrays from the service layer; the raw secret is
-- stored only as a SHA-256 hash and the webhook HMAC secret AES-256-GCM
-- encrypted — neither is readable after issuance.
-- ============================================================================

CREATE TABLE IF NOT EXISTS "externalApiKeys" (
  "id"          TEXT PRIMARY KEY,
  "name"        TEXT NOT NULL,
  "clientId"    TEXT NOT NULL,
  "secretHash"  TEXT NOT NULL,
  "secretHint"  TEXT NOT NULL,
  "scopes"      JSONB NOT NULL DEFAULT '[]',
  "ticketStore" TEXT NOT NULL DEFAULT 'default',
  "customerIds" JSONB NOT NULL DEFAULT '[]',
  "enabled"     BOOLEAN NOT NULL DEFAULT true,
  "expiresAt"   TIMESTAMPTZ,
  "lastUsedAt"  TIMESTAMPTZ,
  "createdById" TEXT,
  "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "externalApiKeys_clientId_key" ON "externalApiKeys" ("clientId");
CREATE INDEX         IF NOT EXISTS "externalApiKeys_clientId_idx"  ON "externalApiKeys" ("clientId");

CREATE TABLE IF NOT EXISTS "externalWebhooks" (
  "id"              TEXT PRIMARY KEY,
  "keyId"           TEXT NOT NULL,
  "url"             TEXT NOT NULL,
  "secretEnc"       TEXT NOT NULL,
  "secretHint"      TEXT NOT NULL,
  "events"          JSONB NOT NULL DEFAULT '[]',
  "enabled"         BOOLEAN NOT NULL DEFAULT true,
  "lastTriggeredAt" TIMESTAMPTZ,
  "lastDeliveryOk"  BOOLEAN,
  "failureCount"    INTEGER NOT NULL DEFAULT 0,
  "createdAt"       TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "externalWebhooks_keyId_idx"   ON "externalWebhooks" ("keyId");
CREATE INDEX IF NOT EXISTS "externalWebhooks_enabled_idx" ON "externalWebhooks" ("enabled");