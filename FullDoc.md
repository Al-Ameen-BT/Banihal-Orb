# B2B Cybersecurity SaaS Platform — Full Project Documentation

> A production-style, multi-tenant B2B SaaS application for selling and managing
> managed cybersecurity services (SIEM, SOC, EDR, Zero Trust, DLP, etc.). It pairs
> a hardened Express + Prisma API with a Next.js 14 console, layered 3-tier RBAC,
> infrastructure-level tenant isolation, a support-ticket workflow, and a
> DB-persisted AI assistant.

---

## 1. Overview

The platform serves three audiences from one codebase:

- **End users** at client organizations — view their org's subscribed security
  services, raise support tickets, track ticket status/history, and chat with an
  AI assistant (history persisted).
- **Organization admins** — everything a user can do, plus an organization-wide
  ticket overview, user management, and org settings.
- **Platform administrators** (the software provider) — a separate **Control
  Plane** to manage every customer org, services, the service catalog, feature
  flags, impersonation, and activity/audit feeds.

The repo is a two-folder workspace: **`/server`** (API) and **`/client`** (web
console), each independently installed and run.

---

## 2. Tech Stack

| Layer | Technology |
|---|---|
| **API runtime** | Node.js, Express 4 (TypeScript, strict) |
| **ORM / DB** | Prisma 5 + PostgreSQL |
| **Validation** | Zod (request bodies, query params, env) |
| **Auth** | JWT (access + refresh) in **HttpOnly** cookies, bcryptjs hashing |
| **Security middleware** | helmet, cors (allow-list), express-rate-limit |
| **Logging** | winston |
| **Tests** | Vitest + Supertest |
| **Frontend** | Next.js 14 (App Router), React 18, TypeScript |
| **Data fetching** | TanStack React Query v5 |
| **Styling** | TailwindCSS 3 |
| **Animation** | Framer Motion |
| **Charts / PDF** | Recharts, jsPDF |
| **AI assistant** | External "Analytics Agent" (SSE) proxied by the API |

---

## 3. Architecture

```
B2B-Site/
├── server/                     # Express + Prisma API
│   ├── prisma/
│   │   ├── schema.prisma        # Data model (source of truth)
│   │   └── seed.ts              # Demo data (orgs, users, services, tickets)
│   └── src/
│       ├── app.ts               # Express app: middleware + route mounting
│       ├── server.ts            # Bootstrap / listen
│       ├── config/
│       │   ├── env.ts            # Zod-validated env (fails fast)
│       │   ├── database.ts       # Prisma client + tenant-isolation extension
│       │   └── security.ts       # CORS options
│       ├── middleware/
│       │   ├── auth.middleware.ts     # JWT verify → req.user
│       │   ├── tenant.middleware.ts   # AsyncLocalStorage customerId context
│       │   ├── rbac.middleware.ts     # requireRole(...)
│       │   ├── rateLimiter.ts         # global / auth / chat limiters
│       │   └── errorHandler.ts        # structured error responses
│       └── modules/
│           ├── auth/             # register, login, refresh, logout
│           ├── users/            # profile, password, user CRUD/invite
│           ├── organizations/    # org settings, security, my services
│           ├── dashboard/        # KPIs + action queue
│           ├── requests/         # support tickets (user + org-admin views)
│           ├── chat/             # AI assistant proxy + persisted history
│           └── saas-admin/       # platform control plane
└── client/                     # Next.js console
    └── src/
        ├── app/                  # routes (App Router)
        ├── components/ui/        # Sidebar, Chatbot, TicketForm, etc.
        ├── components/guards/    # RoleGuard
        ├── contexts/AuthContext.tsx
        └── lib/{api.ts, schemas.ts}
```

**Request lifecycle (protected route):**
`helmet → cors → rate-limit → cookie-parser → JSON body → authMiddleware
(JWT → req.user) → tenantMiddleware (customerId into AsyncLocalStorage) →
route handler → Prisma (auto-scoped) → errorHandler`.

---

## 4. Roles & RBAC

