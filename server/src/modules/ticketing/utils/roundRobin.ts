// Round-robin assignment (report §7.3). The assignee pool + cursor live in
// Projects.settings JSON: { roundRobin: { enabled, lastAssignedId }, assignees: [] }
// where `assignees` holds ticketing Users ids. getNextAssignee returns the id after
// the last-assigned (wrapping); updateLastAssigned returns the settings to persist.

export interface RoundRobinSettings {
  roundRobin?: { enabled?: boolean; lastAssignedId?: string | null };
  assignees?: string[];
  [k: string]: unknown;
}

export function getNextAssignee(settings: unknown): string | null {
  const s = (settings ?? {}) as RoundRobinSettings;
  if (!s.roundRobin?.enabled) return null;
  const pool = Array.isArray(s.assignees) ? s.assignees.filter(Boolean) : [];
  if (pool.length === 0) return null;
  const lastId = s.roundRobin.lastAssignedId ?? null;
  const idx = lastId ? pool.indexOf(lastId) : -1;
  return pool[(idx + 1) % pool.length] ?? null;
}

// Returns a new settings object with the round-robin cursor advanced.
export function withLastAssigned(settings: unknown, assigneeId: string): RoundRobinSettings {
  const s = (settings ?? {}) as RoundRobinSettings;
  return { ...s, roundRobin: { ...(s.roundRobin ?? {}), lastAssignedId: assigneeId } };
}
