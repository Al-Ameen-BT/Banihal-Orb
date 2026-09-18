# BT Proxy — DC-DR Replication Runbook (Internal)

**Version 1.13.0** · Banihal Technologies LLP · internal operations runbook.
Not for customer handover.

Keeps a second BT Proxy node (DR) in step with the primary (DC), so that if the
primary is lost, the standby can take over serving clients with the same access
policy. Replication rides the existing DC-DR VPN/ADVPN tunnel.

---

## 1. What replicates, and what does not

**Replicated (policy):** access rules / branches, ports, full-access entries,
the ACL list files, dependency lists, and policy settings — proxy behaviour,
SMTP alert target and toggles, syslog target, AD authentication config, and the
backup schedule.

**Never replicated — each node keeps its own:** users, passwords, MFA secrets,
the TLS certificate and key, `secret.key`, the licence, and node-local settings
(hostname, SSL on/off and cert paths, the AD CA-file path, the syslog *host*,
and the DR configuration itself).

Why the split matters: because identity, accounts and certificates stay
node-local, a compromise or database tamper on one node cannot propagate to the
other, and each node remains independently controllable. It also means **each
node needs its own one-time local setup** (its own admin account, its own MFA
enrolment, its own TLS certificate, and its own licence) before or after joining
replication — those are never copied.

---

## 2. Modes

**Active-Passive (recommended for banks).** One primary, one read-only standby.
The primary pushes config on every change and on a safety-sync timer. The
standby refuses all local config edits — drift is impossible — and shows a
standby banner. Failover is a deliberate, manual promotion. This is the safer
default and the rest of this runbook assumes it unless noted.

**Active-Active.** Both nodes serve clients and accept edits, pushing to each
other. Last change wins per item. Use only if both sites genuinely serve traffic
at once; it can briefly diverge and is harder to reason about during an incident.

---

## 3. Security model

Every transfer is **HMAC-SHA256 signed** with a shared secret that must be
identical on both nodes, and the receiver checks the **sender's IP** against the
configured peer — on top of the encrypted tunnel. Further:

- The receive endpoint returns 404 when replication is disabled (it does not
  reveal itself).
- An active-passive **primary refuses incoming pushes** (only a standby accepts
  them), which prevents split-brain.
- Received config is validated with `squid -k parse` **before** it is applied.
  If validation fails, the node keeps its previous (last-good) config and audits
  the rejection — a standby never breaks itself applying bad config.
- Bundles are path-traversal checked before extraction.

The shared secret is stored encrypted (with each node's `secret.key`). Choose a
long random string (e.g. `openssl rand -hex 32`).

---

## 4. One-time setup

Do the local basics on **each** node first, because they never replicate:

1. Install BT Proxy 1.13.0 on both nodes (fresh install per doc 01, or update
   an existing node).
2. On each node: set its own admin password, enrol MFA, install its own TLS
   certificate (doc 04), and apply its own licence.
3. Confirm the two nodes can reach each other over the DC-DR tunnel on the DR
   port (the app port, default **8800**, or whatever you set):
   ```bash
   # from DC, to DR's tunnel address:
   nc -vz <DR-tunnel-ip> 8800
   ```

Then configure replication. **Settings → DC-DR replication**, on each node:

| Field | Primary (DC) | Standby (DR) |
|---|---|---|
| Enable DC-DR replication | on | on |
| Mode | Active-Passive | Active-Passive |
| This node is | Primary | Standby |
| Peer address | DR's tunnel IP | DC's tunnel IP |
| Peer port | 8800 | 8800 |
| Shared secret | *(same long random string on both)* | *(same)* |
| Safety-sync every | 300s | 300s |
| Verify peer TLS certificate | off if self-signed certs | off if self-signed |

Save on both. The secret is entered once per node; leaving it blank on a later
save keeps the existing one.

**Verify replication is live:**
- On the primary, make a harmless change (add then remove a test domain), or
  click **Sync now → peer**.
- On the primary, Settings → DC-DR shows *Last sync: … pushed to peer: …*.
- On the standby, the same panel shows *received: config applied and Squid
  reloaded*, and the test change appears in its rules.
- On the standby, confirm the read-only banner is shown and that config pages
  refuse edits.

> If the primary's status shows `push FAILED`, check: the tunnel is up, the DR
> port is reachable, the shared secret matches exactly on both nodes, and the
> standby has replication enabled. The primary's audit log records each
> `dr-push` / `dr-push-fail`.

---

## 5. Routine operation

- Make all changes on the **primary**. They push to the standby automatically,
  and the safety-sync timer re-pushes the full config periodically so a change
  made while the tunnel was briefly down is still caught.
- The standby serves nothing to administrators except its own login, the DR
  panel, and account self-service; its policy is whatever the primary last sent.
- Keep each node's **licence** and **TLS certificate** current independently —
  they do not replicate, and an expired cert or licence on the standby will
  surface only when you fail over to it. Check both nodes during maintenance.

---

## 6. Failover drill (practise this before you need it)

Run this as a scheduled drill, ideally in a maintenance window, so the team has
done it once for real.

1. **Announce** a short maintenance window; failover is manual and quick but
   involves a client cutover.
2. **Simulate primary loss** — stop the service on the primary (or it is already
   down in a real incident):
   ```bash
   sudo systemctl stop squid-webgui squid
   ```
3. **Promote the standby.** On the DR node: Settings → DC-DR replication →
   **Become primary** → type `PROMOTE` → confirm. The node's role changes to
   primary, config becomes editable, and it can push.
4. **Cut client traffic to DR.** Point the branches' proxy setting (or the WPAD/
   PAC, or the tunnel route) at the DR node's address. This is the step that
   actually moves users; promotion alone does not redirect clients.