Three-tier role enum: **`USER` → `ORG_ADMIN` → `ADMINISTRATOR`**.

| Role | Scope | Can do |
|---|---|---|
| `USER` | Their org | View services, raise/track own tickets, chat assistant |
| `ORG_ADMIN` | Their org | All USER abilities + org-wide ticket overview, user management, org settings |
| `ADMINISTRATOR` | **Platform-wide** | The provider super-admin: Control Plane over all orgs, services, catalog, flags, impersonation |

Enforcement points:
- **Server:** `requireRole(...roles)` middleware ([rbac.middleware.ts](server/src/middleware/rbac.middleware.ts)) returns `403 FORBIDDEN` when `req.user.role` isn't allowed. The entire `/api/saas-admin` tree is gated `requireRole('ADMINISTRATOR')`.
- **Client:** `RoleGuard allowedRoles={[...]}` ([RoleGuard.tsx](client/src/components/guards/RoleGuard.tsx)) redirects unauthenticated users to `/login` and unauthorized roles to `/403`.
- **Administrator domain lock:** the `ADMINISTRATOR` role can only authenticate from a work-email domain listed in the `ADMIN_DOMAINS` env var (fail-closed; empty = admin login disabled).

### Token model

| | Access token | Refresh token |
|---|---|---|
| Form | JWT, HS256, `iss=b2b-saas-api`, `aud=b2b-saas-client` | **Not a JWT** — 64 CSPRNG bytes |
| Storage | httpOnly cookie, path `/` | httpOnly cookie, path `/api/auth`; SHA-256 hashed in `RefreshToken` |
| Lifetime | `JWT_ACCESS_EXPIRES_IN` (15m) | `JWT_REFRESH_EXPIRES_IN` (7d) — sets the row AND the cookie Max-Age |
| Claims | `userId, customerId, role, prid, sid, type:'access'`, plus `imp` on an impersonated session | — |

Verification pins `algorithms: ['HS256']`, issuer and audience, and asserts
`type === 'access'`. Every request then checks the `sid` claim against a live
`RefreshToken` row, so **revocation is immediate** — this is not a "JWTs can't be
revoked" design. Rotation is one-time-use and preserves `sid`.

Generated tokens (refresh, reset, verification, trusted device) are SHA-256 hashed,
never bcrypt: bcrypt salts each hash, which makes a token unlookupable and forces a
scan of every row to find one. Only passwords use bcrypt.

**Impersonation** is two steps. `POST /saas-admin/impersonate/:userId` issues a
5-minute *grant* naming both the target and the issuing admin (`by`).
`POST /saas-admin/impersonate` exchanges it for a session — behind `orgs.manage`
AND requiring the caller to be that same admin, so the grant is not a bearer
credential on its own. Platform staff cannot be impersonated. The resulting access
token carries `imp` so actions remain attributable. There is no "stop
impersonating" endpoint yet: the admin signs in again to return to their own
session.

---

## 5. Multi-Tenancy & Security Model

**Tenant isolation is enforced at the infrastructure layer**, not per-query by hand:

- On each authenticated request, `tenantMiddleware` stores `{ customerId }` in an
  `AsyncLocalStorage` ([tenant.middleware.ts](server/src/middleware/tenant.middleware.ts)).
- A Prisma client extension ([database.ts](server/src/config/database.ts)) reads
  that context and **auto-injects `where: { customerId }`** on
  `findFirst / findMany / findUnique / update / updateMany / delete / deleteMany / count`
  for every model **except** the global ones (`FeatureFlag`, `Customer`, `RefreshToken`).
- **Caveats the code relies on:**
  - `create` is **not** auto-scoped → inserts must set `customerId` explicitly.
  - `groupBy` is **not** auto-scoped → it must take `where: { customerId }` by
    hand (done in the org-tickets count). Forgetting this leaks cross-org data.
- The `/api/saas-admin` routes run **without** tenant scope so the platform admin
  can query across all orgs.

