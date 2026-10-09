# 🛡️ Tech — Managed Cybersecurity SaaS Platform

Tech is a production-style, multi-tenant **B2B SaaS** platform for selling and managing **managed cybersecurity services** (SIEM, SOC, EDR, Zero Trust, DLP, and more). It pairs a hardened **Express + Prisma** API with a **Next.js 14** console, serving three audiences from one codebase: end users at client organizations, their organization admins, and the platform provider's administrators (a separate Control Plane).

---

## 🚀 Key Features

*   **👥 Multi-Tenant Isolation**: Every Prisma query is transparently hard-scoped to the caller's organization via a Node `AsyncLocalStorage` context (a custom Prisma client extension), so tenants can never read or mutate each other's data. `create`/`groupBy` are scoped explicitly where the extension can't inject a filter.
*   **🔐 3-Tier Role-Based Access Control (RBAC)**:
    *   `ADMINISTRATOR` — the software provider's super-admin: cross-tenant Control Plane, impersonation, global config, audit feeds. Gated to work-email domains listed in `ADMIN_DOMAINS`.
    *   `ORG_ADMIN` — tenant admin: org-wide ticket overview, user management, org settings, subscribed services.
    *   `USER` — standard member: dashboard, AI assistant, and raising/tracking their own tickets.
*   **✉️ Email MFA on Every Login**: Two-step auth — password first, then a 6-digit code emailed via SMTP. Includes "remember this device" trusted-device cookies (7 days) and strict **single-active-session** enforcement with an idle-takeover window.
*   **🎫 In-App Ticketing Tool**: A full ticketing workflow backed by a dedicated 14-table schema — projects, SLAs (response/resolution clocks), comments, file attachments, watchers, and activity history. Org admins can **escalate** an open ticket to the platform administrators, who work it in an **isolated admin ticket store**.
*   **📨 Support Requests**: Lightweight service-request intake (`/api/requests`) with per-org and per-user views, priorities, and status tracking.
*   **🤖 AI Assistant (persisted)**: A chat assistant proxied over SSE to an external "Analytics Agent"; conversations are persisted in a dedicated chat database. Degrades gracefully (503) when the agent is offline.
*   **📊 Service Catalog & Subscriptions**: A platform master catalog plus per-org subscribed services with monthly pricing, expiry, and automated renewal/expiry states (`ACTIVE` / `EXPIRING` / `EXPIRED`).
*   **💬 Slack Bots**: Administrator-managed Slack bot registry (tokens encrypted at rest, AES-256-GCM), assignable to organizations, with configurable intake forms that create tickets from Slack.
*   **🔑 AD Credential Delivery**: Secure, one-time delivery of encrypted temporary Active Directory credentials tied to a ticket, with view-once semantics.
*   **📣 Announcements**: Platform-wide or per-org broadcasts surfaced in the console.
*   **📝 Audit Trail**: Transaction-scoped recording of platform events (logins, MFA challenges, suspensions, impersonation, plan/role changes) feeding the admin activity console.
*   **⌨️ Command Menu (`Cmd+K` / `Ctrl+K`)**: Keyboard-navigable command center for fast navigation across the console.

---

## 🛠️ Technology Stack

### Client (Frontend)
*   **Framework**: Next.js 14 (App Router + Edge middleware auth gate)
*   **Data Fetching**: TanStack React Query v5 & Axios
*   **Styling**: Tailwind CSS 3 with custom CSS tokens (dark/light slate palette)
*   **Animations**: Framer Motion (glassmorphism, glow micro-animations, animated numeric counters)
*   **Charts / PDF**: Recharts & jsPDF for metrics and exports

### Server (Backend)
*   **Runtime**: Node.js, Express 4, TypeScript (strict)
*   **ORM**: Prisma 5
*   **Databases**: PostgreSQL — separate databases for the core app, chat history, and the ticketing tool (with an optional isolated admin ticket store)
*   **Validation**: Zod (request bodies, query params, and startup env validation)
*   **Auth**: JWT access + refresh tokens in HttpOnly cookies, bcryptjs hashing, email MFA
*   **Security**: helmet, CORS allow-list, express-rate-limit
*   **Email**: Nodemailer / SMTP (MFA codes + password-reset links)
*   **Logging**: winston
*   **Tests**: Vitest + Supertest

---

## 📁 Project Directory Structure

