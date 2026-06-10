import { z } from 'zod';

const ChatMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(2000),
});

export const ChatRequestSchema = z.object({
  message: z.string().min(1, 'Message is required').max(2000),
  // Optional prior turns for context. Capped to keep the prompt small for a 3B model.
  history: z.array(ChatMessageSchema).max(20).default([]),
  // Existing conversation to append to; omit to start a new session.
  sessionId: z.string().optional(),
});

export type ChatMessage = z.infer<typeof ChatMessageSchema>;
export type ChatRequest = z.infer<typeof ChatRequestSchema>;
