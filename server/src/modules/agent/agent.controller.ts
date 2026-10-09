import { Request, Response, NextFunction } from 'express';
import { AgentChatSchema } from './agent.schema';
import { agentChat, topComplaints, agentRoleFor } from '../../services/agentApi';
import { cached, cacheKey, TTL } from '../../lib/cache';

// One question, one answer, from the agent's signed /v1/chat.
//
// Deliberately NOT the streaming assistant: /api/chat still proxies the agent's
// unsigned SSE endpoint with conversation history and is untouched. This route is
// the stateless, role-scoped surface — use it for one-shot questions.
export async function chat(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { message, role } = AgentChatSchema.parse(req.body);
    // An explicit role still has to be inside our credential's allowlist; the agent
    // answers 403 role_not_allowed if it is not, which surfaces unchanged.
    res.json(await agentChat(message, role ?? agentRoleFor(req.user.role)));
  } catch (err) { next(err); }
}

// Highest-volume complaint categories plus their summed total.
//
// Cached: this is a cross-network call to the agent box on every dashboard tick,
// and the categories move on the order of hours, not seconds. Caching it also
// keeps a slow or down agent from stalling the panel on every poll.
export async function complaints(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.json(await cached(cacheKey('top-complaints'), TTL.dashboard, () => topComplaints()));
  } catch (err) { next(err); }
}
