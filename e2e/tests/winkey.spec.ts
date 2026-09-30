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

  test('U2: Studio realtime: video.progress and video.ready update state in real time without page reload', async ({
    page,
  }) => {
    const videoId = '018f3a22-7f91-7d9a-9e12-000000000099';
    let socketServer: any = null;
    let isSubscribed = false;

    // Route WebSocket connections to mock realtime-gw
    await page.routeWebSocket('**/v1/realtime*', (ws) => {
      socketServer = ws;
      ws.onMessage((msg) => {
        try {
          const parsed = JSON.parse(msg);
          if (parsed.type === 'subscribe' && parsed.room === `upload:${videoId}`) {
            isSubscribed = true;
          }
        } catch {
          // ignore
        }
      });

      // Send welcome frame matching contract
      ws.send(
        JSON.stringify({
          type: 'welcome',
          connection_id: '018f3a22-7f91-7d9a-9e12-3456789abcde',
          user_id: '018f3a22-7f91-7d9a-9e12-3456789abcde',
          heartbeat_interval_ms: 25000,
        }),
      );
    });

    // Navigate to studio
    await page.goto('/studio');
    await page.waitForLoadState('domcontentloaded');

    const videoRow = page.locator(`tr:has-text("${videoId}")`);

    // 1. Initial state: 15% progress is visible
    await expect(videoRow.locator('text=15%')).toBeVisible({ timeout: 15000 });

    // Wait until client has connected and subscribed to upload:{videoId}
    await expect
      .poll(() => isSubscribed, { message: 'Waiting for client to subscribe to room' })
      .toBe(true);

    // 2. Server sends video.progress (70%) over WebSocket
    socketServer.send(
      JSON.stringify({
        type: 'event',
        room: `upload:${videoId}`,
        event: 'video.progress',
        data: {
          video_id: videoId,
          stage: 'TRANSCODING',
          percent: 70,
        },
        ts: new Date().toISOString(),
      }),
    );

    // Verify 70% appears without page reload
    await expect(videoRow.locator('text=70%')).toBeVisible({ timeout: 10000 });

    // 3. Server sends video.ready over WebSocket
    socketServer.send(
      JSON.stringify({
        type: 'event',
        room: `upload:${videoId}`,
        event: 'video.ready',
        data: {
          video_id: videoId,
        },
        ts: new Date().toISOString(),
      }),
    );

    // Verify status changes to Ready / Sẵn sàng without page reload
    await expect(videoRow.getByText(/Ready|Sẵn sàng/)).toBeVisible({ timeout: 10000 });
  });

  test('U4: Moderator hides reported video & resolves case; Admin edits roles & suspends user', async ({
    page,
  }) => {
    // --- Part 1: Moderator flow ---
    // 1. Log in as moderator
    await page.goto('/login');
    await page.waitForLoadState('domcontentloaded');

    await page.fill('input[type="email"]', 'mod@winkey.vn');
    await page.fill('input[type="password"]', 'any-valid-password');

    const [loginRes] = await Promise.all([
      page.waitForResponse((res) => res.url().includes('/v1/auth/login') && res.status() === 200),
      page.locator('main button[type="submit"]').click(),
    ]);
    expect(loginRes.status()).toBe(200);
    await page.context().addCookies([
      {
        name: 'wk_rt',
        value: 'mock-refresh-0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c04',
        domain: 'localhost',
        path: '/',
      },
    ]);

    // 2. Navigate to /admin
    await page.goto('/admin');
    await page.waitForLoadState('domcontentloaded');

    // Expect Moderation Queue and Users tabs, but not Audit Log
    await expect(page.getByText(/Admin & Moderation Panel|Bảng điều khiển quản trị/)).toBeVisible({
      timeout: 10000,
    });
    await expect(page.getByText(/Moderation Queue|Hàng đợi báo cáo/)).toBeVisible();
    await expect(page.getByText(/Audit Log|Nhật ký/)).not.toBeVisible();

    // 3. Open moderation modal on the first case
    const moderateBtn = page.getByRole('button', { name: /Moderate|Xử lý/ }).first();
    await expect(moderateBtn).toBeVisible({ timeout: 10000 });
    await moderateBtn.click();

    // Fill action reason and confirm
    const modal = page.locator('[role="dialog"]');
    await expect(modal).toBeVisible();

    const reasonInput = modal.locator('input#action-reason');
    await reasonInput.fill('Inappropriate content and copyright violations');

    const confirmBtn = modal.locator('button[type="submit"]');
    await confirmBtn.click();

    // Verify modal closes and resolution succeeds
    await expect(modal).not.toBeVisible({ timeout: 10000 });

    // --- Part 2: Admin flow ---
    // 1. Log in as admin
    await page.goto('/login');
    await page.waitForLoadState('domcontentloaded');

    await page.fill('input[type="email"]', 'admin@winkey.vn');
    await page.fill('input[type="password"]', 'any-valid-password');

    const [adminLoginRes] = await Promise.all([
      page.waitForResponse((res) => res.url().includes('/v1/auth/login') && res.status() === 200),
      page.locator('main button[type="submit"]').click(),
    ]);
    expect(adminLoginRes.status()).toBe(200);
    await page.context().addCookies([
      {
        name: 'wk_rt',
        value: 'mock-refresh-0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c03',
        domain: 'localhost',
        path: '/',
      },
    ]);

    // 2. Navigate to /admin
    await page.goto('/admin');
    await page.waitForLoadState('domcontentloaded');

    // Admin should see Audit Log tab
    await expect(page.getByText(/Audit Log|Nhật ký/)).toBeVisible();

    // Switch to Users tab
    await page.getByText(/Users|Người dùng/).click();

    // Search for a user
    const searchInput = page.locator(
      'main input[placeholder*="Search"], main input[placeholder*="Tìm"]',
    );
    await searchInput.fill('tech');
    await page.waitForTimeout(500); // debounce 300ms

    // Target row
    const userRow = page.locator('tr:has-text("tech@winkey.vn")').first();
    await expect(userRow).toBeVisible();

    // 3. Edit roles: grant moderator role
    await userRow.getByRole('button', { name: /Edit Roles|Đổi quyền/ }).click();
    const rolesDialog = page.locator('[role="dialog"]');
    await expect(rolesDialog).toBeVisible();

    const modCheckbox = rolesDialog.locator('input[type="checkbox"]').nth(2); // moderator
    await modCheckbox.check();

    await rolesDialog.locator('button[type="submit"]').click();
    await expect(rolesDialog).not.toBeVisible({ timeout: 10000 });

    // 4. Suspend user with reason
    await userRow.getByRole('button', { name: /Suspend|Khóa/ }).click();
    const suspendDialog = page.locator('[role="dialog"]');
    await expect(suspendDialog).toBeVisible();

    const suspendReasonInput = suspendDialog.locator('input#suspend-reason-input');
    await suspendReasonInput.fill('Repeated platform violations');

    await suspendDialog.locator('button[type="submit"]').click();
    await expect(suspendDialog).not.toBeVisible({ timeout: 10000 });
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
      { path: '/admin', slug: 'admin' },
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
