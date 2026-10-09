# Ticketing Platform — Full Technical Report

_Last reviewed: 2026-06-19 against the working tree on branch `main`._

This report describes the complete system: what it is, the technology used in each layer, the data
model, how data flows end-to-end, and the core business logic (auth, SLA, round-robin, analytics
intelligence).

---

## 1. What the product is

A modern, Jira-style **IT support ticketing platform** with a built-in **analytics / "intelligence"
brain**. It supports:

- Internal staff (admin / manager / developer / tester) managing projects, tickets, SLAs, users.
- External **clients** (customers) who log in to a simplified portal to see their own tickets.
- **Guest** ticket submission (no login) via a public form.
- Near-real-time UI updates via WebSockets.
- An independent **Python analytics stack** that continuously mines the ticket database for trends,
  SLA risk, repeated-issue clustering, per-ticket AI-like assessments, and anomaly insights, exposed
  through its own read API.
- Optional integrations: Microsoft Teams notifications, Microsoft Graph/Azure AD (MSAL), SMTP email,
  and Shuffle SOAR automation.

---

## 2. High-level architecture

```
                       ┌──────────────────────────────────────────────┐
                       │                React SPA (client/)            │
                       │  MUI · Redux Toolkit · Axios · Socket.IO       │
                       └───────────────┬───────────────┬──────────────┘
                                       │ REST /api/*    │ WebSocket
                                       ▼                ▼
        ┌──────────────────────────────────────────────────────────────┐
        │             Node/Express API  (server/, port 5000)            │
        │  Sequelize ORM · JWT auth · Socket.IO · Multer · Nodemailer    │
        └───────────────┬───────────────────────────────┬──────────────┘
                        │                                 │ (read/write)
                        │ writes tickets                  ▼
                        │                        ┌─────────────────────┐
                        ▼                        │  PostgreSQL          │
        ┌─────────────────────────────┐  reads  │  "ticketing" DB      │
        │  Analytics brain            │◄─────────┤  (Sequelize schema)  │
        │  (analytics_agent/, Python) │          └─────────────────────┘
        │  APScheduler loops          │ writes summaries
        │  → "analytics_agent" DB     │─────────►┌─────────────────────┐
        │  → Redis pub/sub + cache    │          │  PostgreSQL          │
        └──────────────┬──────────────┘          │  "analytics_agent"DB │
                       │                          └─────────────────────┘
                       │ reads summaries
                       ▼
        ┌─────────────────────────────┐   /ws/analytics (Redis fanout)
        │  Analytics read API         │◄──────────────► browsers/dashboards
        │  (analytics_api/, FastAPI,  │
        │   port 8001)                │
        └─────────────────────────────┘

   product_service.py = cross-platform supervisor that launches & restarts all four processes.
```

Four runtime processes (all started/monitored by `product_service.py`):

1. **server** — Node/Express API (`server/index.js`) on port **5000**.
2. **analytics_api** — FastAPI via uvicorn on port **8001**.
3. **analytics_scheduler** — `python -m analytics_agent.main scheduler`.
4. **client** — React dev server (CRA) on port **3000** (only with `--with-frontend`).

---

## 3. Technology stack

### Frontend (`client/`)
- React 18 + Create React App (`react-scripts` 5).
- React Router 6, Redux Toolkit + React-Redux, Redux Persist.
- Axios (with an interceptor layer), Formik + Yup.
- Material UI 5 (`@mui/material`, icons, Emotion), MUI X Date Pickers, `date-fns`.
- Recharts (charts), React Toastify (notifications).
- Socket.IO client (real-time), `jwt-decode`.
- Microsoft: `@azure/msal-browser`, `@azure/msal-react`, `@microsoft/teams-js` (embedded Teams app).
- Dev proxy: CRA `proxy` → `http://localhost:5000`.
- Tooling: ESLint, Prettier, Husky, lint-staged.

### Backend (`server/`)
- Node.js (CommonJS) + Express 4.
- Node `http` server upgraded with **Socket.IO 4** (CORS limited to `localhost:3000`).
- **Sequelize 6** ORM over **PostgreSQL** (`pg`, `pg-hstore`).
- Auth: `jsonwebtoken`, `bcryptjs`.
- `express-validator`, `helmet`/`cors`/`morgan`, `multer` (uploads), `dotenv`.
- Reports/exports: ExcelJS, PDFKit. HTTP client: Axios. IDs: `uuid`.
- Email: Nodemailer. Scheduling: `node-cron` (root deps).
- Microsoft Graph / Azure on the server: `@microsoft/microsoft-graph-client`, `@azure/identity`,
  `@azure/msal-node`.
