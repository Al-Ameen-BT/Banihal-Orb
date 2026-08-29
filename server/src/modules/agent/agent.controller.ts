import { Request, Response, NextFunction } from 'express';
import { AgentChatSchema } from './agent.schema';
import { agentChat, topComplaints, agentRoleFor } from '../../services/agentApi';

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
export async function complaints(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try { res.json(await topComplaints()); } catch (err) { next(err); }
}
