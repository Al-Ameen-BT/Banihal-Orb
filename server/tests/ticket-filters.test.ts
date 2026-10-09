import { describe, it, expect } from 'vitest';
import { ListTicketsSchema } from '../src/modules/ticketing/ticketing.schema';

// A cleared filter arrives as `?status=` — an empty string, not an absent key.
// `.optional()` rejects that, so the whole GET /ticketing/tickets 400'd and the
// list rendered as "No tickets match this filter": a validation failure wearing
// an empty result's clothes.
//
// The trigger in the wild was `?assignee=` (or a non-UUID deep link) seeding the
// assignee filter, because `searchParams.get('assignee') ?? 'ALL'` does not catch
// an empty string.

const ok = (q: Record<string, string>) => ListTicketsSchema.safeParse(q).success;
const parsed = (q: Record<string, string>) => ListTicketsSchema.parse(q);

describe('a cleared filter means "no filter", not a bad request', () => {
  it.each(['status', 'priority', 'type', 'projectId', 'assigneeId', 'search', 'mine', 'escalatedOnly'])(
    'accepts an empty %s and drops it',
    (key) => {
      expect(ok({ [key]: '' }), `${key}='' must not 400`).toBe(true);
      expect(parsed({ [key]: '' })[key as 'status'], `${key} must be treated as absent`).toBeUndefined();
    },
  );

  it('accepts whitespace as empty', () => {
    expect(ok({ assigneeId: '   ' })).toBe(true);
  });

  it('accepts the plain list with no filters at all', () => {
    expect(ok({})).toBe(true);
  });
});

describe('a real value still validates', () => {
  it('keeps a valid filter', () => {
    const q = parsed({ status: 'todo', assigneeId: '3f1e4a2b-1111-4222-8333-444455556666' });
    expect(q.status).toBe('todo');
    expect(q.assigneeId).toBe('3f1e4a2b-1111-4222-8333-444455556666');
  });

  it('STILL rejects a malformed non-empty value', () => {
    // Deliberately not silently ignored: showing every ticket to someone who
    // asked for one person's queue is wrong data that looks right.
    expect(ok({ assigneeId: '__unassigned__' })).toBe(false);
    expect(ok({ status: 'nonsense' })).toBe(false);
    expect(ok({ projectId: 'not-a-uuid' })).toBe(false);
  });
});
