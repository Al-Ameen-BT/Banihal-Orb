# Database provisioning (SQL-first)

Hand-authored, **idempotent** SQL DDL is the schema source of truth for the
application's Postgres databases. This replaces `prisma db push` — the Prisma
CLI is no longer needed to create or update the schema (Prisma _clients_ are
still generated with `npm run db:generate` while the code migration to raw
`pg` is in progress).

## Databases

| File | Database | Env var | Contents |
|---|---|---|---|
| `b2b.sql` | `b2b` | `DATABASE_URL` | Core platform: customers, users, MFA, audit, bots, AD secrets (21 tables) |
| `b2b_chat.sql` | `b2b_chat` | `CHAT_DATABASE_URL` | Assistant chat history (2 tables) |
| `b2b_ticketing.sql` | `b2b_ticketing` | `TICKETING_DATABASE_URL` | Internal ticketing fallback store (2 tables) |
| `b2b_ticket.sql` | `b2b_ticket` | `TICKET_DATABASE_URL` | Full 14-table external ticketing platform schema |

`00_databases.sql` creates the four databases themselves (cluster-level).

### Not provisioned: `b2b_ticketing_admin`

The platform-Administrators' **isolated** ticket store
(`ADMIN_TICKETING_DATABASE_URL`) is intentionally **not** built here. When that
URL is unset the app falls back to `b2b_ticket`, so Administrator ticketing
keeps working on the shared store (see `src/config/ticketDatabase.ts`). To add a
separate admin store later, create the database and apply `b2b_ticket.sql` to
it (it uses the same 14-table schema).

## Usage

```bash
# One command (reads DB URLs from server/.env):
bash db/provision.sh
# or:  npm run db:provision

# Confirm all four required DBs are reachable + provisioned (fail-fast, exits 1
# on any failure). deploy.sh runs this as a hard gate before starting systemd:
npm run db:verify
```

Or manually:

```bash
sudo -u postgres psql -f db/00_databases.sql          # create the 4 databases
psql "$DATABASE_URL"           -f db/b2b.sql
psql "$CHAT_DATABASE_URL"      -f db/b2b_chat.sql
psql "$TICKETING_DATABASE_URL" -f db/b2b_ticketing.sql
psql "$TICKET_DATABASE_URL"    -f db/b2b_ticket.sql
```

Every script is safe to re-run: databases use a `\gexec` existence guard,
tables/indexes use `IF NOT EXISTS`, and enum types are wrapped in a
`duplicate_object`-tolerant `DO` block. Re-running never drops or truncates.

## Conventions

- **`id`** columns on the cuid databases (`b2b`, `b2b_chat`, `b2b_ticketing`)
  are `TEXT` with **no default** — cuids are generated in the app layer
  (Prisma `@default(cuid())` and `db.ts`'s `newId()` are both client-side).
  `b2b_ticket` uses `UUID DEFAULT gen_random_uuid()` (Sequelize convention).
- **Datetime** columns are `TIMESTAMPTZ` so JS `Date` comparisons via
  node-postgres are timezone-correct regardless of the DB session `TimeZone`.
  (Prisma `db push` created `timestamp without time zone`, which skewed the
  `announcements.expiresAt > now` filter by the session UTC offset.)
- **Table names** honour Prisma `@@map` (`customers`, `customerServices`,
  `slackBots`, …); un-mapped models keep their PascalCase name (`User`,
  `Announcement`, …). The raw-`pg` services depend on these exact names.

## Relationship to `prisma/`

- `prisma/schema.prisma`, `chat.prisma`, `ticketing.prisma`, `ticket.prisma`
  remain the definition the Prisma **clients** are generated from
  (`npm run db:generate`). Keep the `.sql` files here in sync when a model
  changes until Prisma is fully removed.
- `prisma/ticketing-full-schema.sql` is the older **destructive** rebuild of
  the 14-table store; `b2b_ticket.sql` supersedes it with a non-destructive,
  re-runnable version derived from `prisma/ticket.prisma`.
