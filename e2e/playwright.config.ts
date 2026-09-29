import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 60000,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'desktop',
      use: {
        viewport: { width: 1440, height: 900 },
      },
    },
  ],
  webServer: {
    command: 'pnpm --filter @winkey/web run dev -p 3000',
    url: 'http://localhost:3000/healthz',
    reuseExistingServer: false,
    timeout: 120 * 1000,
    env: {
      API_MOCKS: '1',
      NEXT_PUBLIC_API_MOCKS: '1',
      PORT: '3000',
    },
  },
});
