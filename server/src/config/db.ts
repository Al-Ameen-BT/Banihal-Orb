import { Pool } from 'pg';
import { env } from './env';

// ─── Connection pool (main `b2b` database) ───────────────────────────────────
export const pool = new Pool({ connectionString: env.DATABASE_URL, max: 10 });

// ─── Low-level query helpers ─────────────────────────────────────────────────
export async function query<T = Record<string, unknown>>(text: string, params: readonly unknown[] = []): Promise<T[]> {
  const res = await pool.query(text, params as unknown[]);
  return res.rows as T[];
}
export async function queryOne<T = Record<string, unknown>>(text: string, params: readonly unknown[] = []): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

// ─── SQL builders ────────────────────────────────────────────────────────────
// Quote an identifier (table/column) for interpolation into SQL text. Only ever
// called with developer-provided constants, never user input.
export const ident = (name: string): string => `"${name.replace(/"/g, '""')}"`;

// Build a parameterized `SET a=$n, b=$n+1, "updatedAt"=$n+2` clause from a partial
// object, appending updatedAt=now() when `touchUpdatedAt` (the default). Returns
// the SQL fragment, the ordered params, and the next placeholder index.
export function buildSet(
  data: Record<string, unknown>,
  startIndex = 1,
  touchUpdatedAt = true,
): { sql: string; params: unknown[]; nextIndex: number } {
  const cols: string[] = [];
  const params: unknown[] = [];
  let i = startIndex;
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue; // skip absent fields (partial update)
    cols.push(`${ident(k)} = $${i++}`);
    params.push(v);
  }
  if (touchUpdatedAt) {
    cols.push(`${ident('updatedAt')} = $${i++}`);
    params.push(new Date());
  }
  return { sql: cols.join(', '), params, nextIndex: i };
}