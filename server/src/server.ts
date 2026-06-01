import 'dotenv/config';
import './config/env'; // Validate env vars at startup — will exit(1) if invalid
import app from './app';
import { env } from './config/env';
import { prisma } from './config/database';

const PORT = env.PORT;

async function main() {
  // Verify database connection
  await prisma.$connect();
  console.log('✅ Database connected');

  app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT} [${env.NODE_ENV}]`);
  });
}

main().catch((err) => {
  console.error('❌ Failed to start server:', err);
  process.exit(1);
});
