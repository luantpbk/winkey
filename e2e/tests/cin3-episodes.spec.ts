import { test, expect } from '@playwright/test';

test.describe('CIN3: Automatic Series Context Resolution (ADR-045)', () => {
  test('opens episode URL without ?playlist= and automatically displays episode list', async ({
    page,
  }) => {
    // Navigate directly to Episode 1 of the mock series WITHOUT ?playlist=
    await page.goto('/watch/0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c10');
    await page.waitForLoadState('domcontentloaded');

    // 1. Verify series navigation bar is automatically displayed
    const seriesNav = page.locator('[data-testid="series-navigation-bar"]');
    await expect(seriesNav).toBeVisible({ timeout: 15000 });

    // 2. Verify URL was updated via replaceState to include ?playlist=
    await expect(page).toHaveURL(/playlist=0192f5e4-7c1a-7b3e-9d2a-p0000series01/);

    // 3. Verify desktop or mobile episode list is displayed depending on viewport
    const desktopColumn = page.locator('[data-testid="series-episodes-column"]');
    const mobileList = page.locator('[data-testid="series-mobile-episodes-list"]');

    const isDesktop = await desktopColumn.isVisible();
    if (isDesktop) {
      await expect(desktopColumn).toBeVisible();
      await expect(desktopColumn.locator('[data-testid="active-series-episode"]')).toBeVisible();
    } else {
      await expect(mobileList).toBeVisible();
      await expect(mobileList.locator('[data-testid="active-series-episode"]')).toBeVisible();
    }
  });
});
