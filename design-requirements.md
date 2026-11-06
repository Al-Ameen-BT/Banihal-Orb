# Secured API Mechanism Design: Banihal Orb ↔ Squid Proxy

## Overview
This document defines the API mechanism for secure communication between the Banihal orb application and the Squid proxy infrastructure, addressing the "hell of work" current Slack bot flow.

---

## 1. API Key Infrastructure (Two-Key Model)

### 1.1 Key Pair Design
Two distinct API key types are required:

**Key Type A: Proxy Side Key** (generated on the Squid proxy infrastructure)
- Format: `btp_<12-hex-prefix>_<43-char-secret>` (identical to existing squid API)
- Scope: `squid:config:write` (new scope, additive to existing infrastructure)
- Purpose: Allows the Banihal orb to apply config changes to THIS specific proxy
- Storage: Scrypt-hashed in the platform's DB, per-organization row
- Lifetime: Configurable expiration (`expires_at`), revocable
- **Security**: Compromise affects only the specific org's proxy; rotation possible

**Key Type B: Banihal Orb Key** (generated in platform, provided to orb)
- Format: `ort_<16-hex-prefix>_<32-char-secret>` (new format, distinguishable)
- Scope: `banihal:orb-communication` (restricted to orb↔proxy messaging)
- Purpose: Authenticates the Banihal orb to the platform; proves orb identity
- Storage: AES-256-GCM encrypted (pattern from `slackCrypto.ts`), master key `ORB_TOKEN_SECRET`
- Lifetime: Longer-lived (orb deployment lifetime), rotation via admin UI
- **Security**: Compromise allows impersonation of orb but NOT proxy access without Key Type A

### 1.2 Key Assignment Flow
```
1. Platform Admin generates Proxy Key on "/saas-admin/proxies/[org-id]" page
2. Key is stored scoped to that organization (tenant-scoped via existing middleware)
3. Platform provides the key's prefix (12 hex chars) to the org
4. Org configures the key on their Squid proxy side
5. Banihal Orb requests its key from platform (org admin only)
6. Platform generates Orb Key, stores encrypted, provides to orb via secure channel
7. Orb presents Orb Key when connecting to platform API
8. Platform validates Orb Key → looks up associated org → validates Proxy Key from that org
```

### 1.3 Key Validation Sequence (per request)
```
Request arrives at platform API
│
├─→ Check Authorization: Bearer <orb-key> OR X-Orb-Key: <orb-key>
│   └─→ Validate Orb Key format, check enabled/expired, decode via AES-256-GCM
│
├─→ Verify Orb Key belongs to Organization X
│
├─→ Check for Proxy Key in request headers: X-Proxy-Key: <btp-key>
│   └─→ Validate Proxy Key: prefix lookup → scrypt hash check → scope check
│
├─→ Verify Org matches: Orb Key → Org → Proxy Key must belong to same Org
│
└─→ Proceed to request validation if both keys valid
```

---

## 2. API Endpoint: `POST /api/orb/squid/apply-change`

### 2.1 Request Body (matches SquidChangeRequest)
```json
{
  "action": "allow",           // enum: "allow" | "deny" | "extend" | "full-net" | "lock-net"
  "target": "domain",          // enum: "domain" | "ip" | "subnet"
  "value": ["example.com"],    // array of domains or IPs (max 100 entries)
  "reason": "Banihal orb request for proxy config update",  // optional string
  "executionPath": "bundle",   // enum: "bundle" | "agent_command"

  // Assignee validation - must be a registered squid bot for this org
  "assigneeId": "wrk_...",     // worker instance ID (squid bot assigned to org)

  // Requester validation - must be org employee/admin
  "requesterId": "usr_...",    // platform user ID (employee or administrator)

  // Idempotency (optional but recommended)
  "idempotencyKey": "unique-key-for-dedup"
}
```

### 2.2 Required Zod Schema (TypeScript)
```typescript
import { z } from 'zod';

export const ChangeActionEnum = z.enum(['allow', 'deny', 'extend', 'full-net', 'lock-net']);
export const TargetEnum = z.enum(['domain', 'ip', 'subnet']);

export const SquidChangeRequestSchema = z.object({
  action: ChangeActionEnum,
  target: TargetEnum,
  value: z.array(z.string().trim().min(1).max(255)).max(100),
  reason: z.string().trim().max(2000).optional(),
  executionPath: z.enum(['bundle', 'agent_command']),

  // Assignee: must be a wrk_ key belonging to the authenticated org
  assigneeId: z.string().regex(/^wrk_[A-Za-z0-9]+$/, 'Invalid squid bot assignee ID'),

  // Requester: must be a platform user (employee or admin)
  requesterId: z.string().regex(/^usr_[A-Za-z0-9]+$/, 'Invalid requester ID'),

  // Idempotency key for dedup
  idempotencyKey: z.string().uuid().optional(),
});

// Internal validation: cross-check assignee belongs to org
// (done in controller, not schema - see below)
```

