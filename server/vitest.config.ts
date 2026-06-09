import { defineConfig } from 'vitest/config';
import { config } from 'dotenv';

config(); // Load .env before vitest starts

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
