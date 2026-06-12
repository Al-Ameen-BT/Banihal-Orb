import { PrismaClient } from '@prisma/chat-client';

// Dedicated chat database (CHAT_DATABASE_URL → b2b_chat).
// All queries in chat.service explicitly scope by userId/customerId — the main
// DB's tenant extension does not apply to this client, so explicit scoping in
// the service layer is the isolation boundary here.

const globalForChat = globalThis as unknown as { chatPrisma?: PrismaClient };

export const chatPrisma = globalForChat.chatPrisma ?? new PrismaClient({
  log: process.env['NODE_ENV'] === 'development' ? ['warn', 'error'] : ['error'],
});

if (process.env['NODE_ENV'] !== 'production') {
  globalForChat.chatPrisma = chatPrisma;
}
