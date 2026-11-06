# Squid outbound control: protocol and production rollout

This implementation uses HTTPS over TCP 443. There is no custom TCP listener on customer hosts. Each host polls the platform; commands return on the response. The host retains its working Squid policy if the platform or Redis is unavailable.

Source changes are not a deployed installation. Apply the additive migration and install/configure certificates and host software in staging before a production cutover. No database was reset, seeded, or migrated during implementation.

## Application scope

BanihalOrb exposes proxy connection management and ticket-based configuration requests only. Human routes for configuration detail, host-config mirrors, branches, ports, full-access editing, telemetry dashboards, reports, dependency scans, reload/restart/rescan, Squid certificates, backups and factory reset are removed. Agent/worker transport and internal approved-change execution remain. Existing stored policies are preserved; no database cleanup is required.

## Implemented surfaces

- `/squid`: organisation admins select their own proxy; authorised platform staff select client then proxy. Staff can provision a proxy, enroll its certificate, create approval tickets and pause automation. `/clients` links here per organisation.
- Existing platform role editor grants `squid.view`, `squid.manage`, `tickets.write`; `squid.pause.global` separately permits a fleet-wide pause. Employees do not receive these permissions automatically. Granted cross-client permissions cover all clients, as before.
- `/api/squid/:proxyId/change-requests` and `/api/saas-admin/squid/:proxyId/change-requests` create normal task tickets linked to the Squid change ledger. The server resolves ownership. A ticket's human assignee is separate from its proxy target.
- `GET/POST .../:proxyId/automation`, platform `POST /api/saas-admin/squid/clients/:customerId/automation`, and `POST /api/saas-admin/squid/automation/global`. Body: `{ "paused": true, "reason": "Maintenance window" }`. Parent pauses take precedence. Resume revalidates approval/ownership at dispatch.
- `POST /api/saas-admin/squid/:proxyId/machine-identity`: `{ "certificateSha256": "64 hex digits", "enabled": true }`. For a linked worker use `/:proxyId/workers/:botId/machine-identity` instead. Disabled identities reject authentication immediately.
- Legacy `/api/orb` and `/api/squid-web` return 410. Original unfinished Orb source is preserved under `server/legacy/orb/` with `.disabled` extensions. Custom unsupported ticket enums were replaced by ordinary tickets plus the existing change ledger.
- Proxy identities cannot be transferred across clients. Provision a new identity for the receiving client to preserve the original client's rules, credentials and audit history.

## TLS and network boundary

Use `deploy/nginx/squid-machines.conf.example` on a dedicated machine hostname/listener. Replace the hostname, certificate, key, client-CA and CRL paths. Human Nginx templates now reject machine routes and clear machine certificate headers. A machine route must have no weaker alternate ingress.

The API binds to `127.0.0.1` by default. Podman explicitly binds inside its private network; do not publish the API container's backend port. For containers, adapt the machine listener's upstream to the private API DNS name. `TRUST_PROXY` must identify only the actual Nginx peer/network, never all callers.

Nginx verifies client certificates and overwrites `X-Machine-Verified`, `X-Machine-Certificate`, forwarding scheme and forwarding address. The backend checks the immediate upstream against its trusted-proxy function, requires HTTPS, computes SHA-256 from the verified certificate PEM, and matches the enrolled identity. Nginx's built-in fingerprint variable is SHA-1 and is deliberately not used.

Give each agent and worker a distinct certificate. Obtain its public fingerprint with `openssl x509 -in client.pem -noout -fingerprint -sha256`. Provision server trust, client certificates and the bundle public key through a trusted management channel. Never use `curl -k`, disabled hostname checks, browser-stored machine secrets, or a Squid interception CA as a replacement for the intended management trust boundary. Keep management traffic outside SSL interception.

Permit customer outbound HTTPS to the platform plus required DNS/time/CA services. Restrict customer WebUI ingress to the management VPN/admin sources. No inbound agent port is needed. Platform source allowlisting can supplement mTLS when egress addresses are fixed.

Certificate replacement is an explicit enrollment update and takes effect immediately. Install the new certificate/key, update the fingerprint through the authenticated admin API, verify a poll, then revoke the old certificate and reload the CRL. Pause automation during renewal; running Squid continues. This first implementation does not provide automatic certificate issuance or overlapping old/new fingerprint enrollment.

