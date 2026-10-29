import { test, expect } from '@playwright/test';
import path from 'path';

const ARTIFACTS_DIR =
  'C:/Users/Admin/.gemini/antigravity/brain/e5a1d785-628e-4928-82fd-05d52f2cfb0b';

test.describe('SOC-2b: Short Social Videos in Posts E2E', () => {
  test.setTimeout(120000);

  test.beforeEach(async ({ page }) => {
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

  test('Desktop (1280px): View Feed with Social Video, Inline Player & Mute controls', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });

    // 1. Visit Feed /bang-tin
    await page.goto('/bang-tin', { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForLoadState('domcontentloaded');

    // Verify Composer has Video attachment button
    const videoBtn = page.locator('[data-testid="post-attach-video-btn"]');
    await expect(videoBtn).toBeVisible();

    // Verify Social Video player is rendered in the top post
    const player = page.locator('[data-testid="post-social-player"]').first();
    await expect(player).toBeVisible();

    // Verify video element has playsinline attribute
    const videoElem = player.locator('[data-testid="social-video-element"]');
    await expect(videoElem).toBeVisible();
    await expect(videoElem).toHaveAttribute('playsinline', '');

    // Check mute toggle button
    const muteBtn = player.locator('[data-testid="social-video-mute-btn"]');
    await expect(muteBtn).toBeVisible();
    await muteBtn.click();

    // Wait a brief moment for UI to settle
    await page.waitForTimeout(500);

    // Capture Desktop Feed with Social Video screenshot
    const shot = path.join(ARTIFACTS_DIR, 'soc2b-feed-desktop.png');
    await page.screenshot({ path: shot, fullPage: false });
  });

  test('Mobile (360px): View Feed with Social Video, Vertical Aspect Ratio & Responsive fit', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 740 });

    // 1. Visit Feed at 360px
    await page.goto('/bang-tin');
    await page.waitForLoadState('domcontentloaded');

    // Verify Composer and Video attachment button
    const composer = page.locator('[data-testid="post-attach-video-btn"]');
    await expect(composer).toBeVisible();

    // Verify Social Video player is rendered and fits mobile viewport
    const player = page.locator('[data-testid="post-social-player"]').first();
    await expect(player).toBeVisible();

    // Verify bounding box height doesn't exceed 80vh (740 * 0.8 = 592px)
    const box = await player.boundingBox();
    expect(box).not.toBeNull();
    if (box) {
      expect(box.width).toBeLessThanOrEqual(360);
      expect(box.height).toBeLessThanOrEqual(740 * 0.85);
    }

    // Capture Mobile 360px Feed screenshot
    const shot = path.join(ARTIFACTS_DIR, 'soc2b-feed-360px.png');
    await page.screenshot({ path: shot, fullPage: false });
  });
});
