-- ============================================================================
-- 2026-09-16-approval-channel.sql — Slack approval card delivery channel
-- ----------------------------------------------------------------------------
-- Adds approvalChannelId to slackBotOrgs (main database). When set, the bot
-- posts `pending:approval` ticket cards to this channel for that organization.
--
-- Main database only:  psql -d b2b < server/db/2026-09-16-approval-channel.sql
--
-- Safe to re-run: ADD COLUMN IF NOT EXISTS.
-- Declared on model SlackBotOrg in prisma/schema.prisma.
-- ============================================================================

ALTER TABLE "slackBotOrgs" ADD COLUMN IF NOT EXISTS "approvalChannelId" TEXT;