-- ============================================================================
-- 00_databases.sql — create the four application databases (cluster-level)
-- ----------------------------------------------------------------------------
-- Run as a Postgres superuser, connected to any existing database (e.g.
-- `postgres`):
--
--   sudo -u postgres psql -f server/db/00_databases.sql
--
-- Postgres has no `CREATE DATABASE IF NOT EXISTS`, so each database is created
-- through the `\gexec` idiom: the SELECT emits a `CREATE DATABASE` command only
-- when the database is absent, and `\gexec` runs whatever the query produced.
-- Re-running this file is therefore a no-op for databases that already exist.
--
-- The platform-Administrators' isolated ticket store (`b2b_ticketing_admin`,
-- ADMIN_TICKETING_DATABASE_URL) IS created here (it is a required store — the app
-- has no fallback to b2b_ticket). Its SCHEMA is NOT one of the .sql files: it is
-- loaded from the custom-format pg dump `ticketingDB` at the repo root, e.g.
-- (from the repo root):
--   pg_restore -d "$ADMIN_TICKETING_DATABASE_URL" ticketingDB
-- (run after this script; skip if the DB is already populated — the dump is
-- schema-only and a --clean restore would drop existing tickets).
-- ============================================================================

SELECT 'CREATE DATABASE b2b'
 WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'b2b')\gexec

SELECT 'CREATE DATABASE b2b_chat'
 WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'b2b_chat')\gexec

SELECT 'CREATE DATABASE b2b_ticketing'
 WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'b2b_ticketing')\gexec

SELECT 'CREATE DATABASE b2b_ticket'
 WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'b2b_ticket')\gexec

SELECT 'CREATE DATABASE b2b_ticketing_admin'
 WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'b2b_ticketing_admin')\gexec
