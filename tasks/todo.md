# Tasks: Work-Email Domain Filtration

Plan: [tasks/plan.md](plan.md) · Decision record: [ADR-001](../docs/decisions/ADR-001-work-email-domain-filtration.md)

**Standing rule for every task below:** the block is strict. No env override, no allowlist, no
`ADMIN_DOMAINS` bypass. If an address is on the list, registration refuses it.

---

## Task 1: Shared personal-domain predicate, wired into `deriveDomain()`

**Description:** Create the single source of truth for "this is not a work email" and route the
existing member-signup path through it. `deriveDomain()` currently hard-codes one domain
(`gmail.com`); replacing that check with the shared predicate makes `POST /api/auth/register-user`
reject every listed consumer and disposable provider with the `WORK_EMAIL_REQUIRED` error it
already throws — a complete request → 400 → rendered-message slice with no client change.

**Acceptance criteria:**
- [x] `isPersonalEmailDomain()` returns true for the ~60 listed consumer + disposable domains, false for `acme.com`, and is case- and whitespace-insensitive (`  USER@GMAIL.COM ` → true)
- [x] `POST /api/auth/register-user` with `@outlook.com`, `@yahoo.com`, `@proton.me` or `@mailinator.com` returns `400 WORK_EMAIL_REQUIRED`
- [x] `POST /api/auth/register-user` on a normal company domain is unaffected (still resolves the org and creates the user)

**Verification:**
- [x] Tests pass: `npm --prefix server test -- tests/work-email.test.ts` (DB-backed, same as the rest of the suite)
- [x] Build succeeds: `npm --prefix server run build`
- [x] Manual check: `curl -X POST localhost:3001/api/auth/register-user -H 'Content-Type: application/json' -d '{"name":"Test User","email":"someone@outlook.com","password":"TestPassword1!"}'` → 400 with the "work email" message

**Dependencies:** None

**Files likely touched:**
- `server/src/modules/auth/emailDomains.ts` (new — list + predicate)
- `server/src/modules/auth/auth.service.ts` (`deriveDomain`, ~line 63)
- `server/tests/work-email.test.ts` (new)

**Estimated scope:** Small (2 files + 1 test)

**Notes:** Leave `isProviderAdminEmail()` (`auth.service.ts:70`) alone in this task. It still reads
the raw domain for the *login* path; Task 2 handles the registration side and corrects its comment.

---

## Task 2: Reject personal domains at `POST /api/auth/register`, no exceptions

**Description:** Org signup never rejects a personal address — it just stores `domain: null` on the
new `Customer`. That org is then unjoinable, because `register-user` resolves orgs by domain. Add a
guard at the top of `register()` that throws the same `WORK_EMAIL_REQUIRED` before any write. The
guard runs unconditionally and before any provider-admin logic, so an `ADMIN_DOMAINS`-listed free
domain is rejected like any other.

**Acceptance criteria:**
- [x] `POST /api/auth/register` with a personal-domain email returns `400 WORK_EMAIL_REQUIRED` and creates **no** `Customer` and no `User` row
- [x] The rejection happens before the `isProviderAdminEmail()` branch, so listing a blocked domain in `ADMIN_DOMAINS` does not get past it
- [x] A normal company-domain registration is unchanged (201, `Customer.domain` populated); an `ADMIN_DOMAINS` domain that is not on the block list still self-approves as before

**Verification:**
- [x] Tests pass: `npm --prefix server test -- tests/work-email.test.ts`
- [x] Build succeeds: `npm --prefix server run build`
- [x] Manual check: register an org at `@gmail.com` via the UI → inline error, no org created; confirm with `SELECT count(*) FROM "Customer" WHERE domain IS NULL;` (unchanged from before the attempt)

**Dependencies:** Task 1

**Files likely touched:**
- `server/src/modules/auth/auth.service.ts` (`register` ~line 156, plus the now-wrong comment at lines 73-77)
- `server/tests/work-email.test.ts`

**Estimated scope:** Small (1 file + test additions)

