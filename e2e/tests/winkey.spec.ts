import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';

test.describe('Winkey E2E User Flows & Visual Verification', () => {
  test.beforeEach(async ({ page }) => {
    page.on('console', (msg) => console.log(`[BROWSER ${msg.type()}]:`, msg.text()));
    page.on('pageerror', (err) => console.log('[BROWSER UNCAUGHT]:', err));
  });

  test('Flow 1: Browse home -> open watch page', async ({ page }) => {
    // 1. Browse home
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');

    // Verify logo and brand
    await expect(page.locator('header')).toContainText('Winkey');

    // Wait for video cards (matches /watch/ or /vi/watch/)
    const firstVideoCard = page.locator('a[href*="/watch/"]').first();
    await expect(firstVideoCard).toBeVisible({ timeout: 15000 });

    // 2. Open watch page
    await firstVideoCard.click();
    await page.waitForURL(/\/watch\/.+/);

    // Verify player area and metadata
    const videoElement = page.locator('video');
    await expect(videoElement).toBeVisible();

    // Verify owner display name
    await expect(page.locator('a[href*="/c/"]').first()).toBeVisible();
    await expect(page.locator('h1')).toBeVisible();
  });

  test('PL1: Play video, select quality, verify recordView is called exactly once', async ({
    page,
  }) => {
    let responseViewCount = 0;
    let responsePayload: any = null;

    page.on('response', async (res) => {
      if (
        res.url().includes('/v1/videos/') &&
        res.url().includes('/views') &&
        res.request().method() === 'POST'
      ) {
        responseViewCount++;
        try {
          responsePayload = res.request().postDataJSON();
        } catch {
          // ignore
        }
      }
    });

    const getRecordedViews = async () => {
      return await page.evaluate(() => {
        try {
          return JSON.parse(sessionStorage.getItem('wk_mock_views') || '[]');
        } catch {
          return [];
        }
      });
    };

    // Navigate to watch page
    await page.goto('/watch/0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c10');
    await page.waitForLoadState('domcontentloaded');

    // Verify video player is mounted
    const video = page.locator('video');
    await expect(video).toBeVisible();

    // Verify quality menu interaction
    const qualityButton = page.locator('button[aria-label="Chọn chất lượng video"]');
    if (await qualityButton.isVisible({ timeout: 5000 }).catch(() => false)) {
      await qualityButton.click();
      const qualityOption = page.locator('[role="menu"] button').first();
      await expect(qualityOption).toBeVisible();
      await qualityOption.click();
    }

    // Simulate playback advancing past the 30s threshold
    await page.evaluate(() => {
      const v = document.querySelector('video');
      if (v) {
        v.dispatchEvent(new Event('play'));
        for (let t = 0.5; t <= 30.5; t += 0.5) {
          Object.defineProperty(v, 'currentTime', { value: t, configurable: true, writable: true });
          v.dispatchEvent(new Event('timeupdate'));
        }
      }
    });

    // Verify recordView was invoked
    await expect
      .poll(
        async () => {
          const views = await getRecordedViews();
          return Math.max(views.length, responseViewCount);
        },
        { timeout: 10000 },
      )
      .toBe(1);

    const views = await getRecordedViews();
    const payload = views[0] || responsePayload;
    expect(payload).toHaveProperty('playback_id');
    expect(payload).toHaveProperty('watched_ms');
    expect(payload.watched_ms).toBeGreaterThanOrEqual(30000);

    // Advance further: must remain called exactly 1 time
    await page.evaluate(() => {
      const v = document.querySelector('video');
      if (v) {
        for (let t = 31; t <= 40; t += 0.5) {
          Object.defineProperty(v, 'currentTime', { value: t, configurable: true, writable: true });
          v.dispatchEvent(new Event('timeupdate'));
        }
      }
    });

    await page.waitForTimeout(500);
    const viewsAfter = await getRecordedViews();
    const finalCount = Math.max(viewsAfter.length, responseViewCount);
    expect(finalCount).toBe(1);
  });

  test('Flow 2: Register -> upload file -> appears in studio', async ({ page }) => {
    // 1. Go to register page
    await page.goto('/register');
    await page.waitForLoadState('domcontentloaded');

    // Fill form inside main
    const uniqueHandle = `creator_${Date.now().toString(36)}`;
    await page.locator('main input[placeholder*="Nguyễn Văn A"]').fill('Test E2E Creator');
    await page.locator('main input[placeholder*="nguyenvana"]').fill(uniqueHandle);
    await page.locator('main input[type="email"]').fill(`${uniqueHandle}@winkey.vn`);
    await page.locator('main input[type="password"]').fill('password1234');

    // Click register submit inside main
    await page.locator('main button[type="submit"]').click();

    // Wait for redirect to home
    await page.waitForURL(
      (url) => url.pathname === '/' || url.pathname === '/vi' || url.pathname === '/en',
      { timeout: 15000 },
    );

    // 2. Navigate to upload
    await page.goto('/upload');
    await page.waitForLoadState('domcontentloaded');

    // Create temporary mock video file
    const sampleFilePath = path.join(process.cwd(), 'temp-test-video.mp4');
    fs.writeFileSync(sampleFilePath, 'Winkey MP4 Mock Content for E2E Upload');

    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(sampleFilePath);

    // Fill title
    const uploadTitleInput = page
      .locator(
        'input[placeholder*="Tiêu đề video"], input[placeholder*="Video Title"], input[required]',
      )
      .first();
    await uploadTitleInput.fill('E2E Automated Video Upload');

    // Click Start Upload
    const startUploadBtn = page.locator(
      'button:has-text("Bắt đầu tải lên"), button:has-text("Start Upload")',
    );
    await startUploadBtn.click();

    // Wait for upload completion indicator
    await expect(page.getByText(/Upload complete|Tải lên hoàn tất/i)).toBeVisible({
      timeout: 20000,
    });

    // 3. Go to studio
    await page.goto('/studio');
    await page.waitForLoadState('domcontentloaded');

    // Verify video appears in Studio
    await expect(page.locator('text=E2E Automated Video Upload')).toBeVisible({ timeout: 15000 });

    // Clean up temp file
    if (fs.existsSync(sampleFilePath)) {
      try {
        fs.unlinkSync(sampleFilePath);
      } catch {
        // ignore cleanup failure
      }
    }
  });

  test('U3: Social interactions on watch page (like, subscribe, post comment, reply)', async ({
    page,
  }) => {
    // Navigate to watch page with another creator's video so subscribe button is rendered
    await page.goto('/watch/0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c11');
    await page.waitForLoadState('domcontentloaded');

    // 1. Like video
    const likeButton = page
      .locator(
        'button[aria-label="Thích"], button[aria-label="Đã thích"], button[aria-label="Like"], button[aria-label="Liked"]',
      )
      .first();
    await expect(likeButton).toBeVisible({ timeout: 15000 });
    await likeButton.click();
    await expect(likeButton).toHaveAttribute('aria-pressed', 'true');

    // 2. Subscribe to creator
    const subscribeButton = page
      .locator(
        'button[aria-label="Đăng ký"], button[aria-label="Đã đăng ký"], button[aria-label="Subscribe"], button[aria-label="Subscribed"]',
      )
      .first();
    await expect(subscribeButton).toBeVisible({ timeout: 15000 });
    await subscribeButton.click();
    await expect(subscribeButton).toHaveAttribute('aria-pressed', 'true');

    // 3. Post top-level comment
    const commentInput = page
      .locator(
        'textarea[placeholder*="Viết bình luận"], textarea[placeholder*="comment"], textarea[placeholder*="Comment"]',
      )
      .first();
    await expect(commentInput).toBeVisible({ timeout: 15000 });
    const newCommentText = `E2E automated comment ${Date.now()}`;
    await commentInput.fill(newCommentText);

    const submitCommentBtn = page
      .locator(
        'button[type="submit"]:has-text("Bình luận"), button[type="submit"]:has-text("Comment")',
      )
      .first();
    await submitCommentBtn.click();

    // Verify comment appears in list
    await expect(page.locator(`p:has-text("${newCommentText}")`)).toBeVisible({ timeout: 15000 });

    // 4. Reply to top-level comment
    const commentItem = page.locator(`div:has-text("${newCommentText}")`).last();
    const replyTriggerBtn = commentItem
      .locator('button:has-text("Phản hồi"), button:has-text("Reply")')
      .first();
    if (await replyTriggerBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await replyTriggerBtn.click();
      const replyInput = page
        .locator('textarea[placeholder*="Viết câu trả lời"], textarea[placeholder*="reply"]')
        .first();
      await expect(replyInput).toBeVisible({ timeout: 5000 });
      const replyText = `E2E automated reply ${Date.now()}`;
      await replyInput.fill(replyText);

      const submitReplyBtn = page
        .locator(
          'button[type="submit"]:has-text("Phản hồi"), button[type="submit"]:has-text("Reply")',
        )
        .first();
      await submitReplyBtn.click();

      // Verify reply appears in list
      await expect(page.locator(`p:has-text("${replyText}")`)).toBeVisible({ timeout: 15000 });
    }
  });

  test('Capture screenshots across viewports: 375px, 768px, 1440px', async ({ page }) => {
    test.setTimeout(180000);

    const viewports = [
      { name: '375', width: 375, height: 667 },
      { name: '768', width: 768, height: 1024 },
      { name: '1440', width: 1440, height: 900 },
    ];

    const routes = [
      { path: '/', slug: 'home' },
      { path: '/watch/0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c10', slug: 'watch' },
      { path: '/c/winkey_creator', slug: 'channel' },
      { path: '/login', slug: 'login' },
      { path: '/register', slug: 'register' },
      { path: '/upload', slug: 'upload' },
      { path: '/studio', slug: 'studio' },
    ];

    const screenshotDir = path.join(process.cwd(), 'screenshots');
    if (!fs.existsSync(screenshotDir)) {
      fs.mkdirSync(screenshotDir, { recursive: true });
    }

    for (const vp of viewports) {
      await page.setViewportSize({ width: vp.width, height: vp.height });

      const vpDir = path.join(screenshotDir, `${vp.name}px`);
      if (!fs.existsSync(vpDir)) {
        fs.mkdirSync(vpDir, { recursive: true });
      }

      for (const route of routes) {
        await page.goto(route.path);
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(600);

        const screenshotPath = path.join(vpDir, `${route.slug}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: false });
      }
    }
  });
});