- Mongoose is listed at root and used only by `server/models/Sprint.js` (secondary/optional; the main
  models are Sequelize/Postgres).

### Analytics (Python 3)
- `analytics_agent/` — the "brain": `psycopg2` (Postgres), `redis`, `apscheduler`, optional ML
  (clustering + naming, optionally Anthropic API for naming).
- `analytics_api/` — **FastAPI** + uvicorn read API, `redis.asyncio` for the WebSocket fanout.

### Datastores
- **PostgreSQL** — two logical DBs: `ticketing` (the app, Sequelize-managed) and `analytics_agent`
  (the brain's computed summaries/insights).
- **Redis** — pub/sub channel `analytics:updates` + cache invalidation for analytics endpoints.

---

## 4. Data model (PostgreSQL, Sequelize)

All primary keys are **UUID v4** unless noted. Defined in `server/models/`.

| Model | Table | Key fields | Notes |
|-------|-------|-----------|-------|
| **User** | Users | firstName, lastName, email (unique), password (bcrypt), role enum `admin/manager/developer/tester`, isActive, avatar, lastLogin, `ticketApiKeyHash`/`ticketApiKeyEnabled`/… | bcrypt hash via `beforeCreate/beforeUpdate` hooks; `checkPassword()`. Personal **ticket API key** (SHA-256 hashed) for programmatic ticket creation. |
| **Customer** | Customers | name, contactPerson, email, phone, company, address, password (bcrypt, optional) | A client/end-customer. Password enables the client portal login. |
| **Project** | Projects | name, description, status, category, type, leadId, `settings` (JSONB) | `settings` holds round-robin config + assignee pool. |
| **ProjectMember** | ProjectMembers | projectId, userId, role | Join table (many-to-many User↔Project) with per-project role. |
| **Ticket** | Tickets | `ticketNumber` (TKT-001…), title, description, status (`todo/in_progress/client_pending/completed`), priority enum, type enum (`bug/feature/task/story`), projectId, reporterId, assigneeId, customerId, SLAId, storyPoints, dueDate, labels[], `pausedTime`, `totalPausedTime`, createdBy, reasonForDelay, branch, onSiteSupportRequired, resolvedMethods | The central entity. SLA pause accounting lives here. |
| **SLA** | SLAs | name, description, priority enum, responseTime, resolutionTime, timeUnit (`minutes/hours/days`), businessHours (JSONB), isActive | One SLA chosen per priority at ticket creation. |
| **Comment** | Comments | content, userId, ticketId | Has many CommentAttachment. |
| **CommentAttachment** | CommentAttachments | file metadata, commentId | |
| **TicketAttachment** | TicketAttachments | file metadata, ticketId | Cascade-deleted with ticket. |
| **TicketWatchers** | TicketWatchers | ticketId, userId | Join (User↔Ticket watchers). |
| **Activity** | Activities | type enum (`created/updated/commented/status_changed/priority_changed/assigned/attachment_added`), field, oldValue/newValue (JSONB), description, ticketId, userId | Audit/history log. |
| **Organization** | Organizations | INTEGER PK; name, domain, logo, address, contact, appName | Single-org branding/config. |
| **Role** | Roles | INTEGER PK; name (unique), permissions (JSON), description, isActive | Extended RBAC store (the JWT itself carries the enum role). |
| **EmailIntegration** | EmailIntegrations | INTEGER PK; smtpHost/Port, username, password, sender info, secure, isActive, lastTested/lastError | SMTP config for Nodemailer. |
| **Sprint** | (Mongoose) | — | Optional/secondary, not wired into the Sequelize runtime. |

### Key relationships
- Ticket **belongsTo** User (`reporter`, `assignee`), Project, Customer, SLA; **belongsToMany** User
  (`watchers`); **hasMany** Comment, TicketAttachment.
- User **hasMany** reported/assigned Tickets, Comments, Activities; **belongsToMany** Project
  (through ProjectMember); **hasMany** led Projects.
- Project **hasMany** Tickets; **belongsToMany** User (members); **belongsTo** lead User.
- Customer **hasMany** Tickets.

### Analytics DB tables (written by the brain)
`client_summary`, `assignee_summary`, `daily_summary`, `monthly_summary`, `yearly_summary`,
`issue_summary`, `branch_summary`, `requester_summary`, `relationship_summary`, `insights_log`, and
an agent state/watermark table. Indexed on problem score, risk level, closure rate, dates, severity,
etc.

---

## 5. Backend API surface (`/api/*`)

Mounted in `server/index.js`:

| Mount | File | Purpose |
|-------|------|---------|
| `/api/auth` | `routes/auth.js` | register, login (user), `client/login`, `me`, profile update, change password |
| `/api/users` | `routes/users.js` | user CRUD, status/role updates, **ticket API key** management |
| `/api/projects` | `routes/projects.js` | project CRUD, members, settings (round-robin) |
| `/api/tickets` | `routes/tickets.js` | the big one (2,500+ lines): tickets, comments, attachments, watchers, status/priority/assign, SLA, delay reasons, dashboard analytics, bulk, guest |
| `/api/customers` | `routes/customerRoutes.js` → `customerController.js` | customer CRUD + client passwords |
| `/api/slas` | `routes/slas.js` | SLA CRUD + calculation |
| `/api/settings` | `routes/settings.js` | org settings, email integration, integrations |
| `/api/public` | `routes/publicRoutes.js` | unauthenticated: `create-ticket`, view/update a ticket by id, list projects, health |
| `/api/reports` | `routes/reports.js` | report generation + download (ExcelJS/PDFKit) |

Also referenced but not all mounted in `index.js`: `organization.js`, `teams.js`, `shuffleRoutes.js`
(SOAR controller).

### Notable ticket endpoints (`routes/tickets.js`)
- `GET /analytics/dashboard` — aggregated dashboard stats.
- `POST /guest` — guest ticket creation (permissive file upload, up to 5 attachments).
- `GET /` , `GET /project/:projectId`, `POST /bulk`.
- `POST /` — **authenticated OR ticket-API-key** ticket creation (see logic below).
- `GET /client/my-tickets` — client portal ticket list.
- `GET/PUT/DELETE /:id`, comments CRUD + attachments, watchers.
- `PATCH /:id/assign`, `/:id/status`, `/:id/priority`.
- `POST/DELETE /:id/delay-reason`, `GET /:id/sla`.
- Attachment upload/download/preview/delete.

---

## 6. Authentication & authorization logic

**Two identity types share one JWT scheme** (`server/middleware/auth.js`):
- `type: 'user'` → looked up in **Users**; `type: 'client'` → looked up in **Customers**.
- Token signed with `JWT_SECRET` (env; falls back to a hardcoded dev secret). User login token
  expires in 24h (register issues 7d); client login 24h.
- `auth` middleware validates the Bearer token, checks expiry, loads the principal onto `req.user`
  (and `req.client` for customers), and rejects inactive users.

**`authOrTicketApiKey`** — alternative entry for programmatic access: accepts `x-ticket-api-key` /
`x-api-key` / `Authorization: ApiKey …`, SHA-256 hashes it, matches an enabled User key, and updates
`ticketApiKeyLastUsedAt`. Falls back to normal `auth` if no key present.

**Authorization helpers:**
- `checkRole(roles)` — enum role gate.
- `checkProjectMember` / `checkProjectAdmin` — project-scoped access (lead or member, via direct SQL
  membership check).
- Per-action checks inside routes, e.g. status update requires admin / project-lead / assignee /
  reporter.

**Password security:** bcrypt (cost 10) on both User and Customer, hashed in Sequelize hooks; clients
without a password get a clear "account not activated" message.

**Frontend auth:** `client/src/services/api.js` Axios interceptors inject the auth header and globally
handle 401 (clear token + redirect to `/login`), 403/404/422/500 with toasts. Route guards in
`App.js`: `ProtectedRoute`, `AdminRoute`, `PublicRoute`, plus client-vs-staff redirects.

---

## 7. Core business logic

### 7.1 Ticket number generation (`models/Ticket.js`)
`generateTicketNumber()` reads the highest existing `TKT-NNN`, increments, zero-pads to 3 digits, and
re-checks uniqueness with a retry loop (up to 10 attempts) to survive races.

### 7.2 Ticket creation flow (`POST /api/tickets`)
1. Validate body (title, description, type, priority, status, projectId UUID).
2. Verify project exists; if authed by API key and not admin, verify caller is project lead/member.
3. **Pick SLA**: first active SLA whose `priority` matches the ticket priority → `SLAId`.
4. **Round-robin**: if `project.settings.roundRobin.enabled` and no assignee given, call
   `getNextAssignee()`.
5. Generate ticket number, set `reporterId`/`createdBy = caller`, create the ticket.
6. If round-robin used, persist `lastAssignedId` in project settings.
7. Reload with relations; **notify assignee** by email (Nodemailer, non-blocking) and Teams.
8. Return 201 with the fully-joined ticket.

### 7.3 Round-robin assignment (`utils/roundRobin.js`)
- Assignee pool stored in `project.settings.assignees`.
- `getNextAssignee()` loads active users in the pool, finds the index after
  `settings.roundRobin.lastAssignedId`, returns the next (wrapping with modulo). Defaults to the first
  if no/stale last-assigned.
- `updateLastAssigned()` writes the chosen user back into project settings.

### 7.4 SLA engine (`services/slaService.js`)
- `convertToSeconds/FromSeconds` honor the SLA `timeUnit`.
- **Pause model**: when a ticket enters `client_pending`, `pausedTime` is stamped; on exit, the
  elapsed pause is added to `totalPausedTime`. `calculateEffectiveElapsedTime()` subtracts all paused
  time (historical + current) from wall-clock elapsed → the SLA clock only runs while the ticket is
  actively being worked.
- **Response SLA** stops once status leaves `todo`; **resolution SLA** stops at `completed`, pauses at
  `client_pending`.
- `checkSLABreach`, `getSLAStatus` → `paused / breached / critical (≤10% left) / warning (≤25%) /
  normal`.
- `updatePauseState(ticket, newStatus)` applies the pause/resume bookkeeping on status transitions.

> Note: the status-update route (`PATCH /:id/status`) currently updates `status` directly; SLA pause
> accounting is provided by `SLAService.updatePauseState` (used by the SLA-aware paths and tests). The
> `client_pending` status is the "paused" state.

### 7.5 Activity / audit trail
The `Activity` model records typed events (created, status_changed, priority_changed, assigned,
commented, attachment_added) with old/new JSONB values for ticket history (surfaced in
`TicketHistory.js`).

### 7.6 Real-time updates
Express creates a Socket.IO server; clients connect and the server re-broadcasts `ticket:update` →
`ticket:updated` and `comment:update` → `comment:updated`, so open browsers refresh without polling.

---

## 8. Analytics "brain" (`analytics_agent/`)

A separate Python service that turns raw tickets into operational intelligence.

### 8.1 Scheduler (`scheduler.py`, APScheduler, UTC)
- `run_incremental_batch` every **5 min** (watermark-based delta detection).
- `run_full_recompute` nightly at **02:00**.
- `generate_insights` every **10 min**.

### 8.2 AnalyticsAgent (`agent.py`)
- Connects to two DBs: `TICKETS_DB` (reader) and `ANALYTICS_DB` (writer), with `DB_*` legacy
  fallbacks; auto-resolves the tickets table/column casing (`tickets.updated_at` vs
  `"Tickets"."updatedAt"`).
- On each compute it **upserts** summaries:
  - **client_summary** — per-client totals, open/closed, SLA breach rate, repeat rate, critical rate,
    a weighted **problem_score** (0–100) and **risk_level** (High/Med/Low).
  - **assignee_summary** — load, closure rate, avg resolution hours, idle/stuck tickets (>48h
    untouched).
  - **daily/monthly/yearly_summary** — volume time series.
  - **issue/branch/requester_summary** — issue-type distribution (normalized via the learned category
    brain), per-branch and per-requester rollups.
  - **relationship_summary** — cross-entity relationships.
- Generates **insights** (`insights.py`): e.g. client SLA breach >30% (critical), repeat rate >50%
  (warning); plus **anomalies** (`anomaly.py`): volume spikes (z-score >2.5), SLA forecast, idle
  assignees.
- Runs the **ticket intelligence** brain (below), writes a JSON report + status file, persists learned
  category memory (`ticket_category_memory.json`).
- Publishes `analytics:updates` to **Redis** and invalidates cached analytics keys.

### 8.3 Ticket intelligence (`ticket_intelligence.py`, documented in `AGENT.md`)
Database-first per-ticket assessment: normalization → weighted-phrase **classification**
(incident/service_request/task) → IDF-style **repeated-issue clustering** → mandatory-field
**validation** → **SLA evaluation** → **assignment** suitability → **attachment** sufficiency →
**closer** resolution → per-ticket output (`ticket_insights`) with a **confidence score** that drops
as issues accumulate. Aggregates: top clients/assignees/closers, daily/monthly volume, SLA breach
rate, dashboard connectivity check. Has a `--monitor` loop mode. Learns category aliases (e.g.
Canon/Cannon/passbook → "printer") into persistent memory.

### 8.4 Optional ML (`ml_agent.py`)
Clustering + cluster naming (optionally using `ANTHROPIC_API_KEY`).

### 8.5 Analytics read API (`analytics_api/`, FastAPI, port 8001)
- Routers: `clients`, `assignees`, `branches`, `issues`, `trends`, `relationships`, `insights`,
  `health`, `ws`.
- All `/analytics/*` data routers gated by `require_api_key` (`x-api-key` vs `ANALYTICS_API_KEY`; open
  if unset). `health` is open.
- `/ws/analytics` WebSocket subscribes to Redis `analytics:updates` and pushes live events to
  dashboards.

---

## 9. End-to-end data flows

**A. Staff creates a ticket**
React `TicketForm` → `POST /api/tickets` (JWT) → validate → pick SLA by priority → round-robin
assignee → generate `TKT-NNN` → insert into `ticketing` DB → email + Teams notify assignee →
Socket.IO broadcast → other browsers update. The brain later picks up the new row (watermark),
recomputes summaries, writes to `analytics_agent` DB, publishes to Redis → analytics dashboards
refresh.

**B. Guest/client submission**
`GuestTicketForm` → `POST /api/tickets/guest` or `POST /api/public/create-ticket` (no auth) →
ticket created/associated to a Customer. Client logs in (`/api/auth/client/login`) → portal
(`/client/dashboard`) → `GET /api/tickets/client/my-tickets`.

**C. SLA lifecycle**
Ticket runs the resolution clock while active; moving to `client_pending` pauses it
(`pausedTime`/`totalPausedTime`); returning resumes; `completed` stops it. `getSLAStatus` drives the
SLA timer UI (`SLATimer.js`/`SLATimer`) colors; breaches feed analytics breach rates and can fire
Shuffle SOAR (`onSlaBreached`).

**D. Programmatic creation**
External system sends `x-ticket-api-key` → `authOrTicketApiKey` resolves the owning user → same
creation path, scoped to projects that user can access.

---

## 10. Integrations
- **Email (Nodemailer):** SMTP config in `EmailIntegration` / settings; assignment + notification
  mail.
- **Microsoft Teams:** `teamsService.js`, `teamsNotificationService.js`; client embeds via
  `@microsoft/teams-js` + `/teams` route + MSAL.
- **Shuffle SOAR:** `shuffleSoarService.js` posts ticket lifecycle events
  (created/updated/status/assigned/SLA-breach) to a Shuffle workflow when
  `SHUFFLE_SOAR_ENABLED=true`.
- **Microsoft Graph / Azure AD:** server and client MSAL packages for AAD auth flows.

---

## 11. Configuration & deployment
- Config via `.env` (template `.env.example`): tickets DB, analytics DB, legacy `DB_*`, app server
  (`PORT`, `JWT_SECRET`, CORS), uploads, `REDIS_URL`, ticket-intelligence tuning, dashboard URLs,
  optional `ANTHROPIC_API_KEY`, Shuffle SOAR.
- **Single-command run:** `python product_service.py run --with-frontend` supervises all processes,
  restarts crashed children, writes per-service logs to `service_logs/`, and can emit a systemd unit
  or a Windows `.bat` wrapper.
- **DB lifecycle (`server/index.js`):** `NODE_ENV=development` → destructive force-sync (drops schema,
  recreates enums/tables in dependency order, seeds). Any other value → safe `sequelize.sync({ alter:
  true })` (preserves data). Production also serves the React build from `client/build`.
- Migrations under `server/migrations/` (Sequelize CLI).

---

## 12. Observations / risk notes
- **Verbose request logging** in `server/index.js` logs full headers and bodies (incl. tokens /
  passwords) to stdout — fine for dev, should be removed/redacted for production.
- **Hardcoded JWT fallback secret** (`'your-super-secret-jwt-key-123'`) — ensure `JWT_SECRET` is set
  in every environment.
- **Repo hygiene:** the tree contains a large number of ad-hoc `test-*.ps1/.js`, `fix-*.js`, multiple
  `migrations_temp*` folders, and a **nested duplicate `Ticketing/Ticketing/`** directory. These look
  like accumulated scratch/troubleshooting artifacts and could be consolidated.
- **Status enum drift:** validators in some routes still reference older statuses
  (`in_review`, `done`) while the Ticket model uses `todo/in_progress/client_pending/completed` — worth
  reconciling.
- Socket.IO CORS is pinned to `localhost:3000`; update for real deployments.
```

The brain treats `closed/completed/resolved` as "closed" for analytics, tolerating schema variation.

---

_Generated by reviewing: `server/` (index, models, routes, services, middleware, utils),
`client/src/` (App, api, structure), `analytics_agent/` (main, scheduler, agent, insights, anomaly,
ticket_intelligence), `analytics_api/` (main, auth, ws), `product_service.py`, and the existing
`TECHSTACK.md` / `AGENT.md` / `README.md`._
