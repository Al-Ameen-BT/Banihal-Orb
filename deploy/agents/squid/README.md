# Squid outbound proxy — agent deployment

The platform renders a per-org Squid ACL config and signs it (Ed25519). A small
agent installed on each proxy host pulls it, verifies it, validates it with
`Squid -k parse`, applies it with `Squid -k reconfigure`, and acks the result.
The host needs **no inbound ports** — only outbound HTTPS to the platform.

## Flow

```
platform (squid module) ──revision bump──▶ agent polls
        ▲   GET /api/proxy-agent/poll        │ HMAC-SHA256 signed headers,
        │   POST /api/proxy-agent/result     │ X-Proxy-Id + pk_… key (0600)
        └────────────────────────────────────┘
agent: verify bundle Ed25519 → write /etc/squid/acls/*.conf
       → squid -k parse → squid -k reconfigure → ack {seq, ok}
```

- Every config change on the platform bumps the proxy `revision`. The agent
  acks with `appliedSeq`; the platform only sequences forward.
- Bundles are only applied if signature verification passes. If `SQUID_PUBKEY`
  is not pinned, the agent **refuses** to apply (safety first) — pin it at
  install from the platform's `GET /api/proxy-agent/public-key` (or the
  org-facing Squid page → Install & keys).
- Repeated bad auth disables the proxy on the platform side and notifies the
  org admins.

## Install (on each proxy host)

```bash
sudo ./install.sh https://sso.example.com <proxy-id> '<pk_…KEY>' bundle.pub
```

The registration key is shown **once** in the platform UI. Assign a
kind=SQUID_PROXY catalog service (staff console) to mint one automatically, or
rotate an existing proxy's key to re-view it.

## Ops

- `journalctl -u squid-agent.service -f`
- Rotate the key from the platform UI → write the new key to
  `/etc/squid-agent/key` (mode 0600) → `systemctl restart squid-agent.service`.
- The agent logs to `/var/log/squid-agent.log` and every ack/failure surfaces
  on the platform console (status CONNECTED / ERROR, lastError).

## Hardening notes

- The HMAC key (per-proxy `pk_…`) is the identity boundary. For transit/turn
  hardening pin the agent TLS + client cert at /api/proxy-agent (nginx
  `ssl_verify_client`) — the HMAC scheme is transport-agnostic and keeps working
  under mTLS unchanged.
- The agent uses no shell interpolation for file paths (fixed names only) and
  `Squid -k parse` gates every apply; a config that fails to parse never reaches
  a live squid.