**Notes:**
- The comment at `auth.service.ts:73-77` currently states a provider admin domain *can* be gmail.com. That is no longer true for registration — correct it in this task and cite ADR-001, don't leave it contradicting the code.
- Record the pre-existing `domain IS NULL` count before starting. Backfilling those legacy orgs is **out of scope** — report the number and let the human decide.
- `vitest.config.ts` pins `ADMIN_DOMAINS='example.com'`, which is not on the block list, and `adminDomains` is resolved at module load — so don't try to test the no-bypass rule by mutating env mid-suite. Assert ordering directly instead (blocked domain → 400 regardless).

---

## Checkpoint: Both registration paths filtered

- [x] `npm --prefix server test` — full suite green, no regressions
- [x] `npm --prefix server run build` — clean
- [x] Both endpoints manually exercised against a running API (reject + accept case each)
- [x] Legacy `Customer.domain IS NULL` count reported to the human
- [x] Review with human before proceeding

---

## Task 3: Correct the stale "null for gmail" documentation

**Description:** `FullDoc.md:281` documents the old single-domain behaviour ("Domain is derived from
the email (null for gmail)"), which becomes wrong the moment Task 1 lands. Update it, and record the
`ADMIN_DOMAINS` consequence so nobody bricks a deployment by listing a free-mail domain there.

**Acceptance criteria:**
- [x] `FullDoc.md:281` and the `/register` + `/register-user` rows (`FullDoc.md:184-185`) describe the actual behaviour, naming the `WORK_EMAIL_REQUIRED` error code
- [x] `server/.env.example` states near `ADMIN_DOMAINS` that a free-mail domain listed there will now be rejected at registration, so no admin account can be created on it
- [x] `emailDomains.ts` is named as the place to edit the list, and the docs state there is no runtime override

**Verification:**
- [x] Manual check: `grep -n "null for gmail" FullDoc.md` returns nothing
- [x] No code touched — docs only

**Dependencies:** Tasks 1, 2

**Files likely touched:**
- `FullDoc.md`
- `README.md` (registration section, if it describes the flow)
- `server/.env.example`

**Estimated scope:** XS (1-3 files, docs only)

---

## Checkpoint: Complete

- [x] All acceptance criteria above met
- [x] Full suite green, build clean
- [x] Diff reviewed — no scope creep beyond the two registration endpoints
- [x] Ready for review

---

## Task 4 (DEFERRED — do not start without explicit approval)

**Description:** Apply `isPersonalEmailDomain()` to every remaining path that puts an email on an
account. Verified list, all of which accept any address today:

| Path | Schema | Who |
|---|---|---|
| Invite a member into an org | `users.schema.ts:22` `InviteUserSchema` | Org admin |
| Invite platform staff | `saas-admin.schema.ts:176` `InviteStaffSchema` | Platform staff |
| **Change an existing user's email** | `saas-admin.schema.ts:147` `UpdateUserSchema` | Platform staff |
| **Change a staff member's email** | `saas-admin.schema.ts:186` `UpdateSadminSchema` | Platform staff |

The two edit paths matter more than the invite paths: they let an account created on a valid work
domain be *moved onto* a personal one afterwards, which walks straight around Tasks 1 and 2.

Self-service email change is **not** a hole — `UpdateMeSchema` (`users.schema.ts:6`) has no `email`
field, so a user cannot change their own address.

**Why deferred:** The request scoped this to "application registration". An admin deliberately adding
a contractor on a personal address may be intended behaviour, and silently blocking it is a
behaviour change nobody asked for. Note that with the strict no-bypass rule in Task 2, this is now
the **only** remaining way to onboard anyone on a blocked domain — closing it too means there is no
path at all, which may or may not be what you want.

**Also not covered by Tasks 1-3:** accounts *already* in the database on personal domains keep
working. Login enforces a domain rule only for `ADMINISTRATOR` (`auth.service.ts:608`), so an
existing `USER` or `ORG_ADMIN` on gmail.com signs in exactly as before. Evicting them is a separate
decision — audit the count first.

**Estimated scope:** S (2-3 files) once Task 1 has landed.
