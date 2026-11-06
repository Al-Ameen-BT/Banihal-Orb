# Retired Orb prototype

These `.disabled` source files preserve the unfinished working-tree prototype from before the outbound guardrails implementation. They are excluded from the active TypeScript source tree and runtime. `/api/orb` and `/api/squid-web` return 410.

The prototype used unsupported ticket fields/types and did not establish a database-backed machine identity. Do not mount it. Proxy changes now use scoped Squid change requests, normal approval tickets, and the agent/worker polling protocols. The ticketing snapshots preserve earlier edits for reference; they are not migrations.
