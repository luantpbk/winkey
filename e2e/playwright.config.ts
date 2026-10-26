import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testIgnore: ['**/production-feedback-runtime.spec.ts'],
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
    {
      name: 'mobile',
      use: {
        viewport: { width: 393, height: 851 },
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: 'tablet',
      use: {
        viewport: { width: 768, height: 1024 },
        hasTouch: true,
      },
    },
    {
      name: 'tv-720',
      use: {
        viewport: { width: 1280, height: 720 },
        hasTouch: false,
      },
    },
    {
      name: 'tv-1080',
      use: {
        viewport: { width: 1920, height: 1080 },
        hasTouch: false,
      },
    },
  ],
  webServer: {
    command: 'pnpm --filter @winkey/web run dev',
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
