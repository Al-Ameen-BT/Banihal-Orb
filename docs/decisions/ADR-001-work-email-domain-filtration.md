# ADR-001: Reject personal-email domains at registration with a static, code-only list

## Status

Accepted — implementation pending (see `tasks/plan.md`, `tasks/todo.md`)

## Date

2026-09-06

## Context

Self-service registration accepted any syntactically valid email address. The only domain
restriction was a single hard-coded check in `deriveDomain()`
(`server/src/modules/auth/auth.service.ts`) that treated `gmail.com` as "no domain" — every other
consumer provider (outlook.com, yahoo.com, proton.me) and every disposable service
(mailinator.com, yopmail.com) passed through untouched.

This produced two distinct problems:

1. **`POST /api/auth/register-user`** (join an existing org) rejected only gmail addresses. Its
   error path was already correct — `400 WORK_EMAIL_REQUIRED` — but the predicate feeding it was
   one domain wide.

2. **`POST /api/auth/register`** (create an org + first user) never rejected anything. A gmail
   signup created a `Customer` with `domain: null`. Because `register-user` resolves an
   organization *by domain*, that organization was permanently unjoinable — nobody could ever be
   added to it through self-service.

Constraints that shaped the decision:

- The product is B2B. A registration is meant to represent an employee of a real organization.
- `server/.env.example` already warns that listing a public domain in `ADMIN_DOMAINS` is dangerous,
  because registration grants `ADMINISTRATOR` from the email domain.
- The client (`client/`) is a separate npm package from the server. Anything duplicated across the
  two — as the password policy already is — drifts.
- A human approval gate already exists: `register()` sets `approved: false`, and a staff member
  with `orgs.approve` must admit each new organization via a 6-digit code passed out of band
  (`orgApproval.service.ts`). `register-user` refuses organizations that are not yet approved.

## Decision

1. **A single shared predicate.** `server/src/modules/auth/emailDomains.ts` exports
   `PERSONAL_EMAIL_DOMAINS` (a `Set` of ~60 consumer and disposable domains) and
   `isPersonalEmailDomain(email)`. Both registration paths route through it via `deriveDomain()`.

2. **The list is static and code-only.** No environment variable, no allowlist, no
   database-backed blocklist, no admin UI. Changing the list is a code change and a deploy.

3. **No `ADMIN_DOMAINS` bypass.** A blocked domain is rejected even when it appears in
   `ADMIN_DOMAINS`. The guard runs unconditionally, before any provider-admin branch.

4. **The check lives in the service layer, not in Zod.** It throws the existing
   `{ status: 400, code: 'WORK_EMAIL_REQUIRED' }`, which both registration forms already render.

5. **Scope is registration only.** Admin-created accounts and admin-initiated email changes are
   explicitly *not* covered (see Consequences).

## Alternatives Considered

### Environment-configurable list (`EXTRA_BLOCKED_DOMAINS` / allowlist)

- Pros: an operator can react to a false positive without a deploy; matches the existing
  `ADMIN_DOMAINS` pattern.
- Cons: an allowlist is a bypass by another name, and a bypass that lives in configuration is
  invisible in code review.
- **Rejected** by explicit product decision: the block is to be strict, with no runtime override.

### Keeping the `ADMIN_DOMAINS` bypass

The comment at `auth.service.ts:73-77` documents the *prior* intent — that a provider admin domain
may legitimately be `gmail.com`, and so `isProviderAdminEmail()` deliberately does not consult
`deriveDomain()`.

- Pros: preserves existing behaviour; protects a deployment that listed a free-mail domain in
  `ADMIN_DOMAINS` from losing the ability to create platform admins.
- Cons: it makes `ADMIN_DOMAINS` a de-facto backdoor — adding `gmail.com` there would reopen
  self-service signup on gmail for the highest-privilege role in the system.
- **Rejected.** This ADR supersedes that comment; the comment is to be corrected as part of the
  implementation rather than left contradicting the code.

### MX / DNS record verification

- Pros: catches domains that do not receive mail at all; no list to maintain.
- Cons: every disposable service has valid MX records, so it does not address the actual threat.
  Adds a network round-trip and a new failure mode to the registration path.
- **Rejected**: high cost, does not solve the stated problem.

### An npm package (e.g. `disposable-email-domains`)

- Pros: thousands of domains, maintained externally.
- Cons: a new dependency in the auth path for what a literal `Set` provides; the packages target
  *disposable* addresses specifically and do not cover mainstream consumer providers, which are the
  common case here.
- **Rejected**: a dependency that solves the smaller half of the problem.

### Database-backed blocklist with an admin UI

- Pros: editable at runtime by staff.
- Cons: a table, a migration, CRUD endpoints, permissions, and an interface — for a list that
  changes perhaps twice a year. Also a runtime override, which decision 2 rules out.
- **Rejected**: cost far exceeds the benefit.

### A Zod refinement on `RegisterSchema` with a mirrored client-side list

- Pros: inline field-level error before the request is sent.
- Cons: `client/src/lib/schemas.ts` is a separate package and would need its own copy of the
  ~60-domain list, which would drift from the server's — the server is the trust boundary regardless.
- **Rejected**: the service-level error is already rendered by both forms
  (`OrgRegister.tsx`, `UserRegister.tsx`), so the client needs no change at all.

## Consequences

### Intended

- Both self-service registration paths reject known consumer and disposable domains.
- Organizations can no longer be created with `domain: null`, which closes the unjoinable-org bug.
- No client-side change, and no duplicated list to keep in sync.

### Accepted costs

- **A legitimate small business on a consumer domain is turned away.** Recourse is a code edit and
  a deploy, or manual account creation by an admin. This is accepted, not overlooked.
- **A deployment that lists a free-mail domain in `ADMIN_DOMAINS` can no longer create any platform
  admin account.** This project ships `platform.com`, so it is unaffected; the consequence is
  recorded in `.env.example` so nobody discovers it the hard way.
- **The list goes stale.** Disposable providers rotate domains continuously. This is a speed bump,
  not a wall, and it is not expected to be exhaustive.

### Explicitly out of scope

These paths still accept any address, and are recorded as deferred work rather than oversights:

| Path | Schema |
|---|---|
| Org admin invites a member | `users.schema.ts` `InviteUserSchema` |
| Platform staff invite | `saas-admin.schema.ts` `InviteStaffSchema` |
| Platform staff changes a user's email | `saas-admin.schema.ts` `UpdateUserSchema` |
| Platform staff changes a staff email | `saas-admin.schema.ts` `UpdateSadminSchema` |

The two edit paths can move an account from a valid work domain onto a personal one after
registration, walking around this ADR entirely. Closing them is deferred pending a decision on
whether admins should retain the ability to onboard someone deliberately.

Accounts *already* in the database on personal domains are unaffected and continue to log in —
the login-time domain rule applies only to `ADMINISTRATOR` (`auth.service.ts`, `initiateLogin`).

### What this is not

Domain filtration is a **first-pass filter that reduces reviewer load**. It is not the security
boundary, and should not be invested in as though it were: anyone with a cheap domain and a
catch-all inbox is indistinguishable from a real company to any list-based check.

The boundary that actually establishes legitimacy is the existing **organization approval flow** —
a new org sits `approved: false` until a human admits it with an out-of-band code. Future work
should strengthen that gate rather than chase an exhaustive domain list.