5. **Verify** clients are browsing through DR and that whitelisted sites work:
   ```bash
   # on DR:
   sudo tail -f /var/log/squid/access.log
   ```
6. **Record** the drill result and the time taken.

To end the drill cleanly, follow the fail-back procedure below rather than just
restarting the old primary — otherwise you risk two primaries.

---

## 7. Fail-back (returning to the original primary)

**Order matters — never have two primaries pushing at once.**

1. Bring the original primary's host back up, but **leave BT Proxy stopped** for
   now:
   ```bash
   # on the original primary, if it auto-started:
   sudo systemctl stop squid-webgui
   ```
2. On the original primary, open Settings → DC-DR replication and set **This
   node is → Standby**, Save. It is now a read-only standby and will not push.
3. Start it:
   ```bash
   sudo systemctl start squid-webgui
   ```
4. On the **current** primary (the DR node that took over), click **Sync now →
   peer**. This copies any changes made during the incident down to the original
   node, which is now the standby.
5. Confirm on the original node that its rules match and its DR panel shows
   *received*.
6. **Choose your steady state:**
   - *Simplest:* leave DR as the active primary and the original node as
     standby. Roles are just labels; nothing requires the original to be
     primary again.
   - *Return to original:* schedule a second short window and repeat the
     promote/cutover in reverse — promote the original node, set the DR node
     back to standby, and move client traffic back. Do the role change on the
     DR node (set it to standby) **before** promoting the original, so there is
     never a moment with two primaries.

---

## 8. Split-brain: avoid it

Two nodes both in the **primary** role, both pushing, will overwrite each
other's config and diverge. BT Proxy guards against this — a primary refuses
incoming pushes, and there is no automatic promotion — but the operator can
still create it by manually setting both to primary. The rule:

> Exactly one node is primary at any time. Before promoting a node, ensure the
> other is either offline or set to standby.

If you suspect split-brain (both editable, configs disagree): pick the node with
the correct/newer config, set the other to **standby**, then **Sync now** from
the good node to overwrite the standby.

---

## 9. Quick reference

| Action | Where | How |
|---|---|---|
| Enable replication | Settings → DC-DR | tick enable, set role/peer/secret, Save |
| Force a sync now | Settings → DC-DR (primary) | **Sync now → peer** |
| Promote standby | Settings → DC-DR (standby) | **Become primary**, type `PROMOTE` |
| Demote a node | Settings → DC-DR | set **This node is → Standby**, Save |
| Check last sync | Settings → DC-DR | *Last sync* line |
| Audit trail | Logs | actions `dr-push`, `dr-apply`, `dr-promote`, `dr-reject` |

**DR port:** the web app's own port (default 8800) — the receive endpoint is served inline by the app, not a separate listener. A node's *peer port* is the OTHER node's app port.
**Never replicated:** users, MFA, certificates, licence, hostname, SSL paths.
**Golden rule:** one primary at a time; validate the tunnel and the shared
secret first when a sync fails.
