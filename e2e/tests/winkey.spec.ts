import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import type { PlaybackHeartbeatBatch } from '../../packages/api-client/src';

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

  test('PL2: Play watch page ~35s, capture start + heartbeat samples with valid OpenAPI schema (Task U8)', async ({
    page,
  }) => {
    test.setTimeout(90000);

    const capturedBatches: PlaybackHeartbeatBatch[] = [];
    page.on('request', (req) => {
      if (req.url().includes('/v1/playback/heartbeats') && req.method() === 'POST') {
        try {
          const data = req.postDataJSON() as PlaybackHeartbeatBatch;
          if (data && Array.isArray(data.samples)) {
            capturedBatches.push(data);
          }
        } catch {
          // ignore non-json
        }
      }
    });

    const targetVideoId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c10';
    await page.goto(`/watch/${targetVideoId}`);
    await page.waitForLoadState('domcontentloaded');

    const video = page.locator('video');
    await expect(video).toBeVisible();

    // Trigger play and simulate forward playback in real browser time for ~32s
    await page.evaluate(() => {
      const v = document.querySelector('video');
      if (v) {
        v.dispatchEvent(new Event('play'));
        v.dispatchEvent(new Event('playing'));

        // Emit timeupdate every 1 second
        (
          window as unknown as { __playbackInterval?: ReturnType<typeof setInterval> }
        ).__playbackInterval = setInterval(() => {
          const current = (v.currentTime || 0) + 1;
          Object.defineProperty(v, 'currentTime', {
            value: current,
            configurable: true,
            writable: true,
          });
          v.dispatchEvent(new Event('timeupdate'));
        }, 1000);
      }
    });

    // Wait for at least one start and one heartbeat sample to be captured
    await expect
      .poll(
        async () => {
          const fromStorage = await page.evaluate(() => {
            try {
              return JSON.parse(sessionStorage.getItem('wk_mock_heartbeats') || '[]');
            } catch {
              return [];
            }
          });
          const allSamples = [...capturedBatches.flatMap((b) => b?.samples || []), ...fromStorage];
          const hasStart = allSamples.some((s: any) => s.kind === 'start');
          const hasHeartbeat = allSamples.some((s: any) => s.kind === 'heartbeat');
          return hasStart && hasHeartbeat;
        },
        { timeout: 60000, intervals: [1000] },
      )
      .toBe(true);

    // Stop timer
    await page.evaluate(() => {
      const win = window as unknown as { __playbackInterval?: ReturnType<typeof setInterval> };
      if (win.__playbackInterval) {
        clearInterval(win.__playbackInterval);
      }
    });

    // Validate captured samples conform to PlaybackHeartbeatBatch / PlaybackSample schema
    const fromStorage = await page.evaluate(() => {
      try {
        return JSON.parse(sessionStorage.getItem('wk_mock_heartbeats') || '[]');
      } catch {
        return [];
      }
    });
    const allSamples = [...capturedBatches.flatMap((b) => b?.samples || []), ...fromStorage];
    const startSample = allSamples.find((s: any) => s.kind === 'start');
    const heartbeatSample = allSamples.find((s: any) => s.kind === 'heartbeat');

    expect(startSample).toBeDefined();
    expect(startSample!.video_id).toBe(targetVideoId);
    expect(startSample!.seq).toBe(0);
    expect(startSample!.client).toBe('web');
    expect(typeof startSample!.startup_ms).toBe('number');
    expect(startSample!.playback_id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(new Date(startSample!.sent_at).toISOString()).toBe(startSample!.sent_at);

    expect(heartbeatSample).toBeDefined();
    expect(heartbeatSample!.video_id).toBe(targetVideoId);
    expect(heartbeatSample!.seq).toBeGreaterThanOrEqual(1);
    expect(heartbeatSample!.client).toBe('web');
    expect(heartbeatSample!.playback_id).toBe(startSample!.playback_id);
    expect(heartbeatSample!.watched_ms).toBeGreaterThanOrEqual(15000);
    expect(typeof heartbeatSample!.rebuffer_ms).toBe('number');
    expect(typeof heartbeatSample!.rebuffer_count).toBe('number');
    expect(new Date(heartbeatSample!.sent_at).toISOString()).toBe(heartbeatSample!.sent_at);
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

  test('U5: Account settings: update display name, change password, delete account', async ({
    page,
  }) => {
    // 1. Visit login with return_to parameter
    await page.goto('/login?return_to=/settings/account');
    await page.waitForLoadState('domcontentloaded');

    // 2. Log in as creator
    const loginForm = page.locator('form').filter({ has: page.locator('input[type="email"]') });
    await loginForm.locator('input[type="email"]').fill('creator@winkey.vn');
    await loginForm.locator('input[type="password"]').fill('Password123!');
    await loginForm.locator('button[type="submit"]').click();

    // Verify redirected back to /settings/account after login
    await page.waitForURL(/\/settings\/account/);
    await expect(page.locator('h1')).toBeVisible();

    // 3. Profile: update display name
    const profileForm = page.locator('form').filter({ has: page.locator('input#displayName') });
    const displayNameInput = profileForm.locator('input#displayName');
    await expect(displayNameInput).toHaveValue('Winkey Official Creator');
    await displayNameInput.fill('Winkey Premium Creator');

    await profileForm.locator('button[type="submit"]').click();

    // Verify toast notification
    await expect(page.locator('div[role="status"]').first()).toBeVisible({ timeout: 10000 });

    // Open user menu in top-bar and verify updated display name appears
    const avatarBtn = page.locator('header button').last();
    await avatarBtn.click();
    await expect(page.locator('header')).toContainText('Winkey Premium Creator');

    // 4. Password: change password
    const passwordForm = page.locator('form').filter({ has: page.locator('input#newPassword') });
    const currentPasswordInput = passwordForm.locator('input#currentPassword');
    const newPasswordInput = passwordForm.locator('input#newPassword');
    const confirmPasswordInput = passwordForm.locator('input#confirmPassword');

    await currentPasswordInput.fill('Password123!');
    await newPasswordInput.fill('BrandNewPassword123!');
    await confirmPasswordInput.fill('BrandNewPassword123!');

    await passwordForm.locator('button[type="submit"]').click();

    // Verify toast notification
    await expect(page.locator('div[role="status"]').first()).toBeVisible({ timeout: 10000 });

    // Verify user is still authenticated
    await expect(avatarBtn).toBeVisible();

    // 5. Danger Zone: delete account
    const deleteButton = page.getByRole('button', { name: /Delete Account|Xóa tài khoản/ });
    await deleteButton.click();

    const deleteDialog = page.locator('[role="dialog"]');
    await expect(deleteDialog).toBeVisible();

    // Fill handle and password
    const confirmHandleInput = deleteDialog.locator('input#confirmHandle');
    const deletePasswordInput = deleteDialog.locator('input#deletePassword');
    const confirmDeleteBtn = deleteDialog.locator('button[type="submit"]');

    await expect(confirmDeleteBtn).toBeDisabled();

    await confirmHandleInput.fill('winkey_creator');
    await deletePasswordInput.fill('BrandNewPassword123!');
    await expect(confirmDeleteBtn).toBeEnabled();

    await confirmDeleteBtn.click();

    // Verify redirected to home and session cleared
    await page.waitForURL(/\/(en|vi)?$/);
    await expect(page.locator('header')).toContainText(/Sign In|Đăng nhập/i);
  });

  test('U6: Browse sidebar -> Trending -> click video; signed-in -> Subscriptions feed', async ({
    page,
  }) => {
    // 1. Visit home page
    await page.goto('/vi');
    await page.waitForLoadState('domcontentloaded');

    // 2. Click Trending link in sidebar
    const trendingLink = page.locator('aside a[href*="/trending"]').first();
    await expect(trendingLink).toBeVisible({ timeout: 10000 });
    await trendingLink.click();

    // 3. Verify on Trending page
    await page.waitForURL(/\/trending/);
    await expect(page.locator('h1')).toContainText(/Thịnh hành|Trending/);

    // Verify video cards and rank badges are displayed
    const firstRankBadge = page.locator('[data-testid^="rank-badge-"]').first();
    await expect(firstRankBadge).toBeVisible({ timeout: 15000 });

    // 4. Click first video card to open watch page
    const firstVideoCard = page.locator('main a[href*="/watch/"]').first();
    await firstVideoCard.click();
    await page.waitForURL(/\/watch\/.+/);
    await expect(page.locator('video')).toBeVisible({ timeout: 15000 });

    // 5. Sign in as creator and navigate to Subscriptions feed
    await page.goto('/login?return_to=/feed/subscriptions');
    await page.waitForLoadState('domcontentloaded');

    const loginForm = page.locator('form').filter({ has: page.locator('input[type="email"]') });
    await loginForm.locator('input[type="email"]').fill('creator@winkey.vn');
    await loginForm.locator('input[type="password"]').fill('Password123!');
    await loginForm.locator('button[type="submit"]').click();

    // Wait for redirect to /feed/subscriptions
    await page.waitForURL(/\/feed\/subscriptions/);
    await expect(page.locator('h1')).toContainText(/Kênh đăng ký|Subscriptions/);

    // 6. Subscriptions link is now visible in sidebar
    const subsSidebarLink = page.locator('aside a[href*="/feed/subscriptions"]').first();
    await expect(subsSidebarLink).toBeVisible({ timeout: 10000 });
  });

  test('Flow 5: Task U7 — Player Subtitles, CC Menu, Storyboard Scrubbing and Studio Subtitles', async ({
    page,
  }) => {
    test.setTimeout(120000);

    // 1. Visit watch page with subtitles and storyboard
    await page.goto('/vi/watch/0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c10');
    await page.waitForLoadState('domcontentloaded');

    const video = page.locator('video');
    await expect(video).toBeVisible({ timeout: 15000 });

    // Verify native <track> elements with crossOrigin="anonymous"
    const tracks = page.locator('video track[kind="subtitles"]');
    await expect(tracks).toHaveCount(2);
    await expect(tracks.first()).toHaveAttribute('srclang', 'vi');

    // Open CC Menu
    const ccBtn = page.locator('[data-testid="cc-menu-button"]');
    await expect(ccBtn).toBeVisible({ timeout: 10000 });
    await ccBtn.click();

    // Verify CC dropdown options
    const ccDropdown = page.locator('[data-testid="cc-menu-dropdown"]');
    await expect(ccDropdown).toBeVisible();
    await expect(page.locator('[data-testid="cc-option-off"]')).toBeVisible();
    await expect(page.locator('[data-testid="cc-option-vi"]')).toBeVisible();
    await expect(page.locator('[data-testid="cc-option-en"]')).toBeVisible();

    // Select Vietnamese subtitles
    await page.locator('[data-testid="cc-option-vi"]').click();
    await expect(ccDropdown).not.toBeVisible();

    // Check localStorage persistence
    const savedLang = await page.evaluate(() => localStorage.getItem('winkey.subtitle_lang'));
    expect(savedLang).toBe('vi');

    // Press 'c' key to toggle captions
    await page.keyboard.press('c');
    const toggledLang = await page.evaluate(() => localStorage.getItem('winkey.subtitle_lang'));
    expect(toggledLang).toBe('off');

    // 2. Storyboard Scrubbing Hover
    const seekBar = page.locator('[data-testid="seek-bar"]');
    await expect(seekBar).toBeVisible();
    await seekBar.hover({ position: { x: 150, y: 5 } });

    // Preview container should appear
    const previewContainer = page.locator('[data-testid="seek-preview-container"]');
    await expect(previewContainer).toBeVisible({ timeout: 5000 });

    // 3. Studio Subtitles Management
    await page.goto('/vi/login?return_to=/vi/studio');
    await page.waitForLoadState('domcontentloaded');

    const loginForm = page.locator('form').filter({ has: page.locator('input[type="email"]') });
    await loginForm.locator('input[type="email"]').fill('creator@winkey.vn');
    await loginForm.locator('input[type="password"]').fill('Password123!');
    await loginForm.locator('button[type="submit"]').click();

    await page.waitForURL(/\/studio(?:\?.*)?$/, { timeout: 20000 });
    await expect(page.locator('h1')).toContainText(/Studio/i, { timeout: 15000 });

    // Open subtitles dialog for the first video
    const manageSubtitlesBtn = page.locator('[data-testid^="manage-subtitles-"]').first();
    await expect(manageSubtitlesBtn).toBeVisible({ timeout: 10000 });
    await manageSubtitlesBtn.click();

    // Verify dialog and tracks list
    const dialog = page.locator('[data-testid="video-subtitles-dialog"]');
    await expect(dialog).toBeVisible();
    await expect(page.locator('[data-testid="subtitle-row-vi"]')).toBeVisible();
    await expect(page.locator('[data-testid="subtitle-row-en"]')).toBeVisible();
    await expect(page.locator('[data-testid="upload-subtitle-form"]')).toBeVisible();
  });

  test('Capture screenshots across viewports: 375px, 768px, 1440px', async ({ page }) => {
    test.setTimeout(300000);

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
      { path: '/settings/account', slug: 'account-settings' },
      { path: '/trending', slug: 'trending' },
      { path: '/feed/subscriptions', slug: 'subscriptions' },
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

    // Capture light & dark screenshots for Trending and Subscriptions (vi)
    await page.setViewportSize({ width: 1440, height: 900 });
    const u6Pages = [
      { path: '/vi/trending', slug: 'trending' },
      { path: '/vi/feed/subscriptions', slug: 'subscriptions' },
    ];

    for (const p of u6Pages) {
      // Light mode
      await page.goto(p.path);
      await page.waitForLoadState('domcontentloaded');
      await page.evaluate(() => {
        localStorage.setItem('winkey-theme', 'light');
        document.documentElement.classList.remove('dark');
      });
      await page.waitForTimeout(500);
      await page.screenshot({
        path: path.join(screenshotDir, `${p.slug}-light-vi.png`),
        fullPage: false,
      });

      // Dark mode
      await page.evaluate(() => {
        localStorage.setItem('winkey-theme', 'dark');
        document.documentElement.classList.add('dark');
      });
      await page.waitForTimeout(500);
      await page.screenshot({
        path: path.join(screenshotDir, `${p.slug}-dark-vi.png`),
        fullPage: false,
      });
    }
  });

  test('Capture U7 screenshots: CC Menu, Storyboard, Studio Subtitles', async ({ page }) => {
    test.setTimeout(120000);

    const screenshotDir = path.join(process.cwd(), 'screenshots');
    const brainArtifactDir =
      'C:\\Users\\Admin\\.gemini\\antigravity\\brain\\e5a1d785-628e-4928-82fd-05d52f2cfb0b';

    const saveScreenshot = (srcName: string) => {
      const srcPath = path.join(screenshotDir, srcName);
      if (fs.existsSync(brainArtifactDir) && fs.existsSync(srcPath)) {
        fs.copyFileSync(srcPath, path.join(brainArtifactDir, srcName));
      }
    };

    await page.setViewportSize({ width: 1440, height: 900 });

    // 1. Player with CC Menu open (light & dark vi)
    for (const theme of ['light', 'dark'] as const) {
      await page.goto('/vi/watch/0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c10');
      await page.waitForLoadState('domcontentloaded');
      await page.evaluate((th) => {
        localStorage.setItem('winkey-theme', th);
        if (th === 'dark') document.documentElement.classList.add('dark');
        else document.documentElement.classList.remove('dark');
      }, theme);
      await page.waitForTimeout(500);

      const ccBtn = page.locator('[data-testid="cc-menu-button"]');
      await expect(ccBtn).toBeVisible({ timeout: 10000 });
      await ccBtn.click();
      await page.waitForTimeout(300);

      const fname = `player-cc-${theme}-vi.png`;
      await page.screenshot({ path: path.join(screenshotDir, fname), fullPage: false });
      saveScreenshot(fname);
    }

    // 2. Player with Storyboard Hover Preview (light & dark vi)
    for (const theme of ['light', 'dark'] as const) {
      await page.goto('/vi/watch/0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c10');
      await page.waitForLoadState('domcontentloaded');
      await page.evaluate((th) => {
        localStorage.setItem('winkey-theme', th);
        if (th === 'dark') document.documentElement.classList.add('dark');
        else document.documentElement.classList.remove('dark');
      }, theme);
      await page.waitForTimeout(500);

      const seekBar = page.locator('[data-testid="seek-bar"]');
      await expect(seekBar).toBeVisible({ timeout: 10000 });
      await seekBar.hover({ position: { x: 300, y: 8 } });
      await page.waitForSelector('[data-testid="storyboard-thumbnail"]', { timeout: 10000 });
      await page.waitForTimeout(300);

      const fname = `player-storyboard-${theme}-vi.png`;
      await page.screenshot({ path: path.join(screenshotDir, fname), fullPage: false });
      saveScreenshot(fname);
    }

    // 3. Studio Subtitles Section (light & dark vi)
    // First, log in as creator
    await page.goto('/vi/login');
    await page.waitForLoadState('domcontentloaded');
    const loginForm = page.locator('form').filter({ has: page.locator('input[type="email"]') });
    if (await loginForm.isVisible()) {
      await loginForm.locator('input[type="email"]').fill('creator@winkey.vn');
      await loginForm.locator('input[type="password"]').fill('Password123!');
      await loginForm.locator('button[type="submit"]').click();
      await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 15000 });
    }

    for (const theme of ['light', 'dark'] as const) {
      await page.goto('/vi/studio/videos/0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c10');
      await page.waitForLoadState('domcontentloaded');
      await page.evaluate((th) => {
        localStorage.setItem('winkey-theme', th);
        if (th === 'dark') document.documentElement.classList.add('dark');
        else document.documentElement.classList.remove('dark');
      }, theme);
      await page.waitForTimeout(500);

      await expect(page.locator('[data-testid="studio-subtitles-section"]')).toBeVisible({
        timeout: 15000,
      });
      await page.waitForTimeout(300);

      const fname = `studio-subtitles-${theme}-vi.png`;
      await page.screenshot({ path: path.join(screenshotDir, fname), fullPage: false });
      saveScreenshot(fname);
    }
  });

  test('N1-web: In-app notification bell flow (sign in -> badge 3 -> click VIDEO_COMMENT -> watch page highlighted -> badge 2 -> mark all -> badge hidden)', async ({
    page,
  }) => {
    // Reset notification state
    await page.request.post('http://localhost:3000/v1/test/reset-notifications').catch(() => {});

    // 1. Sign in as creator
    await page.goto('/vi/login');
    await page.waitForLoadState('domcontentloaded');
    const loginForm = page.locator('form').filter({ has: page.locator('input[type="email"]') });
    if (await loginForm.isVisible()) {
      await loginForm.locator('input[type="email"]').fill('creator@winkey.vn');
      await loginForm.locator('input[type="password"]').fill('Password123!');
      await loginForm.locator('button[type="submit"]').click();
      await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 15000 });
    }

    // 2. Bell button is visible, badge shows 3
    const bellButton = page.locator('[data-testid="notification-bell-button"]');
    await expect(bellButton).toBeVisible({ timeout: 10000 });
    const badge = page.locator('[data-testid="notification-badge"]');
    await expect(badge).toHaveText('3', { timeout: 10000 });

    // 3. Open notification dropdown
    await bellButton.click();
    const dropdown = page.locator('[role="dialog"][aria-label="Thông báo"]');
    await expect(dropdown).toBeVisible({ timeout: 5000 });

    // 4. Click a VIDEO_COMMENT item
    const commentItem = page.locator(
      '[data-testid="notification-item-0192f5e4-9000-7000-8000-000000000001"]',
    );
    await expect(commentItem).toBeVisible({ timeout: 5000 });
    await commentItem.click();

    // 5. Lands on watch page with comment highlighted
    await page.waitForURL(
      (url) => url.pathname.includes('/watch/') && url.search.includes('comment='),
      {
        timeout: 15000,
      },
    );
    const highlightedComment = page.locator(
      '[data-testid="comment-item-0192f5e4-7c1a-7b3e-9d2a-c00000000001"]',
    );
    await expect(highlightedComment).toBeVisible({ timeout: 15000 });
    await expect(highlightedComment).toHaveAttribute('data-highlighted', 'true', {
      timeout: 10000,
    });

    // 6. Badge shows 2
    await expect(badge).toHaveText('2', { timeout: 10000 });

    // 7. Click bell again -> click "Đánh dấu đã đọc tất cả" -> badge hidden
    await bellButton.click();
    await expect(dropdown).toBeVisible({ timeout: 5000 });
    const markAllBtn = dropdown.locator('button', { hasText: 'Đánh dấu đã đọc tất cả' });
    await expect(markAllBtn).toBeVisible({ timeout: 5000 });
    await markAllBtn.click();

    // Badge is hidden
    await expect(badge).toBeHidden({ timeout: 10000 });
  });

  test('N2-web: Realtime notification hint updates badge without waiting for polling', async ({
    page,
  }) => {
    let socketServer: any = null;
    let welcomeSent = false;

    // Reset notifications
    await page.request.post('http://localhost:3000/v1/test/reset-notifications').catch(() => {});

    // Route WebSocket connections to mock realtime-gw
    await page.routeWebSocket('**/v1/realtime*', (ws) => {
      socketServer = ws;
      ws.send(
        JSON.stringify({
          type: 'welcome',
          connection_id: '018f3a22-7f91-7d9a-9e12-3456789abcde',
          user_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c01',
          heartbeat_interval_ms: 25000,
        }),
      );
      welcomeSent = true;
    });

    // 1. Sign in as creator
    await page.goto('/vi/login');
    await page.waitForLoadState('domcontentloaded');
    const loginForm = page.locator('form').filter({ has: page.locator('input[type="email"]') });
    if (await loginForm.isVisible()) {
      await loginForm.locator('input[type="email"]').fill('creator@winkey.vn');
      await loginForm.locator('input[type="password"]').fill('Password123!');
      await loginForm.locator('button[type="submit"]').click();
      await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 15000 });
    }

    // 2. Bell button is visible, initial badge shows 3
    const bellButton = page.locator('[data-testid="notification-bell-button"]');
    await expect(bellButton).toBeVisible({ timeout: 10000 });
    const badge = page.locator('[data-testid="notification-badge"]');
    await expect(badge).toHaveText('3', { timeout: 10000 });

    // Ensure WebSocket is connected
    await expect
      .poll(() => welcomeSent, { message: 'Waiting for WebSocket connection' })
      .toBe(true);

    // 3. Add a new unread notification on the backend via test helper inside browser MSW
    await page.evaluate(async () => {
      const res = await fetch('/v1/test/add-notification', { method: 'POST' });
      if (!res.ok) throw new Error(`Failed to add notification: ${res.status}`);
    });

    // Badge should still show 3 because polling is 5 minutes when realtime is connected
    await expect(badge).toHaveText('3');

    // 4. Push realtime notification.hint over WebSocket
    socketServer.send(
      JSON.stringify({
        type: 'event',
        room: 'user:0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c01',
        event: 'notification.hint',
        data: { kind: 'VIDEO_COMMENT' },
        ts: new Date().toISOString(),
      }),
    );

    // 5. Badge updates to 4 after hint without waiting for 5-minute poll
    await expect(badge).toHaveText('4', { timeout: 10000 });
  });

  test('PL1-web: Save a video to watch later -> open Xem sau -> see it -> remove it', async ({
    page,
  }) => {
    // 1. Sign in as creator
    await page.goto('/vi/login');
    await page.waitForLoadState('domcontentloaded');
    const loginForm = page.locator('form').filter({ has: page.locator('input[type="email"]') });
    if (await loginForm.isVisible()) {
      await loginForm.locator('input[type="email"]').fill('creator@winkey.vn');
      await loginForm.locator('input[type="password"]').fill('Password123!');
      await loginForm.locator('button[type="submit"]').click();
      await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 15000 });
    }

    // 2. Navigate to a video watch page
    const videoId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c12';
    await page.goto(`/vi/watch/${videoId}`);
    await page.waitForLoadState('domcontentloaded');

    // 3. Click "Xem sau" action button on watch page
    const watchLaterBtn = page.locator('[data-testid="watch-page-watch-later-btn"]');
    await expect(watchLaterBtn).toBeVisible({ timeout: 10000 });
    await watchLaterBtn.click();

    // Verify toast confirms addition
    await expect(page.locator('text=Đã thêm vào danh sách Xem sau')).toBeVisible({ timeout: 5000 });

    // 4. Open "Xem sau" via sidebar link or direct navigation
    const sidebarWatchLater = page.locator('aside a', { hasText: 'Xem sau' });
    if (await sidebarWatchLater.isVisible()) {
      await sidebarWatchLater.click();
    } else {
      await page.goto('/vi/playlist/watch-later');
    }
    await page.waitForURL((url) => url.pathname.includes('/playlist/'), { timeout: 15000 });

    // 5. Verify the video is present in the Watch Later playlist
    const itemLocator = page.locator(`[data-testid="playlist-item-${videoId}"]`);
    await expect(itemLocator).toBeVisible({ timeout: 10000 });

    // 6. Remove the video from the playlist
    const removeBtn = page.locator(`[data-testid="remove-item-btn-${videoId}"]`);
    await expect(removeBtn).toBeVisible({ timeout: 5000 });
    await removeBtn.click();

    // 7. Verify toast and item is removed
    await expect(page.locator('text=Đã xóa video khỏi danh sách')).toBeVisible({ timeout: 5000 });
    await expect(itemLocator).toBeHidden({ timeout: 5000 });
  });

  test('R1-b-web: Creator statistics in studio (open studio -> Thống kê -> switch 7 days -> open top video -> verify title and totals)', async ({
    page,
  }) => {
    // 1. Sign in as creator
    await page.goto('/vi/login');
    await page.waitForLoadState('domcontentloaded');
    const loginForm = page.locator('form').filter({ has: page.locator('input[type="email"]') });
    if (await loginForm.isVisible()) {
      await loginForm.locator('input[type="email"]').fill('creator@winkey.vn');
      await loginForm.locator('input[type="password"]').fill('Password123!');
      await loginForm.locator('button[type="submit"]').click();
      await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 15000 });
    }

    // 2. Open studio page
    await page.goto('/vi/studio');
    await page.waitForLoadState('domcontentloaded');

    // 3. Click "Thống kê" in studio nav
    const statsNavBtn = page.locator('[data-testid="studio-nav-analytics"]');
    await expect(statsNavBtn).toBeVisible({ timeout: 10000 });
    await statsNavBtn.click();
    await page.waitForURL((url) => url.pathname.includes('/studio/analytics'), { timeout: 15000 });

    // 4. Verify channel stats components are visible
    await expect(page.locator('[data-testid="kpi-starts"]')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('[data-testid="stats-daily-chart"]')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('[data-testid="top-videos-table"]')).toBeVisible({ timeout: 10000 });

    // 5. Switch to 7 days range
    const range7Btn = page.locator('[data-testid="range-btn-7"]');
    await expect(range7Btn).toBeVisible({ timeout: 5000 });
    await range7Btn.click();

    // 6. Open a top video
    const firstTopVideoLink = page.locator('[data-testid^="top-video-link-"]').first();
    await expect(firstTopVideoLink).toBeVisible({ timeout: 10000 });
    const videoTitle = await firstTopVideoLink.locator('span').first().innerText();
    await firstTopVideoLink.click();

    // 7. Its stats page loads and shows the right title and totals
    await page.waitForURL((url) => url.pathname.includes('/analytics'), { timeout: 15000 });
    const headerTitle = page.locator('[data-testid="video-studio-title"]');
    await expect(headerTitle).toBeVisible({ timeout: 10000 });
    await expect(headerTitle).toHaveText(videoTitle);

    // Verify video KPI cards
    await expect(page.locator('[data-testid="kpi-starts"]')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('[data-testid="kpi-watch-time"]')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('[data-testid="kpi-view-count"]')).toBeVisible({ timeout: 10000 });
  });
});
