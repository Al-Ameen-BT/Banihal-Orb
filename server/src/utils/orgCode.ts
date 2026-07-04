import { prisma } from '../config/database';

// Derive a short, deterministic organization code from a name. Used to
// auto-default Customer.orgCode and as a runtime fallback for orgs that don't
// have one set yet, so ticket numbering works without a backfill.
//
// CamelCase words split into their humps and short ALL-CAPS acronyms are kept
// whole, so compound brand names produce the expected code:
//   "BankVault UK"          → "BVUK"  (Bank+Vault → BV, UK kept whole)
//   "DataVault Banking"     → "DVB"
//   "Nexus Financial Group" → "NFG"
//   "BlueSky Insurance"     → "BSI"
//   "Tech"                  → "TECH"
export function deriveOrgCode(name: string): string {
  const cleaned = (name ?? '').trim();
  if (!cleaned) return 'ORG';

  const words = cleaned.split(/\s+/).filter(Boolean);
  let code: string;
  if (words.length >= 2 || /[a-z][A-Z]/.test(cleaned)) {
    code = words.map((w) => {
      if (/^[A-Z0-9]{2,4}$/.test(w)) return w;                    // acronym (UK, IBM) → whole
      const humps = w.match(/[A-Z][a-z0-9]*|^[a-z0-9]+/g) ?? [w]; // BankVault → [Bank, Vault]
      return humps.map((h) => h.charAt(0)).join('');
    }).join('');
  } else {
    // Single plain word → first 4 letters (e.g. Tech → TECH).
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
