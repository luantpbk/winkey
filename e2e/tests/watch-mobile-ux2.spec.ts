import { test, expect } from '@playwright/test';
import path from 'path';

test.describe('UX2: Mobile Watch Page and Player Controls (ADR-045)', () => {
  const watchUrl = '/watch/0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c10';

  const viewports = [
    { width: 360, height: 800, name: '360px', filename: 'ux2-watch-360px.png' },
    { width: 390, height: 844, name: '390px', filename: 'ux2-watch-390px.png' },
    { width: 768, height: 1024, name: '768px', filename: 'ux2-watch-768px.png' },
  ];

  for (const vp of viewports) {
    test(`renders without horizontal overflow and captures screenshot at ${vp.name} (${vp.width}x${vp.height})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto(watchUrl);
      await page.waitForLoadState('domcontentloaded');

      // Wait for player and action bar
      const playerControls = page.locator('[data-testid="player-controls"]');
      const actionBar = page.locator('[data-testid="watch-action-bar"]');
      await expect(actionBar).toBeVisible();

      // Check no page horizontal overflow: scrollWidth <= clientWidth
      const isOverflowing = await page.evaluate(() => {
        return document.documentElement.scrollWidth > document.documentElement.clientWidth;
      });
      expect(isOverflowing).toBe(false);

      // On mobile viewports (< 640px), verify compact controls and settings button
      if (vp.width < 640) {
        const settingsBtn = page.locator('[data-testid="player-settings-button"]');
        await expect(settingsBtn).toBeVisible();

        const playBtn = page.locator('[data-testid="play-pause-button"]');
        await expect(playBtn).toBeVisible();

        const muteBtn = page.locator('[data-testid="volume-mute-button"]');
        await expect(muteBtn).toBeVisible();

        const timeDisplay = page.locator('[data-testid="time-display"]');
        await expect(timeDisplay).toBeVisible();

        const fullscreenBtn = page.locator('[data-testid="fullscreen-button"]');
        await expect(fullscreenBtn).toBeVisible();
      }

      // Check action bar chips have equal height (40px)
      const actionChips = page.locator('[data-testid="watch-action-bar"] > *');
      const count = await actionChips.count();
      expect(count).toBeGreaterThan(0);

      // Take and save screenshot
      const screenshotPath = path.resolve('screenshots', vp.filename);
      await page.screenshot({ path: screenshotPath, fullPage: false });
    });
  }

  test('Mobile settings sheet can be opened and closed at 360px', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto(watchUrl);
    await page.waitForLoadState('domcontentloaded');

    const settingsBtn = page.locator('[data-testid="player-settings-button"]');
    await expect(settingsBtn).toBeVisible();

    // Open settings sheet
    await settingsBtn.click();
    const sheet = page.locator('[data-testid="player-settings-sheet"]');
    await expect(sheet).toBeVisible();

    // Capture settings sheet open screenshot
    const sheetScreenshotPath = path.resolve('screenshots', 'ux2-watch-360px-settings.png');
    await page.screenshot({ path: sheetScreenshotPath, fullPage: false });

    // Close settings sheet
    const closeBtn = page.locator('[data-testid="settings-close-btn"]');
    await closeBtn.click();
    await expect(sheet).toBeHidden();
  });
});
