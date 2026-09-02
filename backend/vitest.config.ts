import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Each test file runs in its own worker → its own in-memory PGlite DB.
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    env: {
      NODE_ENV: 'test',
      USE_PGLITE: 'true',
      PGLITE_DIR: ':memory:',
      JWT_SECRET: 'test-secret',
      JWT_EXPIRES_IN: '1h',
      CORS_ORIGIN: 'http://localhost:3000',
    },
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
