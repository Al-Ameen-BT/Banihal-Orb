import { z } from 'zod';
import { AGENT_ROLES } from '../../services/agentApi';

// `role` is optional: when omitted it is derived from the caller's platform role
// (agentRoleFor). An explicit value is validated against the agent's five audience
// roles here so a bad one fails locally with a field error, rather than costing a
// signed round trip to come back as `bad_role`.
export const AgentChatSchema = z.object({
  message: z.string().trim().min(1, 'Message cannot be empty').max(4000),
  role: z.enum(AGENT_ROLES).optional(),
});
