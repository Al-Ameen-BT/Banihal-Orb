-- Phase C: Slack identity linking.
-- One-time link codes bound to a platform user; redeeming one from a Slack DM
-- binds the user's Slack member id (slackId) so approval-card decisions can be
-- authorized without email discovery on every click.
BEGIN;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "slackLinkCodeHash" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "slackLinkExpiresAt" TIMESTAMPTZ;
COMMIT;