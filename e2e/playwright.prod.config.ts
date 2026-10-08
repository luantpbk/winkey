import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: '**/production-feedback-runtime.spec.ts',
  fullyParallel: false,
  retries: 0,
  timeout: 60000,
  workers: 1,
  reporter: 'list',
  use: {
    viewport: { width: 1440, height: 900 },
    trace: 'off',
  },
});
