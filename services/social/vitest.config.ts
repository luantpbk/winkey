import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig({
  test: {
    alias: {
      '@winkey/outbox': path.resolve(__dirname, '../../packages/outbox/src/index.ts'),
    },
    hookTimeout: 120_000,
    testTimeout: 60_000,
  },
});