### 2.3 Response Format
```json
{
  "ticketId": "uuid",          // ticket created in ticketing system
  "status": "pending_approval",// or "in_progress" if executionPath=agent_command + immediate apply
  "changeRequestId": "uuid",   // SquidChangeRequest row ID
  "dryRunPreview": {           // if dry_run=true was sent
    "would_change": ["example.com"],
    "rejected": [],
    "note": "Dry run - no changes applied"
  },
  "message": "Change request created. Ticket pending approval."
}
```

---

## 3. Ticketing Integration

### 3.1 Ticket Creation (internal platform ticketing)
**Endpoint:** `POST /api/tickets` (or internal service call)

**Minimal Required Fields:**
```json
{
  "title": "Squid config change request - example.com whitelist",
  "description": "Banihal orb requested allow domain example.com via orb/squid/apply-change",
  "type": "squid-config-change",
  "status": "todo",
  "priority": "medium",
  "labels": ["pending:approval", "squid:config-change"],
  "assigneeId": "bot-persona-for-org",  // the squid bot assigned to this org
  "projectId": "proj-for-proxy-management",
  "orgCustomerId": "org-cuid"           // tenant scoping
}
```

**Additional Fields (populated by system):**
- `changeRequestJson`: JSONB field storing the full SquidChangeRequest payload
- `requesterId`: ID of the platform user who initiated the request
- `proxyKeyPrefix`: prefix of the validated proxy key (for audit)

### 3.2 Status Flow
```
pending_proxy_config  (initial, created by API)
    ↓
in_progress           (after approval by org admin)
    ↓
completed             (after config applied to squid)
    ↓
failed                (if squid parse/reconfigure failed)
```

### 3.3 Label Pattern (existing convention)
- `pending:approval` - automatic, stays until approved
- `squid:config-change` - identifies this as our feature's tickets
- `org:...` - existing org scoping label pattern

---

## 4. Approval → Execution Lifecycle

### 4.1 Lifecycle Hook (existing pattern from Phase B plan)
The platform's `ticketing.service.ts` already supports `registerOnTicketApproved(fn)`.

**Registration (at platform bootstrap):**
```typescript
// server/src/modules/squid/squid.service.ts (bootstrap)
import { registerOnTicketApproved } from './ticketing.service';
registerOnTicketApproved(executeSquidChange);
```

### 4.2 Executor Function (`executeSquidChange`)
When a ticket with `labels: ['pending:approval', 'squid:config-change']` is approved:

```typescript
async function executeSquidChange(ticketDto: TicketDTO) {
  const changeRequest = ticketDto.changeRequestJson;

  // Idempotency guard: if already executed, skip
  if (ticketDto.executedAt) return;

  let success: boolean;
  let result: any;

  if (changeRequest.executionPath === 'bundle') {
    // Bundle path: mutate ACL branches, bump revision
    success = await applyBundleChange(changeRequest);
    result = { path: 'bundle', appliedSeq: ... };
  } else if (changeRequest.executionPath === 'agent_command') {
    // Agent command path: enqueue command to squid agent
    success = await enqueueAgentCommand(changeRequest);
    result = { path: 'agent_command', commandId: ... };
  }

  // Update ticket atomically
  await ticketService.update(ticketDto.id, {
    status: success ? 'completed' : 'failed',
    executedAt: new Date(),
    result: success ? "Applied successfully" : result.detail,
    labels: success ? removePendingApproval : addDeclinedReason
  });

  // Audit
  await auditService.log({
    action: success ? 'SQUID_CONFIG_APPLIED' : 'SQUID_CONFIG_FAILED',
    detail: `ticketId=${ticketDto.id}, executionPath=${changeRequest.executionPath}`,
    via: 'orb-api'
  });

  // Webhook notification (if configured)
  await notifyOrbOfStatus(ticketDto.id, success);
}
```

