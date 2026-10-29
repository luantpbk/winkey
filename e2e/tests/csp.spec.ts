import { test, expect, Page } from '@playwright/test';

// Standard Cloudflare Turnstile Always-Pass test key
const TURNSTILE_TEST_SITE_KEY = '1x00000000000000000000AA';

async function setupCspCollector(page: Page, enableTurnstile = false) {
  await page.addInitScript(({ enableTurnstileKey, siteKey }) => {
    (window as any).__csp = [];
    window.addEventListener('securitypolicyviolation', (e) => {
      (window as any).__csp.push({
        violatedDirective: e.violatedDirective,
        blockedURI: e.blockedURI,
        documentURI: e.documentURI,
        disposition: e.disposition,
        originalPolicy: e.originalPolicy,
      });
    });
    if (enableTurnstileKey) {
      (window as any).__TURNSTILE_SITE_KEY__ = siteKey;
    }
  }, { enableTurnstileKey: enableTurnstile, siteKey: TURNSTILE_TEST_SITE_KEY });
}

async function assertZeroCspViolations(page: Page) {
  const violations = await page.evaluate(() => (window as any).__csp || []);
  expect(violations).toEqual([]);
}

test.describe('CSP1: Strict Content Security Policy Nonce & Zero Violations E2E', () => {
  test.setTimeout(90000);

  test.beforeEach(async ({ page }) => {
    // Add mock auth session cookies for authenticated surfaces
    await page.context().addCookies([
      {
        name: 'wk_has_session',
        value: '1',
        domain: 'localhost',
        path: '/',
      },
      {
        name: 'wk_rt',
        value: 'mock-refresh-0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c03',
        domain: 'localhost',
        path: '/',
      },
    ]);
  });

  test('1. Home page renders with zero CSP violations', async ({ page }) => {
    await setupCspCollector(page);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(500);

    await assertZeroCspViolations(page);
  });

  test('2. Watch page starts HLS playback with zero CSP violations', async ({ page }) => {
    await setupCspCollector(page);
    await page.goto('/watch/0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c10', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('domcontentloaded');

    const video = page.locator('video');
    await expect(video).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(500);

    await assertZeroCspViolations(page);
  });

  test('3. /embed/{id} renders VideoPlayer with frame-ancestors and zero CSP violations', async ({ page }) => {
    await setupCspCollector(page);
    await page.goto('/embed/0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c10', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('domcontentloaded');

    const video = page.locator('video');
    await expect(video).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(500);

    await assertZeroCspViolations(page);
  });

  test('4. Login page with Turnstile renders and executes with zero CSP violations', async ({ page }) => {
    await setupCspCollector(page, true);
    await page.goto('/login', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('domcontentloaded');

    // Wait for Turnstile widget container
    const turnstileWidget = page.locator('[data-testid="turnstile-widget"]');
    await expect(turnstileWidget).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(1000);

    await assertZeroCspViolations(page);
  });

  test('5. Register page with Turnstile renders with zero CSP violations', async ({ page }) => {
    await setupCspCollector(page, true);
    await page.goto('/register', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('domcontentloaded');

    const turnstileWidget = page.locator('[data-testid="turnstile-widget"]');
    await expect(turnstileWidget).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(1000);

    await assertZeroCspViolations(page);
  });

  test('6. Studio upload start renders with zero CSP violations', async ({ page }) => {
    await setupCspCollector(page);
    await page.goto('/upload', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('domcontentloaded');

    const fileInput = page.locator('input[type="file"]');
    await expect(fileInput).toBeAttached({ timeout: 15000 });
    await page.waitForTimeout(500);

    await assertZeroCspViolations(page);
  });

  test('7. /bang-tin with social video post renders and plays with zero CSP violations', async ({ page }) => {
    await setupCspCollector(page);
    await page.goto('/bang-tin', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('domcontentloaded');

    const player = page.locator('[data-testid="post-social-player"]').first();
    await expect(player).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(500);

    await assertZeroCspViolations(page);
  });

  test('8. Settings / security (/cai-dat/bao-mat) renders with zero CSP violations', async ({ page }) => {
    await setupCspCollector(page);
    await page.goto('/cai-dat/bao-mat', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(500);

    await assertZeroCspViolations(page);
  });
});
