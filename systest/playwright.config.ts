import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

export default defineConfig({
  testDir: './personas',
  timeout: 60000,
  expect: {
    timeout: 15000,
  },
  retries: 0,
  workers: 1, // Sequential persona execution against real stack
  reporter: [
    ['list'],
    ['json', { outputFile: path.join(__dirname, '.run/report/playwright-results.json') }],
  ],
  use: {
    baseURL: process.env.BASE_URL || 'http://127.0.0.1:8080',
    locale: 'vi-VN',
    timezoneId: 'Asia/Ho_Chi_Minh',
    actionTimeout: 15000,
    navigationTimeout: 15000,
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: {
      args: ['--autoplay-policy=no-user-gesture-required', '--disable-web-security'],
    },
  },
  outputDir: path.join(__dirname, '.run/report/playwright-artifacts'),
  projects: [
    {
      name: 'member',
      testMatch: /member\.spec\.ts/,
      use: {
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      name: 'creator',
      testMatch: /creator\.spec\.ts/,
      use: {
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      name: 'anon-viewer-desktop',
      testMatch: /anon-viewer\.spec\.ts/,
      use: {
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      name: 'anon-viewer-mobile',
      testMatch: /anon-viewer\.spec\.ts/,
      use: {
        ...devices['Pixel 7'],
      },
    },
    {
      name: 'moderator',
      testMatch: /moderator\.spec\.ts/,
      use: {
        viewport: { width: 1440, height: 900 },
      },
    },
  ],
});
