import { exec } from 'child_process';
import { promisify } from 'util';
import crypto from 'crypto';
import { describe, expect, it } from 'vitest';

const execAsync = promisify(exec);

// The shell agent signs with openssl; the platform verifies with node's HMAC.
// If these ever diverge, the agent's requests silently 401 — this locks the two
// implementations to the same canonical bytes for both agent endpoints.
async function shellSign(rawKey: string, ts: string, method: string, path: string, hash: string): Promise<string> {
  const { stdout } = await execAsync(`printf '%s\\n%s\\n%s\\n%s' '${ts}' '${method}' '${path}' '${hash}' | openssl dgst -sha256 -hmac '${rawKey}' -binary | xxd -p -c 256 | tr -d '\\n'`);
  return stdout.trim();
}

describe('squid-agent openssl signing matches node', () => {
  it('produces byte-identical HMAC for the poll/result canonical form', async () => {
    const rawKey = 'pk_secret-registration-key-0123456789';
    const cases = [
      { method: 'GET', path: '/api/proxy-agent/poll', body: Buffer.alloc(0) },
      { method: 'POST', path: '/api/proxy-agent/result', body: Buffer.from('{"seq":3,"ok":true}') },
    ];
    for (const c of cases) {
      const ts = String(Date.now());
      const hash = crypto.createHash('sha256').update(c.body).digest('hex');
      const canonical = `${ts}\n${c.method}\n${c.path}\n${hash}`;
      const expected = crypto.createHmac('sha256', rawKey).update(canonical).digest('hex');
      expect(await shellSign(rawKey, ts, c.method, c.path, hash)).toBe(expected);
    }
  });
});