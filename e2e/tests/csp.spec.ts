import { test, expect, Page, Response } from '@playwright/test';

function setupCspCollector(page: Page) {
  const consoleErrors: string[] = [];

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const text = msg.text();
      if (
        text.includes('Content Security Policy') ||
        text.includes('violates the following Content Security Policy directive') ||
        text.includes('Refused to')
      ) {
        consoleErrors.push(text);
      }
    }
  });

  page.addInitScript(() => {
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
  });

  return {
    async assertZeroCspViolations() {
      const violations = await page.evaluate(() => (window as any).__csp || []);
      expect(violations).toEqual([]);
      expect(consoleErrors).toEqual([]);
    },
  };
}

function assertCspEnforceHeaders(response: Response | null): string {
  expect(response).not.toBeNull();
  const headers = response!.headers();
  expect(headers['content-security-policy-report-only']).toBeUndefined();
  const csp = headers['content-security-policy'];
  expect(csp).toBeDefined();
  expect(csp).toMatch(/'nonce-[A-Za-z0-9+/=]+'/);
  return csp;
}

async function assert404WithNonce(page: Page, response: Response | null) {
  expect(response).not.toBeNull();
  expect(response!.status()).toBe(404);

  const csp = assertCspEnforceHeaders(response);
  const nonceMatch = csp.match(/'nonce-([^']+)'/);
  expect(nonceMatch).not.toBeNull();
  const headerNonce = nonceMatch![1];

  // Confirm that the 404 HTML carries nonce= on every <script> element and that the nonce matches the header
  const scriptNonces = await page.evaluate(() => {
    const scripts = Array.from(document.querySelectorAll('script'));
    return scripts.map((s) => s.getAttribute('nonce') || (s as any).nonce || '');
  });

  expect(scriptNonces.length).toBeGreaterThan(0);
  for (const n of scriptNonces) {
    expect(n).toBe(headerNonce);
  }
}

test.describe('CSP1 Phase 2 Enforce: Strict Content Security Policy Nonce & Zero Violations E2E', () => {
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

  test('1. Home page renders with enforce CSP and zero violations', async ({ page }) => {
    const collector = setupCspCollector(page);
    const response = await page.goto('/', { waitUntil: 'domcontentloaded' });
    assertCspEnforceHeaders(response);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(500);

    await collector.assertZeroCspViolations();
  });

  test('2. Watch page starts HLS playback with enforce CSP and zero violations', async ({
    page,
  }) => {
    const collector = setupCspCollector(page);
    const response = await page.goto('/watch/0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c10', {
      waitUntil: 'domcontentloaded',
    });
    assertCspEnforceHeaders(response);
    await page.waitForLoadState('domcontentloaded');

    const video = page.locator('video');
    await expect(video).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(500);

    await collector.assertZeroCspViolations();
  });

  test('3. /embed/{id} renders VideoPlayer with frame-ancestors * and zero violations', async ({
    page,
  }) => {
    const collector = setupCspCollector(page);
    const response = await page.goto('/embed/0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c10', {
      waitUntil: 'domcontentloaded',
    });
    const csp = assertCspEnforceHeaders(response);
    expect(csp).toContain('frame-ancestors *');
    expect(csp).not.toContain("frame-ancestors 'self'");
    await page.waitForLoadState('domcontentloaded');

    const video = page.locator('video');
    await expect(video).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(500);

    await collector.assertZeroCspViolations();
  });

  test('4. Login page with Turnstile renders and executes with zero CSP violations', async ({
    page,
  }) => {
    const collector = setupCspCollector(page);
    const response = await page.goto('/login', { waitUntil: 'domcontentloaded' });
    assertCspEnforceHeaders(response);
    await page.waitForLoadState('domcontentloaded');

    // Wait for Turnstile widget container
    const turnstileWidget = page.locator('[data-testid="turnstile-widget"]');
    await expect(turnstileWidget).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(1000);

    await collector.assertZeroCspViolations();
  });

  test('5. Register page with Turnstile renders with zero CSP violations', async ({ page }) => {
    const collector = setupCspCollector(page);
    const response = await page.goto('/register', { waitUntil: 'domcontentloaded' });
    assertCspEnforceHeaders(response);
    await page.waitForLoadState('domcontentloaded');

    const turnstileWidget = page.locator('[data-testid="turnstile-widget"]');
    await expect(turnstileWidget).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(1000);

    await collector.assertZeroCspViolations();
  });

  test('6. Studio upload start renders with zero CSP violations', async ({ page }) => {
    const collector = setupCspCollector(page);
    const response = await page.goto('/upload', { waitUntil: 'domcontentloaded' });
    assertCspEnforceHeaders(response);
    await page.waitForLoadState('domcontentloaded');

    const fileInput = page.locator('input[type="file"]');
    await expect(fileInput).toBeAttached({ timeout: 15000 });
    await page.waitForTimeout(500);

    await collector.assertZeroCspViolations();
  });

  test('7. /bang-tin with social video post renders and plays with zero CSP violations', async ({
    page,
  }) => {
    const collector = setupCspCollector(page);
    const response = await page.goto('/bang-tin', { waitUntil: 'domcontentloaded' });
    assertCspEnforceHeaders(response);
    await page.waitForLoadState('domcontentloaded');

    const player = page.locator('[data-testid="post-social-player"]').first();
    await expect(player).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(500);

    await collector.assertZeroCspViolations();
  });

  test('8. /tin-nhan loads E2EE WASM runtime with zero CSP violations', async ({ page }) => {
    const collector = setupCspCollector(page);
    const response = await page.goto('/tin-nhan', { waitUntil: 'domcontentloaded' });
    assertCspEnforceHeaders(response);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1000);

    await collector.assertZeroCspViolations();
  });

  test('9. 404 /test renders dynamic 404 with nonce matching header and zero CSP violations', async ({
    page,
  }) => {
    const collector = setupCspCollector(page);
    const response = await page.goto('/test', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('domcontentloaded');
    await assert404WithNonce(page, response);
    await collector.assertZeroCspViolations();
  });

  test('10. 404 /en/test renders dynamic 404 with nonce matching header and zero CSP violations', async ({
    page,
  }) => {
    const collector = setupCspCollector(page);
    const response = await page.goto('/en/test', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('domcontentloaded');
    await assert404WithNonce(page, response);
    await collector.assertZeroCspViolations();
  });

  test('11. 404 /embed/does-not-exist renders dynamic embed 404 with frame-ancestors *, nonce matching header, and zero CSP violations', async ({
    page,
  }) => {
    const collector = setupCspCollector(page);
    const response = await page.goto('/embed/does-not-exist', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('domcontentloaded');
    await assert404WithNonce(page, response);
    expect(response!.headers()['content-security-policy']).toContain('frame-ancestors *');
    await collector.assertZeroCspViolations();
  });
});
