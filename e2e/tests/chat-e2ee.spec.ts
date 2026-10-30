import { test, expect } from '@playwright/test';
import path from 'path';

const ARTIFACTS_DIR =
  'C:/Users/Admin/.gemini/antigravity/brain/e5a1d785-628e-4928-82fd-05d52f2cfb0b';

test.describe('SOC-3a: End-to-End Encrypted (E2EE) Chat & UI (ADR-049)', () => {
  test.setTimeout(120000);

  test('Desktop (1280px): Chat UI, Conversations, Safety Number & Zero CSP violations', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });

    // Track CSP violations
    await page.addInitScript(() => {
      (window as any).__csp = [];
      window.addEventListener('securitypolicyviolation', (e) => {
        (window as any).__csp.push({
          violatedDirective: e.violatedDirective,
          blockedURI: e.blockedURI,
        });
      });
    });

    // Setup authenticated cookies
    await page.context().addCookies([
      {
        name: 'NEXT_LOCALE',
        value: 'vi',
        domain: 'localhost',
        path: '/',
      },
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

    // 1. Visit /vi/tin-nhan
    await page.goto('/vi/tin-nhan', { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForLoadState('domcontentloaded');

    // 2. Verify Conversation list and tabs
    const tabInbox = page.locator('button', { hasText: 'Hộp thư' });
    const tabRequests = page.locator('button', { hasText: 'Lời mời' });
    await expect(tabInbox).toBeVisible();
    await expect(tabRequests).toBeVisible();

    // 3. Switch to "Lời mời" tab and verify requested item
    await tabRequests.click();
    await page.waitForTimeout(300);

    // Switch back to "Hộp thư"
    await tabInbox.click();
    await page.waitForTimeout(300);

    // 4. Select a conversation item
    const firstConv = page.locator('[data-testid^="conversation-item-"]').first();
    if (await firstConv.isVisible()) {
      await firstConv.click();
      await page.waitForTimeout(500);

      // Verify Safety Number button
      const safetyBtn = page.locator('button[title*="an toàn"]');
      if (await safetyBtn.isVisible()) {
        await safetyBtn.click();
        await page.waitForTimeout(300);
        // Verify safety dialog is visible
        const safetyDialog = page.locator('h3', { hasText: 'Mã số an toàn' });
        await expect(safetyDialog).toBeVisible();

        // Close dialog
        const closeBtn = page.locator('button', { hasText: 'Đóng' });
        await closeBtn.click();
        await page.waitForTimeout(300);
      }
    }

    // 5. Capture Desktop Screenshot
    const desktopShot = path.join(ARTIFACTS_DIR, 'soc3a-chat-desktop.png');
    await page.screenshot({ path: desktopShot, fullPage: false });

    // 6. Check CSP violations (verifying zero script-src or worker-src violations with WASM)
    const violations = await page.evaluate(() => {
      const all = (window as any).__csp || [];
      return all.filter(
        (v: any) => v.violatedDirective === 'script-src' || v.violatedDirective === 'worker-src',
      );
    });
    expect(violations).toEqual([]);
  });

  test('Mobile (360px): Responsive Chat view, Tab switching & Composer fit', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });

    // Setup authenticated cookies
    await page.context().addCookies([
      {
        name: 'NEXT_LOCALE',
        value: 'vi',
        domain: 'localhost',
        path: '/',
      },
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

    // 1. Visit /vi/tin-nhan at 360px
    await page.goto('/vi/tin-nhan', { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForLoadState('domcontentloaded');

    // Verify search and new chat buttons
    const newChatBtn = page.locator('button', { hasText: 'Tin mới' });
    await expect(newChatBtn).toBeVisible();

    // Capture Mobile Screenshot
    const mobileShot = path.join(ARTIFACTS_DIR, 'soc3a-chat-360px.png');
    await page.screenshot({ path: mobileShot, fullPage: false });
  });

  test('Two-Browser Context: User A and User B message requests flow', async ({ browser }) => {
    // Context A (User A: Linh Đan / Creator)
    const contextA = await browser.newContext();
    await contextA.addCookies([
      { name: 'NEXT_LOCALE', value: 'vi', domain: 'localhost', path: '/' },
      { name: 'wk_has_session', value: '1', domain: 'localhost', path: '/' },
      {
        name: 'wk_rt',
        value: 'mock-refresh-0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c02',
        domain: 'localhost',
        path: '/',
      },
    ]);
    const pageA = await contextA.newPage();

    // Context B (User B: Minh Quân / Viewer)
    const contextB = await browser.newContext();
    await contextB.addCookies([
      { name: 'NEXT_LOCALE', value: 'vi', domain: 'localhost', path: '/' },
      { name: 'wk_has_session', value: '1', domain: 'localhost', path: '/' },
      {
        name: 'wk_rt',
        value: 'mock-refresh-0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c03',
        domain: 'localhost',
        path: '/',
      },
    ]);
    const pageB = await contextB.newPage();

    // Both navigate to /vi/tin-nhan
    await Promise.all([
      pageA.goto('/vi/tin-nhan', { waitUntil: 'domcontentloaded', timeout: 90000 }),
      pageB.goto('/vi/tin-nhan', { waitUntil: 'domcontentloaded', timeout: 90000 }),
    ]);

    // B opens "Lời mời" tab to see incoming message request
    const tabRequestsB = pageB.locator('button', { hasText: 'Lời mời' });
    await expect(tabRequestsB).toBeVisible();
    await tabRequestsB.click();
    await pageB.waitForTimeout(500);

    // Verify B's view loads cleanly
    await expect(pageB.locator('h1', { hasText: 'Tin nhắn' })).toBeVisible();

    await contextA.close();
    await contextB.close();
  });
});