## Signed machine protocol v2

Headers: `X-Machine-Version: 2`, `X-Machine-Nonce: <32–64 lowercase hex>`, and epoch-millisecond timestamp in `X-Proxy-Timestamp` or `X-Worker-Timestamp`. Agents also send `X-Proxy-Id`; worker identity is the bot ID in its URL.

Canonical UTF-8, LF separators, no trailing newline:

```text
B2B-MACHINE-V2
proxy:<proxyId>     (or worker:<botId>)
<timestamp>
<nonce>
<UPPERCASE METHOD>
<original URL path including query>
<lowercase SHA-256 of exact request body bytes>
```

`Authorization: Bearer <HMAC-SHA256 hex>` is keyed by that machine's raw registration/worker secret. The raw secret is never sent as the bearer value. The timestamp skew window is five minutes. After signature/certificate validation, Redis atomically reserves the actor/nonce for 600001ms; duplicate nonces reject with 401 `REPLAY_REJECTED`. Missing replay storage yields retryable 503 and executes nothing.

An enrolled identity requires v2 in every environment. Production rejects unenrolled identities and v1; v1 exists only for unenrolled development compatibility. There is no automatic downgrade. `MACHINE_SECURITY_ENFORCED=true` applies production enrollment checks during staging too.

Each retry has a new nonce/signature. A mutating business request retains its original `requestKey` UUID across retries; changing the payload requires a new key. UI submissions do this automatically. The host worker request schema accepts the same field. A reused key with a different target/payload returns 409.

Agent calls: `GET /api/proxy-agent/poll`, `POST /result`, `POST /telemetry`. V2 bundles include `protocol: 2`, `proxyId`, `seq`, `files`, `signature`, `collection: squid-conf`. Ed25519 signs compact UTF-8 JSON with property order `{protocol,proxyId,seq,files}`; each file has `{path,content}`. The host verifies the pinned public key, proxy ID, revision, path allowlist and size before writing. Successful results contain `{seq,ok:true}`; failed results pause further dispatch for operator inspection. The server marks only matching included requests APPLIED; approvals alone never count as execution.

Backend error codes distinguish authentication (401), ownership (404), invalid input (400), busy/changed requests (409), paused/unavailable control (503), and admission throttling (429). Hosts back off with jitter instead of tight retry loops.

## Host installation

`deploy/squid/agent.py`, `machine_client.py`, `platform_writer.py`, `managed_mode.py`, `worker_executor.py`, and `squid-agent.service` are the host package. Use the WebUI environment's existing `cryptography` and Flask dependencies. Do not run the transport as root. Adapt service user, paths and narrowly allowed parse/reconfigure commands to the installed WebUI's privilege model.

The related local Squid WebUI checkout has received the opt-in integration in `webui-managed.patch` plus `managed_mode.py` and `platform_writer.py`. For other hosts apply that patch to the matching source revision and copy those modules; do not apply a fuzzy patch to an unknown version. Set `PLATFORM_MANAGED=true` in both WebUI and agent service environments only after installation and a staged check.

Managed mode binds the WebUI backend to loopback, blocks local policy/DR/API mutations, suppresses local configuration regeneration/healing, and disables its background scheduler to prevent competing configuration writers. Authentication and read-only pages remain available. Use the BanihalOrb page for policy tickets; offline managed-policy edits are blocked. Existing WebUI branch metadata is not imported into the platform automatically. Review existing policy and import it explicitly before switching ownership. Scheduled local backup/DR jobs must be replaced with an operator-managed schedule if needed.

Example protected `/etc/squid-agent/config.json` (replace placeholders; mode 0600, owned by service user):

```json
{
  "platform_origin": "https://machines.example.internal",
  "proxy_id": "PROVISIONED_PROXY_ID",
  "secret": "ONE_TIME_REGISTRATION_SECRET",
  "ca_file": "/etc/squid-agent/platform-ca.pem",
  "cert_file": "/etc/squid-agent/client.pem",
  "key_file": "/etc/squid-agent/client-key.pem",
  "bundle_public_key": "/etc/squid-agent/bundle-public.pem",
  "state_dir": "/var/lib/squid-platform",
  "managed_dir": "/etc/squid/acls",
  "squid_gid": 13,
  "parse_cmd": ["sudo", "-n", "/usr/sbin/squid", "-k", "parse"],
  "reload_cmd": ["sudo", "-n", "/usr/sbin/squid", "-k", "reconfigure"],
  "health_cmd": ["/usr/bin/systemctl", "is-active", "--quiet", "squid"]
}
```

