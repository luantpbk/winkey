import { test, expect } from '@playwright/test';

test.describe('UX1 Responsive Framework E2E (ADR-044)', () => {
  test('Mobile viewport displays BottomNav with essential links', async ({ page }) => {
    // Only run mobile assertion when mobile project or small viewport
    const viewport = page.viewportSize();
    if (!viewport || viewport.width >= 768) {
      test.skip();
    }

    await page.goto('/kham-pha');
    await page.waitForLoadState('domcontentloaded');

    const bottomNav = page.locator('[data-testid="mobile-bottom-nav"]');
    await expect(bottomNav).toBeVisible();

    // Verify presence of 4 essential links
    const homeLink = bottomNav.locator('a[href="/"]');
    const exploreLink = bottomNav.locator('a[href="/kham-pha"]');
    const historyLink = bottomNav.locator('a[href="/lich-su"]');
    const libraryLink = bottomNav.locator('a[href="/thu-vien"]');

    await expect(homeLink).toBeVisible();
    await expect(exploreLink).toBeVisible();
    await expect(historyLink).toBeVisible();
    await expect(libraryLink).toBeVisible();
  });

  test('Desktop viewport hides Mobile BottomNav', async ({ page }) => {
    const viewport = page.viewportSize();
    if (!viewport || viewport.width < 768) {
      test.skip();
    }

    await page.goto('/kham-pha');
    await page.waitForLoadState('domcontentloaded');

    const bottomNav = page.locator('[data-testid="mobile-bottom-nav"]');
    await expect(bottomNav).toBeHidden();
  });
});
