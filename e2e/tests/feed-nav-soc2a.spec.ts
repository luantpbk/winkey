import { test, expect } from '@playwright/test';
import path from 'path';

const ARTIFACTS_DIR =
  'C:/Users/Admin/.gemini/antigravity/brain/e5a1d785-628e-4928-82fd-05d52f2cfb0b';

test.describe('SOC-2a: Feed Navigation Entry Points', () => {
  test.setTimeout(90000);

  test.beforeEach(async ({ page }) => {
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
  });

  test('Desktop (1280px): Sidebar shows active "Bảng tin" link under "Trang chủ"', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/vi/bang-tin');
    await page.waitForLoadState('domcontentloaded');

    // Verify main navigation sidebar (fixed aside)
    const sidebar = page.locator('aside').first();
    await expect(sidebar).toBeVisible();

    const feedLink = sidebar.locator('a[href*="/bang-tin"]');
    await expect(feedLink).toBeVisible();
    await expect(feedLink).toContainText('Bảng tin');

    // Check active class
    const className = await feedLink.getAttribute('class');
    expect(className).toContain('text-red-500');

    // Capture screenshot
    const desktopShot = path.join(ARTIFACTS_DIR, 'soc2a-nav-desktop.png');
    await page.screenshot({ path: desktopShot, fullPage: false });
  });

  test('Mobile (360px): BottomNav shows 5 items with active "Bảng tin" tab', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto('/vi/bang-tin');
    await page.waitForLoadState('domcontentloaded');

    const bottomNav = page.locator('[data-testid="mobile-bottom-nav"]');
    await expect(bottomNav).toBeVisible();

    // Verify 5 navigation tabs
    const navLinks = bottomNav.locator('a');
    await expect(navLinks).toHaveCount(5);

    // Verify feed item
    const feedItem = bottomNav.locator('a[href*="/bang-tin"]');
    await expect(feedItem).toBeVisible();
    await expect(feedItem).toContainText('Bảng tin');

    // Verify active styling
    const feedItemClass = await feedItem.getAttribute('class');
    expect(feedItemClass).toContain('text-[#d9002b]');

    // Capture screenshot
    const mobileShot = path.join(ARTIFACTS_DIR, 'soc2a-nav-360px.png');
    await page.screenshot({ path: mobileShot, fullPage: false });
  });
});
