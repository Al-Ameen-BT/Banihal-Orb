-- ============================================================================
-- b2b_chat.sql — assistant chat history database (CHAT_DATABASE_URL)
-- ----------------------------------------------------------------------------
-- Idempotent DDL mirroring prisma/chat.prisma. customerId/userId are
-- service-layer links to the main `b2b` DB (no cross-database FKs possible).
--
-- Apply with:  psql -d b2b_chat -f server/db/b2b_chat.sql
-- ============================================================================

DO $$ BEGIN CREATE TYPE "ChatRole" AS ENUM ('USER','ASSISTANT'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── ChatSession ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "ChatSession" (
  "id"         TEXT PRIMARY KEY,
  "customerId" TEXT NOT NULL,   -- → b2b.customers.id (service-layer link)
  "userId"     TEXT NOT NULL,   -- → b2b.User.id (service-layer link)
  "title"      TEXT,
  "createdAt"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "ChatSession_customerId_idx" ON "ChatSession" ("customerId");
CREATE INDEX IF NOT EXISTS "ChatSession_userId_idx"     ON "ChatSession" ("userId");
CREATE INDEX IF NOT EXISTS "ChatSession_updatedAt_idx"  ON "ChatSession" ("updatedAt");

-- ─── ChatMessage ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "ChatMessage" (
  "id"         TEXT PRIMARY KEY,
  "customerId" TEXT NOT NULL,   -- → b2b.customers.id (service-layer link)
  "sessionId"  TEXT NOT NULL REFERENCES "ChatSession" ("id") ON DELETE CASCADE,
  "role"       "ChatRole" NOT NULL,
  "content"    TEXT NOT NULL,
  "createdAt"  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "ChatMessage_sessionId_idx"  ON "ChatMessage" ("sessionId");
CREATE INDEX IF NOT EXISTS "ChatMessage_customerId_idx" ON "ChatMessage" ("customerId");