**Other security measures:**
- Passwords hashed with **bcrypt (12 rounds)**; `passwordHash` excluded from all responses via Prisma `select`.
- **JWT in HttpOnly + SameSite cookies** (Secure configurable via `COOKIE_SECURE`); access token ~15m, refresh token 7d.
- **Refresh-token rotation**: refresh tokens are bcrypt-hashed, stored in DB, one-time-use (old token deleted on refresh).
- **Single active session per user (all roles)**: a second browser cannot log in while a session is active (`409 SESSION_ACTIVE`, audit-logged as `LOGIN_BLOCKED_ACTIVE_SESSION`). The access JWT carries a stable `sid` claim validated against the session row on every request, so logout/revocation takes effect immediately (`401 SESSION_REVOKED`). Same-browser re-login replaces the user's own session; a session idle longer than `SESSION_INACTIVITY_MINUTES` (default 30) is treated as released so a closed-without-logout browser cannot lock the account.
- **helmet** CSP, **CORS allow-list** (`ALLOWED_ORIGINS`), and **rate limiting** (global, stricter on `/api/auth`, separate limiter on `/api/chat`).
- **Impersonation** uses a short-lived (5-minute) signed token and writes an `AuditLog` entry.
- Env is **Zod-validated at boot**; invalid/missing secrets exit the process.

---

## 6. Data Model (Prisma)

Defined in [schema.prisma](server/prisma/schema.prisma).

### Models

| Model | Purpose | Key fields |
|---|---|---|
| **Customer** | A tenant (client org) | `name, slug, plan, suspended, ssoEnabled, mfaRequired, creditLimit, mailId, contactPerson, contactNumber, domain (unique), industry, contractValue, healthScore, csm` |
| **User** | A person in an org | `email (unique), passwordHash, name, role, mfaEnabled, lastLoginAt, customerId` |
| **RefreshToken** | Rotating refresh tokens | `tokenHash (unique), userId, expiresAt` |
| **AuditLog** | Security/audit trail | `action, performedById, targetId, metadata (JSON), customerId` |
| **FeatureFlag** | Global flags | `key (unique), value, description` |
| **OrgFeatureFlag** | Per-org flag overrides | `customerId, key, value` (unique `[customerId, key]`) |
| **ServiceRequest** | Support ticket | `customerId, createdById?, type, status, priority, subject, description?, service?, assignedTo?, resolvedAt?` |
| **ServiceCatalog** | Platform master service list | `name, description?, category?, basePrice, enabled` |
| **CustomerService** | A service a given org has purchased | `customerId, name, description?, monthlyPrice, purchaseDate, endDate, notes?` (status derived from `endDate`) |
| **ChatSession** | A persisted assistant conversation | `customerId, userId, title?, timestamps` |
| **ChatMessage** | One turn in a conversation | `customerId, sessionId, role (ChatRole), content` |

### Enums

- `Role`: `USER | ORG_ADMIN | ADMINISTRATOR`
- `Plan`: `FREE | PRO | ENTERPRISE`
- `ServiceStatus`: `ACTIVE | EXPIRING | EXPIRED | SUSPENDED` (derived in code from `endDate`)
- `RequestType`: `SUPPORT | INCIDENT | FEATURE_REQUEST | ONBOARDING | BILLING`
- `RequestStatus`: `OPEN | IN_PROGRESS | RESOLVED | CLOSED | ESCALATED`
- `Priority`: `CRITICAL | HIGH | MEDIUM | LOW`
- `ChatRole`: `USER | ASSISTANT`

> **Services model:** there is **no shared per-org catalog link** — each org owns
> its `CustomerService` rows (name + price + dates stored directly). The
> `ServiceCatalog` is a master list the platform admin maintains; status
> (`ACTIVE/EXPIRING/EXPIRED`) is computed from `endDate`, not stored.

---

## 7. Backend API Reference

Base URL: `http://localhost:3001/api`. All non-auth routes require a valid access
cookie (`authMiddleware`); tenant-scoped groups also run `tenantMiddleware`.

