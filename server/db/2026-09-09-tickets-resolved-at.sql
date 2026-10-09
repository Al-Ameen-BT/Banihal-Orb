-- ============================================================================
-- 2026-09-09-tickets-resolved-at.sql — resolved-at timestamp on Tickets
-- ----------------------------------------------------------------------------
-- Adds the moment a ticket was last marked completed. Previously nothing
-- recorded a resolution timestamp: the dashboard inferred resolution time from
-- updatedAt (dashboardAggregate.ts) and the UI could only show "Completed" — not
-- WHEN. This column is set by ticketing.service.ts on the transition to
-- `completed` and cleared when a completed ticket is reopened, so it always
-- reflects the ticket's current resolution state.
--
-- Existing completed tickets are backfilled from updatedAt, which is the same
-- approximation the dashboard already documents ("the last write to a completed
-- ticket IS the resolution") — it gives history a sensible resolved date without
-- inventing data.
--
-- APPLY TO BOTH TICKET STORES, and to their test databases:
--   psql -d b2b_ticket             -f server/db/2026-09-09-tickets-resolved-at.sql
--   psql -d b2b_ticketing_admin    -f server/db/2026-09-09-tickets-resolved-at.sql
--   psql -d b2b_ticket_test        -f server/db/2026-09-09-tickets-resolved-at.sql
--   psql -d b2b_ticketing_admin_test -f server/db/2026-09-09-tickets-resolved-at.sql
--
-- Safe to re-run on a live database: ADD COLUMN IF NOT EXISTS and the WHERE
-- clause both converge. Declared as `resolvedAt DateTime? @db.Timestamptz(6)`
-- on model Tickets in prisma/ticket.prisma so a future `prisma db pull` does not
-- propose dropping it.
-- ============================================================================

ALTER TABLE "Tickets" ADD COLUMN IF NOT EXISTS "resolvedAt" TIMESTAMPTZ;

UPDATE "Tickets" SET "resolvedAt" = "updatedAt"
  WHERE "status" = 'completed' AND "resolvedAt" IS NULL;