### 4.3 Webhook Events to Banihal Orb
On ticket status change, platform pushes to orb's registered webhook:
```http
POST https://banihal-orb/webhook/squid-status
X-Webhook-Event: squid.change_status
X-Webhook-Signature: sha256=<hmac>
{
  "eventId": "evt-...",
  "type": "squid.change_status",
  "keyId": "orb-key-prefix...",
  "triggeredAt": "2026-..."",
  "data": {
    "ticketId": "uuid",
    "status": "completed|failed",
    "changeRequestId": "uuid",
    "executionPath": "bundle|agent_command"
  }
}
```

**Orb verifies signature** using the shared webhook signing secret (set up during orb registration).

---

## 5. Organization Isolation & Key Assignment

### 5.1 Per-Org Proxy Key Storage
- Each organization row in the DB has a `proxyApiKeyPrefix` field (12 hex chars)
- Or `proxyApiKeyHash` field (scrypt hash of full key)
- When a key is generated, the prefix is stored; the secret is never stored (only hash)
- Orgs retrieve their prefix from the UI, configure it on their proxy

### 5.2 Orb Key per Organization
- One Orb Key per organization (many orbs possible, but one typically)
- Orb Key is linked to the organization row: `orbKeyEncrypted` + `orbKeySalt`
- Orb must present its key with every API request

### 5.3 Validation Flow (detailed)
```
POST /api/orb/squid/apply-change
Authorization: Bearer <orb-key>

1. Validate Orb Key:
   - Decrypt using ORB_TOKEN_SECRET + per-orb salt
   - Check enabled/expired status
   - Extract org_id from decrypted payload

2. Look up org by org_id
   - If not found → 404
   - If org has no proxy key configured → 403 "No proxy key for your organization"

3. Check Request Headers:
   - X-Proxy-Key: btp_<prefix>_<secret>
   - Validate prefix matches org's configured proxy key prefix
   - Verify scrypt hash of full key

4. Cross-org guard:
   - If orb_key.org_id ≠ proxy_key.org_id → 403 "Key belongs to different organization"

5. Proceed with request validation
```

---

## 6. Security Hardening

### 6.1 API Key Public Exposure Prevention
**Risk:** If the Proxy Key `btp_...` becomes public, anyone can modify that org's squid config.

**Mitigations:**
1. **Short-lived keys**: API keys have `expires_at`; rotation procedure documented
2. **Key rotation**: Admins can generate new keys; old keys deprecated after grace period
3. **Scope restriction**: `squid:config:write` scope only; cannot access `fullaccess:write` without separate key
4. **IP binding (optional)**: Proxy keys can be bound to specific source IPs (future enhancement)
5. **Audit all actions**: Every change records `via: 'orb-api', key_prefix: 'btp_abcd12...'`
6. **HSTS + HTTPS only**: `API_REQUIRE_HTTPS` enforced (existing config)
7. **Rate limiting per key**: Token bucket per key (existing `api_v1.py` pattern)

### 6.2 Assignee/Requester Validation (tampering prevention)
**Risk:** User forges assigneeId or requesterId to escalate privileges.

**Mitigations:**
1. **Orb key decrypts org context**: The validated Orb Key proves which organization is making the request
2. **Assignee must belong to org**: Controller validates `assigneeId` (wrk_ pattern) belongs to squid bots assigned to that org
3. **Requester must be active user**: `requesterId` validated against platform user DB, must have `EMPLOYEE` or `ADMIN` role
4. **Least privilege**: Ticket created with `assigneeId` = the squid bot persona for that org (not arbitrary user)
5. **No user-enumeration**: Invalid IDs return generic 400, not "user not found" or "org not found"
6. **Idempotency key**: Prevents duplicate requests from same orb key within window

### 6.3 Input Validation (defense in depth)
**Domain/IP validation** reuses existing `policy_service.py` validators:
- `DOMAIN_RE` regex for domain format
- `net.isIP()` for IP validation
- No CIDR allowed in target fields (single IPs/domains only)
- Max 100 entries per request (same as `MAX_ENTRIES_PER_CALL`)

### 6.4 Audit Trail (non-repudiation)
Every request produces audit entries:
```
api-orb-squid-change-request  {ticketId, orgId, keyPrefix, action, target, value}
api-orb-squid-change-approved   {ticketId, orgId, approver}
api-orb-squid-change-executed   {ticketId, orgId, executionPath, result}
api-orb-squid-change-failed     {ticketId, orgId, errorDetail}
```