### Auth — `/api/auth` (public, rate-limited)
| Method | Path | Purpose |
|---|---|---|
| POST | `/register` | Create a new org + first user (→ `ORG_ADMIN`, or `ADMINISTRATOR` on a provider domain). Rejects personal/disposable domains with `400 WORK_EMAIL_REQUIRED`. |
| POST | `/register-user` | Join an **existing** org resolved by work-email domain (→ `USER`). Same `400 WORK_EMAIL_REQUIRED` rejection. |
| POST | `/login` | Authenticate; sets HttpOnly access + refresh cookies. |
| POST | `/refresh` | Rotate tokens (one-time-use refresh). |
| POST | `/logout` | Revoke the refresh token. |

### Users — `/api/users` (auth + tenant)
| Method | Path | Role | Purpose |
|---|---|---|---|
| GET | `/me` | any | Current user profile (drives client auth state). |
| PATCH | `/me` | any | Update own name / `mfaEnabled`. |
| PATCH | `/me/password` | any | Change own password. |
| GET | `/` | ORG_ADMIN+ | List users in the org. |
| POST | `/invite` | ORG_ADMIN+ | Invite a user (`USER`/`ORG_ADMIN`). |
| PATCH | `/:id/role` | ORG_ADMIN+ | Change a user's role. |
| DELETE | `/:id` | ORG_ADMIN+ | Remove a user. |

### Organizations — `/api/organizations` (auth + tenant)
| Method | Path | Role | Purpose |
|---|---|---|---|
| GET | `/me` | any | Current org details. |
| PATCH | `/me` | ORG_ADMIN+ | Update org profile. |
| PATCH | `/me/security` | ORG_ADMIN+ | Toggle SSO / MFA requirements. |
| GET | `/me/services` | any | The org's subscribed services + monthly total. |

### Support Tickets — `/api/requests` (auth + tenant)
| Method | Path | Role | Purpose |
|---|---|---|---|
| POST | `/` | any | Create a ticket (sets `customerId` + `createdById`). |
| GET | `/` | any | List the **caller's own** tickets (filter `status`, paginated). |
| GET | `/org` | ORG_ADMIN+ | **Org-wide** tickets incl. `createdBy {name,email}` + status `counts`. |
| GET | `/:id` | any | A single own ticket (404 if not owner). |
| PATCH | `/:id/close` | any | Close own ticket (→ `CLOSED`, sets `resolvedAt`). |

### AI Assistant — `/api/chat` (auth + tenant)
| Method | Path | Notes |
|---|---|---|
| POST | `/` | SSE stream (rate-limited). Resolves/creates a `ChatSession`, emits `data: {"sessionId":...}`, persists the user turn, proxies tokens from the Agent, then persists the assistant reply. |
| GET | `/sessions` | List the caller's conversations (title, updatedAt, messageCount). |
| GET | `/sessions/:id` | Conversation detail with messages (404 if not owner). |
| DELETE | `/sessions/:id` | Delete a conversation (cascades messages). |

### Control Plane — `/api/saas-admin` (ADMINISTRATOR only, **no tenant scope**)
| Group | Endpoints |
|---|---|
| **Orgs** | `GET /orgs`, `GET /orgs/overview`, `PATCH /orgs/:id`, `GET /orgs/:id/detail` |
| **People** | `GET /admins`, `POST /impersonate/:userId`, `PATCH /users/:id`, `DELETE /users/:id`, `POST /users/:id/reset-password` |
| **Metrics** | `GET /metrics`, `GET /top-clients` |
| **Requests** | `GET /requests`, `PATCH /requests/:id` |
| **Services** | `GET /services`, `POST /customers/:customerId/services`, `PATCH /services/:id`, `POST /services/:id/renew`, `DELETE /services/:id` |
| **Catalog** | `GET /catalog`, `POST /catalog`, `PATCH /catalog/:id`, `DELETE /catalog/:id` |
| **Flags** | `GET /flags`, `PATCH /flags/:key` |
| **Activity / Sadmins** (`ADMINISTRATOR`) | `GET /activity`, `GET /system-activity`, `GET /logins-by-org` (per-org login classification: count, unique users, last login; filters `role`/`from`/`to`), `GET /sadmins`, `PATCH /sadmins/:id`, `DELETE /sadmins/:id`, `POST /sadmins/:id/reset-password` |

