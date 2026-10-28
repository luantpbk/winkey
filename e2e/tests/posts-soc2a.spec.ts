import { test, expect } from '@playwright/test';
import path from 'path';

const ARTIFACTS_DIR =
  'C:/Users/Admin/.gemini/antigravity/brain/e5a1d785-628e-4928-82fd-05d52f2cfb0b';

test.describe('SOC-2a: Posts, Feeds, Reactions, Post Comments E2E', () => {
  test.setTimeout(90000);

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

  test('Desktop (1280px): View Feed, Composer, Post Page & capture screenshots', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });

    // 1. Visit Feed /bang-tin
    await page.goto('/bang-tin');
    await page.waitForLoadState('domcontentloaded');

    // Verify tabs
    const followingTab = page.locator('[data-testid="feed-tab-following"]');
    const exploreTab = page.locator('[data-testid="feed-tab-explore"]');
    await expect(followingTab).toBeVisible();
    await expect(exploreTab).toBeVisible();

    // Verify trending widget
    const trendingWidget = page.locator('[data-testid="trending-hashtags-widget"]');
    await expect(trendingWidget).toBeVisible();

    // Capture Desktop Feed
    const feedShot = path.join(ARTIFACTS_DIR, 'soc2a-feed-desktop.png');
    await page.screenshot({ path: feedShot, fullPage: false });

    // 2. Focus Composer and type
    const composerTextarea = page.locator('textarea[placeholder*="Bạn đang nghĩ gì"]');
    await composerTextarea.waitFor({ state: 'visible', timeout: 15000 });
    await composerTextarea.fill('Bài viết thử nghiệm SOC-2a trên Winkey! #winkey @tech_guy');
    const counter = page.locator('[data-testid="post-char-counter"]');
    await expect(counter).toBeVisible();

    const composerShot = path.join(ARTIFACTS_DIR, 'soc2a-composer-desktop.png');
    await page.screenshot({ path: composerShot, fullPage: false });

    // 3. Visit Post Page /bai-viet/0192f5e4-7c1a-7b3e-9d2a-000000000001
    await page.goto('/bai-viet/0192f5e4-7c1a-7b3e-9d2a-000000000001');
    await page.waitForLoadState('domcontentloaded');

    const postCard = page.locator('[data-testid="post-card-0192f5e4-7c1a-7b3e-9d2a-000000000001"]');
    await expect(postCard).toBeVisible();

    // Capture Desktop Post Page
    const postShot = path.join(ARTIFACTS_DIR, 'soc2a-post-desktop.png');
    await page.screenshot({ path: postShot, fullPage: false });
  });

  test('Mobile (360px): View Feed, Composer, Post Page & capture screenshots', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });

    // 1. Visit Feed at 360px
    await page.goto('/bang-tin');
    await page.waitForLoadState('domcontentloaded');

    const followingTab = page.locator('[data-testid="feed-tab-following"]');
    await expect(followingTab).toBeVisible();

    const feedMobileShot = path.join(ARTIFACTS_DIR, 'soc2a-feed-360px.png');
    await page.screenshot({ path: feedMobileShot, fullPage: false });

    // 2. Composer at 360px
    const composerTextarea = page.locator('textarea[placeholder*="Bạn đang nghĩ gì"]');
    await composerTextarea.waitFor({ state: 'visible', timeout: 15000 });
    await composerTextarea.fill('Xin chào từ giao diện di động 360px! #mobile');
    const composerMobileShot = path.join(ARTIFACTS_DIR, 'soc2a-composer-360px.png');
    await page.screenshot({ path: composerMobileShot, fullPage: false });

    // 3. Post Page at 360px
    await page.goto('/bai-viet/0192f5e4-7c1a-7b3e-9d2a-000000000001');
    await page.waitForLoadState('domcontentloaded');

    const postCard = page.locator('[data-testid="post-card-0192f5e4-7c1a-7b3e-9d2a-000000000001"]');
    await expect(postCard).toBeVisible();

    const postMobileShot = path.join(ARTIFACTS_DIR, 'soc2a-post-360px.png');
    await page.screenshot({ path: postMobileShot, fullPage: false });
  });
});
