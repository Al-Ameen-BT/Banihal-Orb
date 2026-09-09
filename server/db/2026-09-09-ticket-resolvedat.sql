-- ============================================================================
-- 2026-09-09-ticket-resolvedat.sql — `resolvedAt` on Tickets + backfill
-- ----------------------------------------------------------------------------
-- The 14-table ticket schema had no column recording WHEN a ticket was resolved:
-- resolution time was inferred from `updatedAt` (last write to a completed
-- ticket), which later edits inflate. Reports needed a true resolved date, so
-- `Tickets."resolvedAt" TIMESTAMPTZ` now exists — set when status flips to
-- `completed`, cleared when a completed ticket is reopened.
--
-- New tickets are covered by db/b2b_ticket.sql (provision.sh). THIS file adds
-- the column to databases already holding thousands of tickets, and backfills
-- it from the audit log: an Activities row of type `status_changed` whose
-- newValue is `"completed"` is the historical resolution moment. The LATEST such
-- transition is used (not the earliest) because a reopened-and-recompleted
-- ticket's resolvedAt means "the completion it is in today" — the same rule the
-- app's write path applies going forward.
--
-- APPLY TO BOTH TICKET STORES, and to their test databases:
--   psql -d b2b_ticket                -f server/db/2026-09-09-ticket-resolvedat.sql
--   psql -d b2b_ticketing_admin       -f server/db/2026-09-09-ticket-resolvedat.sql
--   psql -d b2b_ticket_test           -f server/db/2026-09-09-ticket-resolvedat.sql
--   psql -d b2b_ticketing_admin_test  -f server/db/2026-09-09-ticket-resolvedat.sql
--
-- Idempotent and non-destructive: ADD COLUMN IF NOT EXISTS, and the backfill
-- only touches completed tickets that still have no resolvedAt.
-- ============================================================================

ALTER TABLE "Tickets"
  ADD COLUMN IF NOT EXISTS "resolvedAt" TIMESTAMPTZ;

UPDATE "Tickets" t
SET "resolvedAt" = r.resolved_at
FROM (
  SELECT "ticketId", MAX("createdAt") AS resolved_at
  FROM "Activities"
  WHERE "type" = 'status_changed'
    AND "newValue" #>> '{}' = 'completed'
  GROUP BY "ticketId"
) r
WHERE t."resolvedAt" IS NULL
  AND t.status = 'completed'
  AND t."id" = r."ticketId";