Errors are returned as `{ error, code, details? }`; Zod failures use code `VALIDATION_ERROR` with `fieldErrors`.

---

## 8. Frontend (Next.js Console)

### Routes
| Path | Role gate | Description |
|---|---|---|
| `/login` | public | Sign in. Redirects to `/dashboard` on success. |
| `/register` | public | Org registration (`OrgRegister`) and user join (`UserRegister`). |
| `/dashboard` | USER+ | **Combined user dashboard** (see §9). Org-admins get an extra org-ticket section. |
| `/support` | USER+ | Standalone ticket-creation page with SLA reference + chat cross-link. |
| `/chat` | USER+ | Full-height AI assistant; supports `?session=<id>` to resume history. |
| `/services` | ORG_ADMIN+ | Org service management view. |
| `/users` | ORG_ADMIN+ | Org user management. |
| `/profile` | USER+ | Profile + password + MFA. |
| `/saas-admin` | ADMINISTRATOR | Control Plane dashboard (orgs, metrics, requests, flags). |
| `/saas-admin/services` | ADMINISTRATOR | Cross-org customer-service management. |
| `/saas-admin/catalog` | ADMINISTRATOR | Platform service catalog CRUD. |
| `/saas-admin/orgs/[id]` | ADMINISTRATOR | Single-org detail + service assignment. |
| `/403`, `/server-error`, `not-found`, `error` | — | Error / access pages. |

### Key components & libs
- **`Sidebar`** — role-aware nav: USER sees Dashboard/Support/Assistant/Profile;
  ORG_ADMIN adds Services/Users; ADMINISTRATOR adds a "Platform" section.
- **`Chatbot`** — streaming chat UI with a lightweight markdown renderer; accepts
  `initialMessages` to replay a resumed conversation.
- **`TicketForm`** — live ticket creation (`POST /api/requests`); shows a real
  `TKT-…` reference and invalidates the `my-requests` query.
- **`RoleGuard`** — client-side route protection.
- **`AuthContext`** — loads `/users/me`, exposes `login/logout/refresh`; the axios
  client auto-refreshes on 401 and redirects on 403/5xx.
- Supporting UI: `GlowButton`, `KpiCard`, `Toggle`, `Shimmer`, `AmbientBackdrop`.
- **API layer** ([api.ts](client/src/lib/api.ts)) groups: `authApi`, `usersApi`,
  `orgsApi`, `dashboardApi`, `requestsApi`, `chatApi`, `saasAdminApi`.

---

## 9. Feature Walkthroughs

### Authentication & onboarding
- **Work email required:** both registration paths refuse consumer, free-mail and
  disposable domains (gmail, outlook, yahoo, proton, mailinator, …) with
  `400 WORK_EMAIL_REQUIRED`. The list lives in
  `server/src/modules/auth/emailDomains.ts` and is **code-only** — there is no env
  override, no allowlist, and no bypass for domains in `ADMIN_DOMAINS`. Editing it
  is a code change and a deploy. See
  `docs/decisions/ADR-001-work-email-domain-filtration.md`.
- **New org:** `/register` → `POST /auth/register` creates a `Customer` + first
  user. The org is keyed off the email's domain, so that domain is always present.
  Provider-domain emails become `ADMINISTRATOR`; everyone else becomes `ORG_ADMIN`.
- **Join an org:** users self-register via `/register-user`; the org is matched by
  the work-email domain (unique per org). Suspended orgs are blocked.
- **Not the security boundary:** domain filtration is a first-pass filter. What
  actually admits an organization is the approval flow below — a human with
  `orgs.approve` releasing it with an out-of-band code.
- Tokens land in HttpOnly cookies; the client never sees raw JWTs.

### The combined user dashboard (`/dashboard`)
A single page that adapts to role:
1. **Greeting** + org overview strip.
2. **(ORG_ADMIN/ADMINISTRATOR only) Organization Tickets** — status-count tiles
   (Open / In Progress / Resolved / Total) plus an expandable list of **every**
   ticket raised across the org, each showing the **creator's name/email**,
   priority, status, and description. Includes a status filter. Data comes from
   `GET /api/requests/org` and is fetched only when `isAdmin`.