All reach the same SQLite audit table + syslog + email alerts (same path as existing squid API).

---

## 7. Deployment Checklist

### 7.1 Platform Changes
- [ ] Add `squid:config:write` scope to key management UI
- [ ] Implement Orb Key generation + AES-256-GCM storage
- [ ] Add `X-Orb-Key` / `Authorization: Bearer` validation middleware
- [ ] Add `X-Proxy-Key` validation middleware (prefix + hash check)
- [ ] Add org-proxy key assignment UI (per-org)
- [ ] Create `POST /api/orb/squid/apply-change` endpoint
- [ ] Extend ticketing schema: `changeRequestJson` JSONB field, new statuses
- [ ] Register `executeSquidChange` lifecycle hook in `ticketing.service.ts`
- [ ] Add webhook event: `squid.change_status` with signature verification
- [ ] Update rate limit configs per key type

### 7.2 Squid Proxy Side
- [ ] Orgs configure their `btp_` key on their proxy instances
- [ ] Proxy keys stored locally (same as existing squid API pattern)
- [ ] No code changes needed on proxy if using existing `api_v1.py` patterns
- [ ] Or: new Express endpoint `POST /api/squid/apply-change` if orb communicates with Node server

### 7.3 Banihal Orb Application
- [ ] Implement Orb Key storage (AES-256-GCM, never in source code)
- [ ] Present Orb Key with every API request (`X-Orb-Key` header)
- [ ] Present Proxy Key (`X-Proxy-Key` header)
- [ ] Handle webhook events from platform (`squid.change_status`)
- [ ] Poll ticket status as fallback if webhooks missed
- [ ] Display ticket status in UI (created → approved → completed/failed)
- [ ] Support idempotency key resubmission on retry

### 7.4 Documentation
- [ ] API specification (OpenAPI format) for `/api/orb/squid/apply-change`
- [ ] Key generation and rotation procedures
- [ ] Webhook event format and verification
- [ ] Error code catalog (VALIDATION_ERROR, INSUFFICIENT_SCOPE, ORG_NOT_ALLOWED, etc.)
- [ ] Security considerations document

---

## 8. Error Code Catalog

| Code | HTTP | Meaning |
|------|------|---------|
| `VALIDATION_ERROR` | 400 | Bad request body - `details` describes offending field(s) |
| `INSUFFICIENT_SCOPE` | 403 | Orb key or proxy key lacks `squid:config:write` |
| `ORG_NOT_ALLOWED` | 403 | Proxy key belongs to different organization |
| `KEY_DISABLED` | 403 | Orb key or proxy key is disabled/expired |
| `RATE_LIMIT_EXCEEDED` | 429 | Per-key rate limit exceeded |
| `MALFORMED_REQUEST` | 400 | Request body fails Zod validation |
| `IDEMPOTENCY_KEY_DUP` | 409 | Duplicate idempotency key detected |
| `TICKET_CREATION_FAILED` | 500 | Internal error creating ticket |
| `SQUID_APPLY_FAILED` | 502 | Squid config apply failed (parse or reconfigure) |

---

## 9. Migration Path from Current Slack Bot Flow

**Current:** Slack command → approval card → ticket → squid agent → config update

**New Flow (Orb API):**
```
Banihal Orb → POST /api/orb/squid/apply-change (with two keys)
    ↓
Platform validates both keys (orb + proxy, same org)
    ↓
Platform creates ticket with `pending:approval` + `squid:config-change` labels
    ↓
Ticket posted to approval channel (Slack or web UI)
    ↓
Org admin clicks Approve
    ↓
Platform executes change (bundle path or agent command path)
    ↓
Platform updates ticket status (completed/failed)
    ↓
Platform sends webhook to orb: status updated
    ↓
Orb UI shows confirmation to user
```

**Benefits:**
- Direct API-driven flow (no Slack dependency for every change)
- Two-key security model (orb identity + org proxy association)
- Audit trail with full non-repudiation
- Organization isolation enforced at API gateway
- Idempotent operations via idempotency keys
- Webhook-based status updates (real-time)

---

*Design generated based on codebase analysis of:*
- Existing squid API v1 (`squid/squid-webgui/api_v1.py`)
- Ticketing system (`server/src/modules/ticketing/`)
- Bot worker patterns (`server/src/modules/slack-bots/`)
- Phase B plan (`tasks/plan-squid-bot-worker.md`)
- Existing security mechanisms (scrypt hashing, HMAC, tenant scoping)