```
B2B-Site/
├── client/                 # Next.js 14 Web Console
│   ├── public/             # Branding + logo assets
│   ├── src/
│   │   ├── app/            # App Router (layouts, providers, routes)
│   │   │   ├── (auth)/     # Login, register, forgot/reset-password, MFA
│   │   │   ├── dashboard/  # Combined user + org-admin dashboard
│   │   │   ├── ticketing/  # In-app ticketing tool (user + admin views)
│   │   │   ├── chat/       # AI assistant with persisted history
│   │   │   ├── saas-admin/ # Control Plane for platform administrators
│   │   │   └── ...         # services, users, profile, credentials, legal
│   │   ├── components/     # UI kit (GlowButton, CommandMenu, Chatbot, Sidebar, …)
│   │   ├── contexts/       # AuthProvider + silent token refresh
│   │   └── lib/            # Axios API wrappers + front-end Zod schemas
│   └── package.json
│
├── server/                 # Express + Prisma API
│   ├── src/
│   │   ├── config/         # DB clients (core/chat/ticketing), env, security, crypto
│   │   ├── middleware/     # Auth, tenant scoping, RBAC, rate limiting, error handler
│   │   ├── modules/        # Domain services:
│   │   │                   #   auth, users, organizations, requests, ticketing,
│   │   │                   #   chat, announcements, bots, slack-bots, ad-secrets,
│   │   │                   #   saas-admin, mail
│   │   ├── app.ts          # Express app: middleware + route mounting
│   │   └── server.ts       # Bootstrap / listen
│   ├── prisma/             # Schema definitions + seed script
│   └── package.json
```

---

## ⚙️ Getting Started

### 1. Prerequisites
Ensure you have **Node.js (v18+)** and **npm** installed, plus a running **PostgreSQL** instance. Email MFA requires reachable **SMTP** credentials (see below) — without them, no one can complete login.

---

### 2. Database & Server Setup
1. Navigate to the server folder:
   ```bash
   cd server
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Configure environment values — copy `.env.example` to `.env` and fill in your database URLs, the three JWT/impersonation secrets, `ADMIN_DOMAINS`, and SMTP settings:
   ```bash
   cp .env.example .env
   ```
4. Generate the Prisma clients (core + chat + ticketing schemas):
   ```bash
   npm run db:generate
   ```
5. Apply the schemas and seed demo orgs, users, services, and tickets:
   ```bash
   npm run db:push
   npm run db:seed
   ```
6. Start the API in watch mode (`http://localhost:3001`):
   ```bash
   npm run dev
   ```

---

### 3. Client Setup
1. In a new terminal, navigate to the client folder:
   ```bash
   cd client
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Configure environment values — copy `.env.example` to `.env` (`NEXT_PUBLIC_API_URL` defaults to `http://localhost:3001`):
   ```bash
   cp .env.example .env
   ```
4. Start the Next.js dev server and open `http://localhost:3000`:
   ```bash
   npm run dev
   ```

---



## 🔒 Security & Exclusions

*   **Tenant Scope Middleware**: `tenantMiddleware` wraps each request in an `AsyncLocalStorage` context that a Prisma client extension reads to auto-inject the `customerId` filter on every scoped query — a user belongs to exactly one organization and cannot reach another's data.
*   **Fail-Closed Admin Gate**: The `ADMINISTRATOR` role is enforced at login and token refresh against `ADMIN_DOMAINS`; an empty list disables admin login entirely.
*   **Work-Email-Only Registration**: Both self-service registration paths reject consumer, free-mail and disposable domains (`400 WORK_EMAIL_REQUIRED`). The list is code-only in `server/src/modules/auth/emailDomains.ts` — no env override and no `ADMIN_DOMAINS` bypass ([ADR-001](docs/decisions/ADR-001-work-email-domain-filtration.md)). It is a first-pass filter, not the boundary: organization approval is what admits a tenant.
*   **CSRF Posture**: there is no CSRF token. Cross-site request forgery is blocked by `sameSite: 'lax'` on the session cookies (`auth.controller.ts` `COOKIE_OPTS`), which stops a third-party origin from making a credentialed POST. This is the *entire* defence — if a cookie is ever relaxed to `sameSite: 'none'` (e.g. to embed the app in an iframe), CSRF tokens become mandatory at the same moment.
*   **Token Hashing**: refresh, reset, verification and trusted-device tokens are 32-64 CSPRNG bytes stored SHA-256 hashed, so redemption is an O(1) indexed lookup. Only passwords use bcrypt. Never store a generated token with a salted KDF — it forces a scan of every row to find one.
*   **Secrets at Rest**: Slack bot tokens/webhooks and delivered AD credentials are encrypted with AES-256-GCM (`SLACK_TOKEN_SECRET`); JWT and impersonation secrets are validated (≥32 chars) at startup.
*   **Robust Gitignores**: Environment files (`.env`, `.env*.local`), TLS keys (`*.pem`, `*.key`), Slack token files (`xapp-*`, `xoxb-*`), and local databases are excluded to prevent credential exposure.