3. **Ticket status tiles** for the signed-in user's own tickets.
4. **Create a ticket** (`TicketForm`).
5. **Your Tickets** — expandable history of the user's own tickets with a
   client-side status filter and a per-ticket **Close** action.
6. **Chat History** — cards for each saved conversation; clicking opens a modal
   that loads the full transcript, with **Continue → `/chat?session=<id>`** and a
   **Delete** action.
7. **Your Services** — condensed list of subscribed services with renewal status.

### Support tickets
End-to-end ticket lifecycle: a user creates a ticket (attributed via
`createdById`), tracks its status/history on the dashboard, and can close it. Org
admins see the whole org's tickets and who raised them. Platform admins manage
tickets cross-org from the Control Plane (`/api/saas-admin/requests`).

### AI assistant with persisted history
- The browser streams to `POST /api/chat`; the API proxies an external
  **Analytics Agent** over SSE (`AGENT_URL`).
- The server creates/locates a `ChatSession`, emits the `sessionId` first,
  **persists the user message before streaming** (so it survives an agent
  outage), then persists the assistant reply and bumps the session.
- Sessions and messages are listable/viewable/deletable per user; conversations
  are isolated by user and tenant. Conversations resume from history via
  `/chat?session=<id>`.

### Services
Each org's subscribed `CustomerService` rows render with derived status
(Active / Expiring soon / Expired) and renewal countdowns. The platform admin
assigns/renews/removes services and curates the master `ServiceCatalog`.

### Control Plane (platform admin)
Cross-org metrics (orgs, users, MRR/ARR, open/critical requests), org overview &
detail, user management + password resets, **impersonation** (audited),
feature-flag toggles, and activity/audit feeds.

---

## 10. Environment Configuration

Server env (Zod-validated, [env.ts](server/src/config/env.ts)):

| Var | Default | Notes |
|---|---|---|
| `DATABASE_URL` | — (required) | PostgreSQL connection string. |
| `JWT_ACCESS_SECRET` | — (required, ≥32) | Access-token signing secret. |
| `JWT_REFRESH_EXPIRES_IN` | `7d` | Refresh-token lifetime (`7d`/`12h`/`30m`). Sets both the DB row's expiry and the cookie Max-Age. There is no refresh *secret*: refresh tokens are random bytes stored SHA-256 hashed, not JWTs. |
| `IMPERSONATION_SECRET` | — (required, ≥32) | Impersonation token secret. |
| `JWT_ACCESS_EXPIRES_IN` | `15m` | |
| `JWT_REFRESH_EXPIRES_IN` | `7d` | |
| `PORT` | `3001` | |
| `NODE_ENV` | `development` | |
| `ALLOWED_ORIGINS` | `http://localhost:3000` | CORS allow-list. |
| `ADMIN_DOMAINS` | `''` | Comma-separated domains allowed to hold `ADMINISTRATOR`. **Empty disables admin login.** |
| `COOKIE_SECURE` | (auto) | Force Secure cookies. |
| `AGENT_URL` | `http://localhost:8001` | AI assistant SSE backend. |
| `REDIS_URL` | (unset) | Cache + rate-limit store + agent lock. Unset ⇒ in-process fallbacks. |
| `TRUST_PROXY` | `loopback` | Upstream trusted for `X-Forwarded-For`. Set to the podman CIDR when containerized. Never `true`. |

Client env: `NEXT_PUBLIC_API_URL` (defaults to `http://localhost:3001`).

---

## 11. Setup, Run, Build, Test

### Server
```bash
cd server
cp .env.example .env          # fill DATABASE_URL, the three secrets, ADMIN_DOMAINS
npm install
npm run db:push               # apply schema to the DB AND generate the Prisma client
npm run db:seed               # (optional) load demo orgs/users/services/tickets
npm run dev                   # tsx watch on http://localhost:3001
# build / test
npm run build                 # tsc
npm test                      # vitest + supertest
```

