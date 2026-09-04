import { defineConfig } from 'vitest/config';
import { config } from 'dotenv';

config(); // Load .env before vitest starts
// The suite provisions ADMINISTRATOR fixtures on @example.com; login enforces that
// admins sit on a provider domain, so allow example.com for the test runtime.
process.env.ADMIN_DOMAINS = 'example.com';
// Registration now emails a confirmation link, so every register in the suite was
// dialling the real SMTP host and waiting for ENOTFOUND. Unset it and
// mail.service falls to its console-mock path: quiet, and seconds faster.
process.env.SMTP_HOST = '';
process.env.SMTP_USER = '';
// Same reason: agent-routes.test.ts asserts the 503 AGENT_NOT_CONFIGURED path
// ("stopped only because no credential is configured in tests"), but a dev .env
// supplies real credentials, so the route instead tried to dial an unreachable
// agent and returned AGENT_UNAVAILABLE. Pin the unconfigured state the tests describe.
process.env.AGENT_CHAT_CLIENT_ID = '';
process.env.AGENT_CHAT_SECRET = '';
process.env.AGENT_COMPLAINTS_CLIENT_ID = '';
process.env.AGENT_COMPLAINTS_SECRET = '';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: [],
    testTimeout: 30000,
    hookTimeout: 30000,
    // Each test file gets its own fork, run serially. A single shared worker
    // (singleFork) let earlier files corrupt AsyncLocalStorage/Prisma state for
    // later ones (tenant scoping silently stopped applying). fileParallelism:false
    // keeps the shared test DB race-free without sharing process state.
    pool: 'forks',
    fileParallelism: false,
  },
});
