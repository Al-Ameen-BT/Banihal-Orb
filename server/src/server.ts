import 'dotenv/config';
import './config/env'; // Validate env vars at startup — will exit(1) if invalid
import app from './app';
import { env } from './config/env';
import { prisma } from './config/database';
import { chatPrisma } from './config/chatDatabase';
import { ticketingPrisma } from './config/ticketingDatabase';
import { slackManager } from './modules/slack-bots/slackManager';
import { isPushConfigured } from './lib/webpush';

const PORT = env.PORT;

async function main() {
  // Verify all three database connections (main / chat / ticketing)
  await prisma.$connect();
  console.log('✅ Main database connected (b2b)');
  await chatPrisma.$connect();
  console.log('✅ Chat database connected (b2b_chat)');
  await ticketingPrisma.$connect();
  console.log('✅ Ticketing database connected (b2b_ticketing)');

  // Push degrades silently by design (an assignment must never fail because a
  // notification could not be sent), so an unconfigured deploy is otherwise
  // invisible — it looks exactly like "nobody has enabled notifications".
  if (!isPushConfigured()) {
    console.warn('⚠️  Web Push disabled: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are not set');
  }

  app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT} [${env.NODE_ENV}]`);
  });

  // Connect enabled Slack bots + start the live-status poll loop (non-fatal).
  slackManager.init().catch((err) => console.error('⚠️  Slack manager init failed:', err));
}

main().catch((err) => {
  console.error('❌ Failed to start server:', err);
  process.exit(1);
});