> **After any `schema.prisma` change, regenerate the client** with
> `npm run db:generate` (or `npm run db:push`). A stale client causes
> TypeScript build errors like *"Property 'chatSession' does not exist"* even
> though the code is correct.

### Client
```bash
cd client
cp .env.example .env.local     # set NEXT_PUBLIC_API_URL if not default
npm install
npm run dev                    # http://localhost:3000
npm run build                  # next build
npm run typecheck              # tsc --noEmit
```

### Tests covered (server)
Tenant isolation, RBAC enforcement, auth flow (register/login/refresh rotation,
weak-password rejection), Zod validation, and impersonation audit trail.

---

## 12. Seed Data & Demo Credentials

`npm run db:seed` wipes and reseeds: 1 internal provider org (Tech) + 12 client
orgs, ~28 users, 49 service subscriptions, 17 sample tickets, feature flags, and
audit logs. (Run from the `server/` directory.)

| Role | Example login | Password |
|---|---|---|
| ADMINISTRATOR | `superadmin@platform.com` / `admin@platform.com` | `SuperAdmin1!` / `SaasAdmin1!` |
| ORG_ADMIN | `jwhitfield@datavault.com`, `dfoster@pinnaclelaw.com`, … | `Admin1234!` |
| USER | `it1@pinnaclelaw.com`, `kokafor@datavault.com`, `ot1@citygrid.io`, … | `User1234!` |

> Admin login requires the seeded admin domain (e.g. `platform.com`) to be present
> in `ADMIN_DOMAINS`. `.env.example` ships `ADMIN_DOMAINS="platform.com"`, but a
> fresh `.env` may omit it — without it, `ADMINISTRATOR` accounts get
> `403 ADMIN_DOMAIN_FORBIDDEN`.

---

## 13. Known Gaps & Notes

These were observed during development/verification and are worth tracking:

- **Seeded tickets predate `createdById`** → they have `createdById: null`. They
  appear in the org-admin "Organization Tickets" view as **"Unknown user"** and
  never show in any user's personal "Your Tickets". New tickets (created via the
  API/UI) are correctly attributed.
- **ORG_ADMIN and ADMINISTRATOR render the same `/dashboard`** — both satisfy
  `isAdmin`, and there is no admin-specific branch on that page. The admin's
  distinct experience lives at `/saas-admin`, not `/dashboard`.
- **Login routes everyone to `/dashboard`** — including ADMINISTRATOR, who must
  click into the Control Plane manually. (Candidate improvement: route admins to
  `/saas-admin` on login.)
- **`ADMIN_DOMAINS` must be set** for any administrator to log in (fail-closed by
  design).
- **Tenant-extension caveat:** `create` and `groupBy` are not auto-scoped —
  always pass `customerId` explicitly on those (as the requests module does).
- **Chat depends on the external Agent** (`AGENT_URL`). If it's offline, the user
  message still persists and the client receives a graceful error; no assistant
  reply is saved.

---

## 14. Quick Endpoint Cheat-Sheet

```
PUBLIC      POST   /api/auth/{register,register-user,login,refresh,logout}

USER+       GET    /api/users/me              PATCH /api/users/me            PATCH /api/users/me/password
            GET    /api/organizations/me      GET   /api/organizations/me/services
            POST   /api/requests              GET   /api/requests            GET  /api/requests/:id
            PATCH  /api/requests/:id/close
            POST   /api/chat                  GET   /api/chat/sessions       GET  /api/chat/sessions/:id
            DELETE /api/chat/sessions/:id

ORG_ADMIN+  GET    /api/users                 POST  /api/users/invite        PATCH /api/users/:id/role
            DELETE /api/users/:id
            PATCH  /api/organizations/me       PATCH /api/organizations/me/security
            GET    /api/requests/org

ADMIN ONLY  /api/saas-admin/* (orgs, admins, impersonate, users, metrics,
            requests, services, customers/:id/services, catalog, flags,
            activity, system-activity, sadmins)
```
