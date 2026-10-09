/**
 * chat:doctor — why is the assistant not answering?
 *
 * Every failure on this path looks identical from the app (a spinner, then "the
 * assistant is unavailable"), and the causes are wildly different: a closed port,
 * an untrusted certificate, a clock skew, a credential that lost a role. This
 * walks the layers in order and stops at the first break, with the fix for THAT
 * layer.
 *
 *   npm run chat:doctor
 *
 * The npm script sets NODE_EXTRA_CA_CERTS for the agent's self-signed cert;
 * running this file by hand without it fails at step 2 in ~25ms.
 */
import 'dotenv/config';
import net from 'net';
import { env } from '../src/config/env';
import { agentChat, agentChatEnabled, AGENT_ROLES, agentRoleFor, type AgentRole } from '../src/services/agentApi';

const PROBE = 'Reply with the single word: ok';
const ok = (m: string): void => console.log(`  ✅ ${m}`);
const bad = (m: string, fix: string): never => { console.log(`  ❌ ${m}\n     → ${fix}`); process.exit(1); };

const base = (env.AGENT_BASE_URL ?? env.AGENT_URL).replace(/\/+$/, '');
const url = new URL(base);
const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));

const tcpProbe = (host: string, p: number, ms: number): Promise<string | null> =>
  new Promise((resolve) => {
    const sock = net.connect({ host, port: p });
    const done = (r: string | null): void => { sock.destroy(); resolve(r); };
    sock.setTimeout(ms);
    sock.on('connect', () => done(null));
    sock.on('timeout', () => done('timed out (packets dropped — filtered port, or nothing bound)'));
    sock.on('error', (e: NodeJS.ErrnoException) => done(e.code === 'EHOSTUNREACH' ? 'no route to host (firewall REJECT)' : e.code === 'ECONNREFUSED' ? 'connection refused (host up, nothing listening)' : `${e.code ?? e.message}`));
  });

(async () => {
  console.log(`\nchat:doctor → ${base}/v1/chat`);
  console.log(`  client=${env.AGENT_CHAT_CLIENT_ID ?? '(unset)'}  timeout=${env.AGENT_CHAT_TIMEOUT_MS}ms  ca=${process.env.NODE_EXTRA_CA_CERTS ?? '(unset)'}\n`);

  console.log('0. Configuration');
  if (!agentChatEnabled()) bad('AGENT_CHAT_CLIENT_ID / AGENT_CHAT_SECRET are not both set', 'Chat answers 503 AGENT_NOT_CONFIGURED until both are in server/.env. The secret is shown once at issue time — ask the agent platform for a new ext-* credential if it is lost.');
  ok('chat credential present');

  console.log('1. TCP reachability');
  const tcp = await tcpProbe(url.hostname, port, 8000);
  if (tcp) bad(`cannot open ${url.hostname}:${port} — ${tcp}`, 'The agent API is unreachable. Check it is running and that this host is allowed through the firewall on that port.');
  ok(`${url.hostname}:${port} accepts connections`);

  console.log('2. TLS + unauthenticated health');
  try {
    const res = await fetch(`${base}/v1/health`, { signal: AbortSignal.timeout(10_000) });
    ok(`GET /v1/health → HTTP ${res.status} ${(await res.text()).slice(0, 60)}`);
  } catch (err) {
    const msg = (err as Error).cause instanceof Error ? (err as Error & { cause: Error }).cause.message : (err as Error).message;
    return bad(`health check failed: ${msg}`,
      /self-signed|SELF_SIGNED|certificate/i.test(msg)
        ? 'The agent serves a self-signed certificate. Set NODE_EXTRA_CA_CERTS=/opt/B2B-Site/server/cert/agent.pem in the environment that runs the API (systemd unit / server/.env), not just in your shell.'
        : 'The port answered TCP but not HTTPS. Check what is bound to it on the agent host.');
  }

  console.log('3. Signed round trip');
  const started = Date.now();
  let reply: string;
  try {
    reply = (await agentChat(PROBE, 'end_user')).reply;
  } catch (err) {
    const e = err as { code?: string; message?: string };
    const fixes: Record<string, string> = {
      bad_signature: 'The secret does not match the client id. Re-copy AGENT_CHAT_SECRET, or have a new ext-* credential issued.',
      unknown_client: 'AGENT_CHAT_CLIENT_ID is not a credential the agent knows. Ask for a new one.',
      stale_timestamp: 'Clock skew over 300s. Run NTP on this host — this looks exactly like a signing bug but is not.',
      role_not_allowed: 'The credential is not granted end_user. Have the agent administrator widen its allowed-roles list.',
      AGENT_TIMEOUT: 'The agent accepted the request but did not answer in time. Raise AGENT_CHAT_TIMEOUT_MS, or ask the agent owner about model load.',
    };
    return bad(`${e.code}: ${e.message}`, fixes[e.code ?? ''] ?? 'Unexpected failure from the agent — the code above is its own, quote it to the agent owner.');
  }
  ok(`answered in ${Date.now() - started}ms: ${JSON.stringify(reply.trim().slice(0, 60))}`);

  console.log('4. Roles this credential may actually request');
  // Valid ≠ allowed: agentChat falls back to end_user on role_not_allowed, so the
  // role it ANSWERED as is the only proof. A silently downgraded l3 is why
  // ADMINISTRATOR chat once returned end-user click-paths to engineers.
  const granted: AgentRole[] = [];
  for (const role of AGENT_ROLES) {
    try { if ((await agentChat(PROBE, role)).role === role) granted.push(role); } catch { /* not granted */ }
  }
  const needed = ['USER', 'ORG_ADMIN', 'ADMINISTRATOR'].map((r) => `${r}→${agentRoleFor(r)}`);
  if (granted.length === 0) bad('none of the five roles are granted', 'Chat is dead for every user. Ask the agent administrator to widen this credential.');
  ok(`granted: ${granted.join(', ')}`);
  const downgraded = ['USER', 'ORG_ADMIN', 'ADMINISTRATOR'].filter((r) => !granted.includes(agentRoleFor(r)));
  if (downgraded.length) console.log(`  ⚠️  ${downgraded.join(', ')} will silently answer as end_user (mapping: ${needed.join(', ')})`);

  console.log('5. Concurrency (the agent serves one call at a time)');
  const t0 = Date.now();
  const results = await Promise.allSettled([1, 2, 3].map((n) => agentChat(`Reply with the single word: ${n}`, 'end_user')));
  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length) bad(`${failed.length}/3 concurrent calls failed: ${failed.map((r) => (r as PromiseRejectedResult).reason?.code).join(', ')}`,
    'Client-side serialization is not holding — concurrent chats will surface 429 server_busy to users.');
  ok(`3 concurrent calls all answered in ${((Date.now() - t0) / 1000).toFixed(1)}s (serialized)`);

  console.log('\n✅ chat backend healthy — the assistant will answer.\n');
  process.exit(0);
})();
