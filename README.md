# 🛡️ Tech — Managed Cybersecurity Platform

Tech is a premium, multi-tenant B2B SaaS cybersecurity operations and client management platform designed for Managed Security Service Providers (MSSPs). It empowers platform administrators and client organization admins to manage active threat intelligence feeds, incident response tickets, endpoint protection subscriptions, compliance metrics, and tenant-level system configurations.

---

## 🚀 Key Features

*   **👥 Multi-Tenant Architecture & Isolation**: Strict workspace boundary isolation using custom Prisma request contexts, ensuring tenants can never access or query each other's data.
*   **🔐 3-Tier Role-Based Access Control (RBAC)**:
    *   `SAAS_ADMIN` (Super Admin): Full Control Plane visibility, cross-tenant impersonation, global system configuration, and audit logs.
    *   `ORG_ADMIN` (Tenant Admin): Control over organization settings, active cybersecurity subscriptions, billing history, and team invites.
    *   `USER` (Standard Analyst): Access to the security dashboard, AI threat assistant, and incident support ticket filing.
*   **📊 Cybersecurity Subscriptions Catalog**: Real-time tracking of premium security products including **SIEM**, **SOC-as-a-Service**, **Endpoint Detection & Response (EDR)**, **Threat Intel**, **Zero Trust Access**, and **Compliance Monitoring** with automated renewal alerts.
*   **📝 Audit Trail Logging & Compliance**: Automatic, transaction-scoped compliance recording of platform events (such as logins, tenant suspensions, cross-tenant impersonation, and plan changes).
*   **⌨️ Command Menu (`Cmd+K` / `Ctrl+K`)**: Power-user keyboard-navigable command center for ultra-fast navigation across the dashboard, support portals, and administrative views.
*   **🤖 AI Threat Assistant**: Custom integrated virtual assistant to guide security analysts and respond to threat vectors.

---

## 🛠️ Technology Stack

### Client (Frontend)
*   **Framework**: Next.js 14 (App Router & Server-Side Middleware security)
*   **Data Fetching**: `@tanstack/react-query` & `Axios`
*   **Styling**: Tailwind CSS & custom Vanilla CSS tokens (harmonious dark/light slate palette)
*   **Animations**: `framer-motion` (premium glassmorphism, glowing custom micro-animations, and animated numeric dashboards)
*   **Charts**: `recharts` for visual contract value and incident metrics

### Server (Backend)
*   **Runtime**: Node.js, Express, and TypeScript
*   **ORM**: Prisma ORM
*   **Database**: PostgreSQL
*   **Security**: `helmet` header protection, cookies-based JWT authentication, CORS limits, and `express-rate-limit`

---

## 📁 Project Directory Structure

```
B2B-Site/
├── client/                 # Next.js 14 Web Application
│   ├── public/             # Serves branding logo assets (/Alert.png, /banihal-logo.png)
│   ├── src/
│   │   ├── app/            # Next.js App Router (Globals, Layouts, Providers, Routes)
│   │   │   ├── (auth)/     # Auth Route Groups (tab-driven /login and /register)
│   │   │   ├── dashboard/  # B2B Analyst & Executive Dashboard
│   │   │   ├── saas-admin/ # Control Plane for Platform Super Admins
│   │   │   └── ...         # Service Catalogs, Support Incidents, Users
│   │   ├── components/     # UI Kit (GlowButton, GlassCard, CommandMenu, Chatbot, Sidebar)
│   │   ├── contexts/       # React Contexts (AuthProvider & silent refresh)
│   │   └── lib/            # Axios API wrappers and front-end Zod schemas
│   └── package.json
│
├── server/                 # Express.js API Gateway
│   ├── src/
│   │   ├── config/         # Database pooling & CORS configurations
│   │   ├── middleware/     # Tenant scoping, auth middleware, RBAC checks, rate limiters
│   │   ├── modules/        # Domain Services (Auth, Users, Orgs, Dashboard, SaaS Admin)
│   │   └── server.ts       # Express entry point
│   ├── prisma/             # Prisma Schema definitions & sandbox Seed scripts
│   └── package.json
```

---

## ⚙️ Getting Started

### 1. Prerequisites
Ensure you have **Node.js (v18+)** and **npm** installed locally. A running **PostgreSQL** instance is required for the database layer.

---

### 2. Database & Server Setup
1. Open a terminal and navigate to the server folder:
   ```bash
   cd server
   ```
2. Install server dependencies:
   ```bash
   npm install
   ```
3. Configure your environmental values:
   Copy `.env.example` to `.env` and fill in your database connection string and JWT keys:
   ```bash
   cp .env.example .env
   ```
4. Generate the database client:
   ```bash
   npm run db:generate
   ```
5. Apply migrations and seed the database sandbox with premium client records:
   ```bash
   npm run db:push
   npm run db:seed
   ```
6. Spin up the Express watcher in development mode:
   ```bash
   npm run dev
   ```

---

### 3. Client Setup
1. Open a new terminal and navigate to the client folder:
   ```bash
   cd client
   ```
2. Install client dependencies:
   ```bash
   npm install
   ```
3. Configure your environmental values:
   Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```
4. Start the local Next.js development server:
   ```bash
   npm run dev
   ```
   Open your browser and navigate to `http://localhost:3000`.

---

## 🧪 Seeding & Test Credentials

The database seed script configures several realistic client sandbox companies:
*   **Tech Platform Administration** (Internal SaaS Org):
    *   *Super Admin*: `admin@platform.com` (Password: `SaasAdmin1!`)
*   **Enterprise Clients** (All Org Admins use password: `Admin1234!`):
    *   `jwhitfield@datavault.com` — **DataVault Banking** (Enterprise plan, $210K ARR, SIEM active, critical lateral threat incident in progress)
    *   `rtorres@orbital.aero` — **Orbital Aerospace** (Enterprise plan, $180K ARR, Zero Trust v2.0 Beta active)
    *   `skim@medcure.health` — **MedCure Health Systems** (Enterprise plan, $95K ARR, HIPAA compliance active, expired EDR subscription)
*   **Analyst Accounts** (All standard users use password: `User1234!`):
    *   `kokafor@datavault.com`
    *   `ot1@citygrid.io`

---

## 🔒 Security & Exclusions

*   **Tenant Scope Middleware**: Every database query is dynamically intercepted on the server by the `tenantMiddleware` which wraps Prisma in a Node `AsyncLocalStorage` context. A user belongs to *exactly one* organization, and database operations are automatically hard-scoped to `organizationId`.
*   **Robust Gitignores**: Environment configurations (`.env.*.local`, `.env*.local`), TLS private key files (`*.pem`, `*.key`), and local test databases are explicitly blacklisted in both `.gitignore` configurations to prevent credential exposure.
