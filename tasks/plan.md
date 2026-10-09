# Implementation Plan: Work-Email Domain Filtration at Registration

> Decision record: [ADR-001](../docs/decisions/ADR-001-work-email-domain-filtration.md) — why the list is
> static and code-only, and why there is no `ADMIN_DOMAINS` bypass.

## Overview

Registration must reject personal / free-mail / disposable addresses and accept only work-email
domains — **strictly, with no exceptions and no runtime override**. The mechanism is *almost* there
already: it is just one domain wide. `deriveDomain()` in
`server/src/modules/auth/auth.service.ts:63` blocks exactly `gmail.com`; outlook.com, yahoo.com,
proton.me, mailinator.com and every other consumer provider pass straight through. This plan widens
that single predicate and closes the org-signup path, which today does not reject personal
addresses at all.

## Current Behaviour (verified, not assumed)

| Path | Today | Gap |
|---|---|---|
| `POST /api/auth/register-user` (join existing org) | `deriveDomain()` → null → throws `WORK_EMAIL_REQUIRED` (400) | Only catches `gmail.com` |
| `POST /api/auth/register` (new org + first user) | Never rejects. A gmail signup creates a `Customer` with `domain: null` | The real hole — and that org can never be joined, because `register-user` resolves orgs by domain |
| `isProviderAdminEmail()` (`auth.service.ts:70`) | Reads the raw domain so an `ADMIN_DOMAINS` entry may be a free domain | Per decision below, this no longer grants a way past the block |

## Architecture Decisions

1. **One shared predicate, one list.** A new `server/src/modules/auth/emailDomains.ts` exports
   `PERSONAL_EMAIL_DOMAINS` (a `Set`) and `isPersonalEmailDomain(email)`. Every registration path
   routes through it. Fixing the shared function is a smaller diff than a guard per caller, and
   leaves no sibling path still broken.

2. **A static, code-only list.** ~60 well-known consumer + disposable domains. **No env var, no
   allowlist, no admin CRUD table, no DNS/MX lookup, no new npm dependency.** Editing the list is a
   code change and a deploy, by design (user decision, 2026-09-06).

3. **Service-level rejection, not a Zod refinement.** The existing `register-user` path already
   throws `{ status: 400, code: 'WORK_EMAIL_REQUIRED' }`, and both register forms already render
   `response.data.error` (`OrgRegister.tsx:45`, `UserRegister.tsx:43`). Keeping the check in the
   service means **zero client changes** and no 60-domain list duplicated into
   `client/src/lib/schemas.ts`, where it would silently drift.

4. **No `ADMIN_DOMAINS` bypass** (user decision, 2026-09-06). A personal domain is rejected even
   when it is listed in `ADMIN_DOMAINS`. This deliberately reverses the intent recorded in the
   comment at `auth.service.ts:73-77` ("a provider admin domain CAN be gmail.com"), so that comment
   must be corrected as part of Task 2 rather than left contradicting the code. `isProviderAdminEmail()`
   itself is not modified — it keeps reading the raw domain for the login path; the registration
   guard simply runs first and unconditionally.

## Dependency Graph

```
emailDomains.ts  (list + predicate)          ← Task 1, foundation
      │
      ├── deriveDomain()  → /register-user rejects   ← Task 1 (same slice, end-to-end)
      │
      └── register()      → /register rejects        ← Task 2 (needs the predicate)
                │
                └── docs (FullDoc.md / README / .env.example)  ← Task 3
```

No schema change, no migration, no client change. Nothing to parallelize — Task 2 depends on
Task 1's predicate, Task 3 documents both.

## Task List

### Phase 1: Filter the member-signup path
- [ ] Task 1: Shared personal-domain predicate, wired into `deriveDomain()`

### Phase 2: Close the org-signup hole
- [ ] Task 2: Reject personal domains at `POST /api/auth/register`, no exceptions

### Checkpoint: Both registration paths filtered
- [ ] Full server suite green, build clean, both endpoints manually verified

### Phase 3: Docs
- [ ] Task 3: Correct the stale "null for gmail" documentation

### Checkpoint: Complete
- [ ] All acceptance criteria met, ready for review

### Deferred (needs explicit approval — outside the stated scope)
- [ ] Task 4: Apply the same filter to admin-created accounts

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| A real customer legitimately uses a listed domain (small firms on outlook.com do exist) | **High** — a paying signup is turned away | Accepted by decision: strict blocking is the requirement. Recourse is a code edit + deploy, or an admin creating the account manually (Task 4 is deliberately not blocking that path). |
| A deployment with a free-mail domain in `ADMIN_DOMAINS` can no longer create *any* platform admin | **High** on such a deployment | Does not affect this project: `.env.example` ships `platform.com` and its comment already warns against public domains there. Task 3 makes the consequence explicit in `.env.example`. |
| Existing orgs already created with `domain: null` (gmail signups) can never be joined | Med | Pre-existing bug, not caused by this change. Task 2 stops new ones. A backfill is deliberately out of scope — count them first (see Task 2 notes). |
| Blocking gmail at `/register` breaks a test fixture | Low | Verified: every test email is on `example.com`, `b.com`, `acme.com`, `platform.com` or a `.test` domain, and `vitest.config.ts` pins `ADMIN_DOMAINS='example.com'`. Zero collisions with the block list. |
| Now that gmail yields a real domain instead of `null`, two orgs on the same domain collide on the `Customer.domain` unique constraint | Low | They are rejected earlier now, before the insert. Non-blocked duplicate domains already produced `409 CONFLICT` — unchanged. |

## Resolved Decisions

- **Escape hatch / env override:** rejected. Code-only list, no `EXTRA_BLOCKED_DOMAINS`, no allowlist.
- **`ADMIN_DOMAINS` bypass:** rejected. Block applies to everyone, including platform staff.

## Open Questions

1. **Disposable domains: same list or separate?** Currently folded into one list with one error
   message. Separating them only matters if you want distinct copy ("temporary addresses are not
   accepted" vs "please use your work email"). Defaulting to one list unless told otherwise.
2. **Task 4 scope.** Org admins (`users.schema.ts:23`) and platform staff
   (`saas-admin.schema.ts:176`) can create accounts on any address. Filtering those is a 2-line
   change once Task 1 lands, but it is beyond "application registration" — confirm before building.
   Note this is currently the only remaining way to onboard someone on a blocked domain.

## Definition of Done (project-wide, applies to every task)

- `npm --prefix server test` green (no regressions)
- `npm --prefix server run build` clean
- Behaviour verified at runtime against a running API, not just by test
- Docs updated where the change makes them stale
