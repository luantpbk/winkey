import { defineConfig } from '@playwright/test';

/**
 * Specs that need a running full stack (real chat-svc, realtime, Garage), e.g. `systest/run.sh` or `make dev` + web.
 * No dev server is started; E2E_STACK_URL points at the gateway (default http://127.0.0.1:8080).
 *   E2E_STACK_URL=http://127.0.0.1:8080 pnpm --filter e2e test:stack
 */
export default defineConfig({
  testDir: './tests',
  // Stack-only specs end in .stack.spec.ts; the default config ignores them.
  testMatch: /\.stack\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 240_000,
  reporter: 'list',
  use: {
    baseURL: process.env.E2E_STACK_URL ?? 'http://127.0.0.1:8080',
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
