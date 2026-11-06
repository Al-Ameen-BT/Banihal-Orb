-- Additive only. Apply through the normal deployment review, never reset data.
CREATE TABLE IF NOT EXISTS "machineIdentities" (
  "id" TEXT PRIMARY KEY,
  "certificateSha256" TEXT NOT NULL UNIQUE,
  "minVersion" INTEGER NOT NULL DEFAULT 2 CHECK ("minVersion" = 2),
  "enabled" BOOLEAN NOT NULL DEFAULT TRUE,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS "squidAutomationControls" (
  "id" TEXT PRIMARY KEY,
  "paused" BOOLEAN NOT NULL DEFAULT FALSE,
  "reason" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE "squidChangeRequests" ADD COLUMN IF NOT EXISTS "targetRevision" INTEGER;
ALTER TABLE "squidChangeRequests" ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "squidChangeRequests_idempotencyKey_key" ON "squidChangeRequests" ("idempotencyKey");
