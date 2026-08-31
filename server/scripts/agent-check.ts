/**
 * Signed-agent smoke check — `npm run agent:check` (server/).
 *
 * Verifies the three things api-connect.txt says integrations get wrong, against
 * the live agent: the credential's real allowed-roles list (§2/§8c), the role
 * fallback that keeps a disallowed role from erroring, and client-side
 * serialization of the agent's global one-call-at-a-time cap (§5/§8d).
 *
 * Needs NODE_EXTRA_CA_CERTS for the agent's self-signed cert (§1) — the npm
 * script sets it; running this file by hand without it fails every call in ~25ms.
 */
import 'dotenv/config';
import { agentChat, agentRoleFor, AGENT_ROLES, type AgentRole } from '../src/services/agentApi';

const PROBE = 'Reply with the single word: ok';
let failed = false;

function report(name: string, ok: boolean, detail: string): void {
  if (!ok) failed = true;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(34)} ${detail}`);
}

async function main(): Promise<void> {
  // 1. Which roles is this credential actually granted? Valid ≠ allowed.
  // agentChat falls back to end_user on role_not_allowed, so a reply alone proves
  // nothing — the role it ANSWERED as is what says whether the role was granted.
  const allowed: AgentRole[] = [];
  for (const role of AGENT_ROLES) {
    try { if ((await agentChat(PROBE, role)).role === role) allowed.push(role); } catch { /* not granted */ }
  }
  report('credential allowed-roles', allowed.length > 0, allowed.join(', ') || 'NONE — chat is dead for every user');

  // 2. Every platform role must get an answer, falling back to end_user when its
  //    mapped role is not granted. This is what broke ADMINISTRATOR chat in prod.
  for (const platformRole of ['USER', 'ORG_ADMIN', 'ADMINISTRATOR']) {
    const mapped = agentRoleFor(platformRole);
    try {
      const r = await agentChat(PROBE, mapped);
      report(`${platformRole} chat`, r.reply.trim().length > 0, `sent ${mapped}, answered as ${r.role}`);
    } catch (err) {
      report(`${platformRole} chat`, false, `${(err as { code?: string }).code} (sent ${mapped})`);
    }
  }

  // 3. Concurrent callers must queue, not collide with 429 server_busy.
  const started = Date.now();
  const results = await Promise.allSettled([1, 2, 3].map((n) => agentChat(`Reply with the single word: ${n}`, 'end_user')));
  const rejected = results.filter((r) => r.status === 'rejected');
  report('3 concurrent calls serialize', rejected.length === 0,
    rejected.length === 0
      ? `all 3 answered in ${((Date.now() - started) / 1000).toFixed(1)}s`
      : `${rejected.length} rejected: ${rejected.map((r) => (r as PromiseRejectedResult).reason?.code).join(', ')}`);
}

main()
  .then(() => process.exit(failed ? 1 : 0))
  .catch((err) => { console.error('agent-check crashed:', err); process.exit(1); });
