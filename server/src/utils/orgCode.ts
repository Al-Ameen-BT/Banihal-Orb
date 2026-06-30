import { prisma } from '../config/database';

// Derive a short, deterministic organization code from a name. Used to
// auto-default Customer.orgCode and as a runtime fallback for orgs that don't
// have one set yet, so ticket numbering works without a backfill.
//
//   "DataVault Banking"   → "DVB"
//   "Nexus Financial Group" → "NFG"
//   "Tech"                → "TECH"
//   "BlueSky Insurance"   → "BSI"
export function deriveOrgCode(name: string): string {
  const cleaned = (name ?? '').trim();
  if (!cleaned) return 'ORG';

  const words = cleaned.split(/\s+/).filter(Boolean);
  let code: string;
  if (words.length >= 2) {
    // Initials of each word (e.g. DataVault Banking → DVB).
    code = words.map((w) => w.charAt(0)).join('');
  } else {
    // Single word → first 4 letters (e.g. Tech → TECH).
    code = words[0]!.slice(0, 4);
  }

  code = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return (code || 'ORG').slice(0, 6);
}

// Derive an org code and ensure it doesn't collide with an existing customer's
// (orgCode is @unique). Appends a numeric suffix on collision: DVB, DVB2, DVB3…
export async function uniqueOrgCode(name: string): Promise<string> {
  const base = deriveOrgCode(name);
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? base : `${base}${i + 1}`.slice(0, 8);
    const taken = await prisma.customer.findFirst({ where: { orgCode: candidate }, select: { id: true } });
    if (!taken) return candidate;
  }
  // Extremely unlikely fallback — keep it unique with a random tail.
  return `${base}${Math.floor(Math.random() * 9000) + 1000}`.slice(0, 8);
}