The group number is illustrative: discover the actual Squid-readable group on the host. The WebUI service user must be able to preserve existing ACL uid/gid/mode and create new ACLs in that group. The writer fails rather than silently changing ownership. Keep state directory private and shared by the WebUI-owned writer and any installed bot executor. Ensure the generated include is present in Squid's configuration at the intended policy position.

The writer journals original content/mode/uid/gid before replacing managed files, validates the installed Squid configuration, reloads and checks service health. Failures restore the journal; rollback failures latch local pause. On restart, an interrupted journal is reconciled before further writes. Unsupported paths and symlinks reject. It does not rewrite vendor Squid configuration or install sudoers rules.

For existing SQUID_BOT hosts, replace the HTTP signing/transport with `MachineClient(..., kind='worker', ...)` and wrap the bot's existing validated apply function with `worker_executor.execute_command(command, config, callback)`. All operations must use the same writer lock. That wrapper deduplicates IDs and refuses to guess after a crash between an external side effect and its durable receipt. The installed bot's own apply/rollback and expiry behavior remains authoritative for its command dialect. Its runtime source is not in this checkout; updating and exercising that installed integration is a staging/deployment requirement, not a completed live verification.

## Overload behavior

Initial safety limits: 30 submissions/client/minute, 100 outstanding requests/proxy, one bundle apply or bot delivery per proxy, and bounded request/response sizes. Nginx rate/concurrency limits protect ingress before expensive authentication. Redis leases renew every 30s and release only their own token; loss returns a retryable failure.

The platform latches an automation pause after three consecutive 30-second samples with load/CPU >=0.85 or memory usage >=90%. These are initial conservative thresholds, not capacity certification; calibrate against the real host. Host agent thresholds are configurable in its protected JSON (`max_load_per_cpu`, `max_memory_fraction`, `max_disk_fraction`), defaulting to 0.85/0.9/0.9. They concern automation resource pressure, not a guarantee against all Squid data-plane overload.

Host overload creates `state_dir/overload-paused` but continues bounded polling. After verifying host capacity and any interrupted journal, an operator removes that file to resume local dispatch. Never delete `apply-journal.json` or `commands.sqlite` to force a retry. Global/client/proxy control pauses persist in PostgreSQL and are resumed through the platform controls. Pauses do not cancel an in-flight safe apply/rollback and do not change the separately existing subscription/network-disable policy.

## Rollout and verification

1. Back up application/configuration and databases through the normal process. Review and apply `server/db/2026-11-06-squid-guardrails.sql` through the deployment workflow; it is also registered in `db/provision.sh`. Do not use reset/push/seed.
2. Set production Redis, dedicated `SQUID_SIGNING_PRIVATE_KEY`, a private backend bind, and exact `TRUST_PROXY`. Production startup requires Redis configuration and a signing key. Bring up the machine Nginx listener with real CA/CRL/certificates and run `nginx -t` before reload.
3. Install the host package and trusted keys, enroll its certificate, test hostname/certificate verification and v2 polling. Test wrong certificate/key pair, tampered body/query, duplicate nonce, revoked/expired cert, Redis outage and unreachable backend port.
4. Confirm initial ownership/import before enabling managed mode; validate Squid parse, normal apply, malformed policy rollback, interrupted apply recovery, duplicate delivery and out-of-order acknowledgements on a disposable host.
5. Exercise organisation and employee permission boundaries, client/proxy selectors, ticket approval/decline, local/global pauses, pause during apply, queue saturation and recovery. Tune load thresholds using representative traffic.
6. Roll out one client at a time. Rollback pauses dispatch and restores source/configuration where protocol-compatible; it must not silently disable certificate verification or nonce enforcement.

Unit/source checks do not establish live host, firewall, Nginx, certificate-provider, database migration, browser or production readiness.
