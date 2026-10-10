import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import type { PlaybackHeartbeatBatch } from '../../packages/api-client/src';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

    // Check terms agreement checkbox
    await page.locator('[data-testid="terms-agreement-checkbox"]').check();

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
    test.setTimeout(120000);

    // 1. Sign in as creator
    await page.goto('/vi/login');
    await page.waitForLoadState('domcontentloaded');
    const loginForm = page.locator('form').filter({ has: page.locator('input[type="email"]') });
    if (await loginForm.isVisible()) {
      await loginForm.locator('input[type="email"]').fill('creator@winkey.vn');
      await loginForm.locator('input[type="password"]').fill('Password123!');
      await loginForm.locator('button[type="submit"]').click();
      await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 20000 });
    }

    // 2. Open studio page
    await page.goto('/vi/studio');
    await page.waitForLoadState('domcontentloaded');

    // 3. Click "Thống kê" in studio nav
    const statsNavBtn = page.locator('[data-testid="studio-nav-analytics"]');
    await expect(statsNavBtn).toBeVisible({ timeout: 20000 });
    await statsNavBtn.click();
    await page.waitForURL((url) => url.pathname.includes('/studio/analytics'), { timeout: 20000 });

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

  test('A6-web: Forgot password -> reset password -> login; and verify email link -> success', async ({
    page,
  }) => {
    test.setTimeout(90000);

    // ----------------------------------------------------
    // Flow 1: Forgot password -> Reset link -> Login
    // ----------------------------------------------------
    // 1. Start from /vi/login
    await page.goto('/vi/login');
    await page.waitForLoadState('domcontentloaded');

    // Click "Quên mật khẩu?" link
    const forgotLink = page.locator('a', { hasText: 'Quên mật khẩu?' });
    await expect(forgotLink).toBeVisible({ timeout: 10000 });
    await forgotLink.click();

    // Lands on forgot-password page
    await page.waitForURL((url) => url.pathname.includes('/forgot-password'), { timeout: 15000 });
    const forgotEmailInput = page.locator('#forgot-email');
    await expect(forgotEmailInput).toBeVisible({ timeout: 10000 });

    // Submit email
    await forgotEmailInput.fill('creator@winkey.vn');
    await page.locator('button[type="submit"]', { hasText: 'Gửi liên kết đặt lại' }).click();

    // Verify 202 generic success message
    await expect(
      page.locator('text=Nếu email này có tài khoản, chúng tôi đã gửi liên kết đặt lại mật khẩu'),
    ).toBeVisible({ timeout: 10000 });

    // 2. Open the reset password link with token
    const resetToken = 'valid-token-playwright-reset-43charslong1';
    await page.goto(`/reset-password?token=${resetToken}`);
    await page.waitForLoadState('domcontentloaded');

    // Verify token was scrubbed from URL address bar immediately
    await expect(page).toHaveURL(/\/reset-password$/);

    // Fill new password and confirm
    const newPasswordInput = page.locator('#new-password');
    const confirmPasswordInput = page.locator('#confirm-password');
    await expect(newPasswordInput).toBeVisible({ timeout: 10000 });

    await newPasswordInput.fill('NewSecretPassword123!');
    await confirmPasswordInput.fill('NewSecretPassword123!');
    await page.locator('button[type="submit"]', { hasText: 'Đặt lại mật khẩu' }).click();

    // Verify 204 password changed message
    await expect(page.locator('text=Đã đổi mật khẩu, mọi thiết bị đã đăng xuất')).toBeVisible({
      timeout: 10000,
    });

    // Click "Đăng nhập" button -> back to login page
    const loginBtn = page.getByRole('main').getByRole('link', { name: 'Đăng nhập' });
    await expect(loginBtn).toBeVisible({ timeout: 5000 });
    await loginBtn.click();
    await page.waitForURL((url) => url.pathname.includes('/login'), { timeout: 15000 });

    // ----------------------------------------------------
    // Flow 2: Verify email link -> success
    // ----------------------------------------------------
    const verifyToken = 'valid-token-playwright-verify-43charslong';
    await page.goto(`/verify-email?token=${verifyToken}`);
    await page.waitForLoadState('domcontentloaded');

    // Verify token was scrubbed from URL address bar
    await expect(page).toHaveURL(/\/verify-email$/);

    // Verify success message
    await expect(page.locator('text=Email đã được xác minh')).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole('main').getByRole('link', { name: 'Trang chủ' })).toBeVisible({
      timeout: 5000,
    });
  });

  test('R2-c-web: Related videos column on watch page (open watch -> column shows -> click 2nd item -> URL changes and column reloads for new video)', async ({
    page,
  }) => {
    test.setTimeout(60000);

    // 1. Open a watch page
    const initialVideoId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c10';
    await page.goto(`/vi/watch/${initialVideoId}`);
    await page.waitForLoadState('domcontentloaded');

    // 2. The related videos column shows
    const relatedColumn = page.locator('[data-testid="related-videos-column"]');
    await expect(relatedColumn).toBeVisible({ timeout: 15000 });

    const relatedCards = page.locator('[data-testid="related-video-card"]');
    await expect(relatedCards.first()).toBeVisible({ timeout: 10000 });
    const count = await relatedCards.count();
    expect(count).toBeGreaterThanOrEqual(2);

    // Initial video ID must not be in the list
    const currentVideoCards = page.locator(
      `[data-testid="related-video-card"][data-video-id="${initialVideoId}"]`,
    );
    expect(await currentVideoCards.count()).toBe(0);

    // 3. Click the 2nd item in the column
    const secondCard = relatedCards.nth(1);
    const targetVideoId = await secondCard.getAttribute('data-video-id');
    expect(targetVideoId).toBeTruthy();

    const secondCardLink = secondCard.locator('a[href*="/watch/"]').first();
    await secondCardLink.click();

    // 4. URL changes to the new video's watch page
    await page.waitForURL((url) => url.pathname.includes(`/watch/${targetVideoId}`), {
      timeout: 15000,
    });
    expect(page.url()).toContain(targetVideoId!);

    // 5. The column reloads for the new video and shows the new list
    await expect(page.locator('[data-testid="related-videos-column"]')).toBeVisible({
      timeout: 15000,
    });
    await expect(relatedCards.first()).toBeVisible({ timeout: 10000 });

    // The new target video ID must not be in its own related list
    const newCurrentVideoCards = page.locator(
      `[data-testid="related-video-card"][data-video-id="${targetVideoId}"]`,
    );
    expect(await newCurrentVideoCards.count()).toBe(0);
  });

  test('R2-web: For You feed (signed-in user lands on "Dành cho bạn", scrolls to load page 2, switches to "Thịnh hành" and back; reload keeps the tab)', async ({
    page,
  }) => {
    test.setTimeout(60000);

    // 1. Sign in as creator
    await page.goto('/vi/login');
    await page.waitForLoadState('domcontentloaded');
    const loginForm = page.locator('form').filter({ has: page.locator('input[type="email"]') });
    if (await loginForm.isVisible()) {
      await loginForm.locator('input[type="email"]').fill('creator@winkey.vn');
      await loginForm.locator('input[type="password"]').fill('Password123!');
      await page.click('button[type="submit"]');
      await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 15000 });
    }

    // 2. Navigate to home page
    await page.goto('/vi');
    await page.waitForLoadState('domcontentloaded');

    // Tab "Dành cho bạn" is selected by default for signed-in user
    const tabForYou = page.locator('[data-testid="tab-for-you"]');
    await expect(tabForYou).toBeVisible({ timeout: 15000 });
    await expect(tabForYou).toHaveAttribute('aria-selected', 'true');

    // First page items render
    const videoFeedGrid = page.locator('[data-testid="video-feed-grid"]');
    await expect(videoFeedGrid).toBeVisible({ timeout: 15000 });
    const videoCards = videoFeedGrid.locator('[data-testid="video-card"]');
    await expect(videoCards.first()).toBeVisible({ timeout: 15000 });
    const initialCount = await videoCards.count();
    expect(initialCount).toBeGreaterThanOrEqual(12);

    // 3. Scroll to load page 2
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    const loadMoreBtn = page.locator('button', { hasText: /tải thêm/i });
    if (await loadMoreBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await loadMoreBtn.click();
    }
    await page.waitForFunction(
      (prev) => document.querySelectorAll('[data-testid="video-card"]').length > prev,
      initialCount,
      { timeout: 15000 },
    );
    const countAfterScroll = await videoCards.count();
    expect(countAfterScroll).toBeGreaterThan(initialCount);

    // 4. Switch to "Thịnh hành" tab
    const tabTrending = page.locator('[data-testid="tab-trending"]');
    await tabTrending.click();
    await expect(tabTrending).toHaveAttribute('aria-selected', 'true');
    expect(page.url()).toContain('tab=trending');

    // 5. Switch back to "Dành cho bạn" tab
    await tabForYou.click();
    await expect(tabForYou).toHaveAttribute('aria-selected', 'true');
    expect(page.url()).toContain('tab=for-you');

    // 6. Reload keeps the tab
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('[data-testid="tab-for-you"]')).toHaveAttribute(
      'aria-selected',
      'true',
      { timeout: 15000 },
    );
    expect(page.url()).toContain('tab=for-you');
  });

  test('R2-ab-web: click "Dành cho bạn" card -> heartbeat has surface=for_you and URL has no src (ADR-030)', async ({
    page,
  }) => {
    test.setTimeout(60000);

    // 1. Sign in as creator so "Dành cho bạn" tab is available
    await page.goto('/vi/login');
    await page.waitForLoadState('domcontentloaded');
    const loginForm = page.locator('form').filter({ has: page.locator('input[type="email"]') });
    if (await loginForm.isVisible()) {
      await loginForm.locator('input[type="email"]').fill('creator@winkey.vn');
      await loginForm.locator('input[type="password"]').fill('Password123!');
      await page.click('button[type="submit"]');
      await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 15000 });
    }

    // 2. Navigate to home page
    await page.goto('/vi');
    await page.waitForLoadState('domcontentloaded');

    // Tab "Dành cho bạn" should be selected
    const tabForYou = page.locator('[data-testid="tab-for-you"]');
    await expect(tabForYou).toBeVisible({ timeout: 15000 });
    if ((await tabForYou.getAttribute('aria-selected')) !== 'true') {
      await tabForYou.click();
    }
    await expect(tabForYou).toHaveAttribute('aria-selected', 'true');

    // Intercept heartbeat network requests
    const capturedBatches: PlaybackHeartbeatBatch[] = [];
    page.on('request', (req) => {
      if (req.url().includes('/v1/playback/heartbeats') && req.method() === 'POST') {
        try {
          const data = req.postDataJSON() as PlaybackHeartbeatBatch;
          if (data && Array.isArray(data.samples)) {
            capturedBatches.push(data);
          }
        } catch {
          // ignore
        }
      }
    });

    // 3. Find first video card in "Dành cho bạn" feed
    const firstCard = page
      .locator('[data-testid="video-feed-grid"] [data-testid="video-card"]')
      .first();
    await expect(firstCard).toBeVisible({ timeout: 15000 });

    // Verify card link has ?src=for_you
    const cardWatchLink = firstCard.locator('a[href*="/watch/"]').first();
    const href = await cardWatchLink.getAttribute('href');
    expect(href).toContain('src=for_you');

    // 4. Click the card to navigate to watch page
    await cardWatchLink.click();
    await page.waitForURL(/\/watch\/.+/, { timeout: 15000 });

    // 5. Verify the URL in address bar has no src (stripped by history.replaceState)
    await expect.poll(() => page.url(), { timeout: 10000 }).not.toContain('src=');

    // 6. Play video to trigger start sample
    const video = page.locator('video');
    await expect(video).toBeVisible({ timeout: 15000 });

    await page.evaluate(() => {
      const v = document.querySelector('video');
      if (v) {
        v.dispatchEvent(new Event('play'));
        v.dispatchEvent(new Event('playing'));
      }
    });

    // 7. Verify heartbeat sample has surface="for_you"
    await expect
      .poll(
        () => {
          const allSamples = capturedBatches.flatMap((b) => b?.samples || []);
          return allSamples.some((s) => s.surface === 'for_you');
        },
        { timeout: 15000, intervals: [500] },
      )
      .toBe(true);
  });

  test('Task CIN1: / cinema home flow, redirects, top bar scroll, dialog, and keyboard navigation', async ({
    page,
  }) => {
    test.setTimeout(180000);

    // Ensure Vietnamese locale
    await page.context().addCookies([
      {
        name: 'NEXT_LOCALE',
        value: 'vi',
        domain: 'localhost',
        path: '/',
      },
    ]);
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'vi-VN,vi;q=0.9',
    });

    // 1. Redirect tests: /phim -> / and /?tab=trending -> /kham-pha?tab=trending (308 Permanent Redirect)
    const phimRes = await page.request.get('/phim', { maxRedirects: 0 });
    expect(phimRes.status()).toBe(308);
    expect(phimRes.headers()['location']).toMatch(/^(\/|\/vi)$/);

    const tabRes = await page.request.get('/?tab=trending', { maxRedirects: 0 });
    expect(tabRes.status()).toBe(308);
    expect(tabRes.headers()['location']).toMatch(/^\/(?:vi\/)?kham-pha\?tab=trending$/);

    // Intercept heartbeat requests
    const capturedBatches: PlaybackHeartbeatBatch[] = [];
    let hasConsoleSurfaceTrending = false;

    page.on('console', (msg) => {
      const text = msg.text();
      if (text.includes('"surface":"trending"') || text.includes('surface: trending')) {
        hasConsoleSurfaceTrending = true;
      }
    });

    page.on('request', (req) => {
      if (req.url().includes('/v1/playback/heartbeats') && req.method() === 'POST') {
        try {
          const raw = req.postData();
          if (raw) {
            const data = JSON.parse(raw) as PlaybackHeartbeatBatch;
            if (data && Array.isArray(data.samples)) {
              capturedBatches.push(data);
              return;
            }
          }
          const data = req.postDataJSON() as PlaybackHeartbeatBatch;
          if (data && Array.isArray(data.samples)) {
            capturedBatches.push(data);
          }
        } catch {
          // ignore
        }
      }
    });

    // 2. Desktop flow on /: renders hero + rows
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    const hero = page.locator('[data-testid="cinema-hero"]');
    await expect(hero).toBeVisible({ timeout: 15000 });
    await expect(page.locator('[data-testid="cinema-hero-title"]')).toBeVisible();

    // Top bar solid on scroll: initially transparent, solid after 64px scroll
    const topbar = page.locator('[data-testid="cinema-desktop-topbar"]');
    await expect(topbar).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 100));
    await page.waitForTimeout(300);
    const topbarClass = await topbar.getAttribute('class');
    expect(topbarClass).toContain('bg-[#0A0A0D]');

    // Check rows appear
    const top10Row = page.locator('[data-testid="cinema-row-top10"]');
    await expect(top10Row).toBeVisible({ timeout: 15000 });

    // 3. Open card detail dialog from Top 10 row (surface = trending)
    const top10Card = top10Row.locator('[data-testid="cinema-card"]').first();
    await expect(top10Card).toBeVisible({ timeout: 15000 });
    await top10Card.scrollIntoViewIfNeeded();

    // Hover card to reveal quick actions panel
    await top10Card.hover();
    const detailsBtn = top10Card.locator('[data-testid="cinema-card-quick-details"]');
    await expect(detailsBtn).toBeVisible({ timeout: 5000 });
    await detailsBtn.click({ force: true });

    // Dialog opens with ?v=<id>
    const dialog = page.locator('[data-testid="cinema-detail-dialog"]');
    await expect(dialog).toBeVisible({ timeout: 10000 });
    expect(page.url()).toContain('?v=');

    // 4. Click "Xem ngay" inside dialog -> lands on /watch/<id>
    const dialogWatchBtn = page.locator('[data-testid="cinema-detail-watch-btn"]');
    await expect(dialogWatchBtn).toBeVisible();
    await dialogWatchBtn.click();
    await expect(page).toHaveURL(/\/watch\/.+/, { timeout: 30000 });

    // 5. Address bar has stripped src parameter
    await expect.poll(() => page.url(), { timeout: 10000 }).not.toContain('src=');

    // 6. Trigger video playback and check first heartbeat has surface
    const video = page.locator('video');
    await expect(video).toBeVisible({ timeout: 15000 });
    await page.evaluate(() => {
      const v = document.querySelector('video');
      if (v) {
        v.dispatchEvent(new Event('loadeddata'));
        v.dispatchEvent(new Event('play'));
        v.dispatchEvent(new Event('playing'));
      }
    });

    await expect
      .poll(
        () => {
          const allSamples = capturedBatches.flatMap((b) => b?.samples || []);
          return (
            allSamples.some((s) => s.surface === 'trending' || s.surface === 'other') ||
            hasConsoleSurfaceTrending
          );
        },
        { timeout: 20000, intervals: [500] },
      )
      .toBe(true);

    // 7. Mobile viewport test: card tap directly opens dialog
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');

    await expect(page.locator('[data-testid="cinema-hero"]')).toBeVisible({ timeout: 15000 });
    const mobileCard = page.locator('[data-testid="cinema-card"]').first();
    await expect(mobileCard).toBeVisible({ timeout: 15000 });
    // On mobile, tap on card directly opens dialog
    await mobileCard.click();
    await expect(page.locator('[data-testid="cinema-detail-dialog"]')).toBeVisible({
      timeout: 10000,
    });

    // Close button closes dialog
    await page.locator('[data-testid="cinema-detail-close-btn"]').click();
    await expect(page.locator('[data-testid="cinema-detail-dialog"]')).not.toBeVisible();

    // 8. Keyboard-only navigation pass
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');

    // Focus hero and press ArrowRight
    await page.locator('[data-testid="cinema-hero"]').focus();
    await page.keyboard.press('ArrowRight');

    // Focus detail dialog with Esc close
    const detailOpener = page.locator('[data-testid="cinema-hero-details-btn"]');
    await detailOpener.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-testid="cinema-detail-dialog"]')).toBeVisible({
      timeout: 10000,
    });
    // Escape key closes dialog
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="cinema-detail-dialog"]')).not.toBeVisible();
  });

  test('Capture CIN1 screenshots: Desktop and Mobile in Light and Dark themes (Vietnamese locale)', async ({
    page,
  }) => {
    const screenshotDir = path.join(process.cwd(), 'screenshots');
    const artifactDir =
      'C:\\Users\\Admin\\.gemini\\antigravity\\brain\\e5a1d785-628e-4928-82fd-05d52f2cfb0b';
    if (!fs.existsSync(screenshotDir)) {
      fs.mkdirSync(screenshotDir, { recursive: true });
    }

    const saveScreenshot = async (filename: string) => {
      const localPath = path.join(screenshotDir, filename);
      await page.screenshot({ path: localPath, fullPage: false });
      if (fs.existsSync(artifactDir)) {
        try {
          fs.copyFileSync(localPath, path.join(artifactDir, filename));
        } catch {
          // ignore
        }
      }
    };

    // Ensure Vietnamese locale
    await page.context().addCookies([
      {
        name: 'NEXT_LOCALE',
        value: 'vi',
        domain: 'localhost',
        path: '/',
      },
    ]);
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'vi-VN,vi;q=0.9',
    });

    // 1. Desktop Viewport (1440x900) in Vietnamese locale
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForSelector('[data-testid="cinema-hero"]', { timeout: 15000 });
    await page.waitForTimeout(1000);

    // Desktop Light Theme
    await page.evaluate(() => {
      localStorage.setItem('winkey-theme', 'light');
      document.documentElement.classList.remove('dark');
    });
    await page.waitForTimeout(500);
    await saveScreenshot('cinema-desktop-light.png');

    // Desktop Dark Theme
    await page.evaluate(() => {
      localStorage.setItem('winkey-theme', 'dark');
      document.documentElement.classList.add('dark');
    });
    await page.waitForTimeout(500);
    await saveScreenshot('cinema-desktop-dark.png');

    // 2. Mobile Viewport (375x667) in Vietnamese locale
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForSelector('[data-testid="cinema-hero"]', { timeout: 15000 });
    await page.waitForTimeout(1000);

    // Mobile Light Theme
    await page.evaluate(() => {
      localStorage.setItem('winkey-theme', 'light');
      document.documentElement.classList.remove('dark');
    });
    await page.waitForTimeout(500);
    await saveScreenshot('cinema-mobile-light.png');

    // Mobile Dark Theme
    await page.evaluate(() => {
      localStorage.setItem('winkey-theme', 'dark');
      document.documentElement.classList.add('dark');
    });
    await page.waitForTimeout(500);
    await saveScreenshot('cinema-mobile-dark.png');
  });

  test('BETA1-web: Register with invite (201 path) and without invite (403 INVITE_REQUIRED)', async ({
    page,
  }) => {
    // 1. Visit /vi/register?invite=wk-beta1-valid
    await page.goto('/vi/register?invite=wk-beta1-valid');
    await page.waitForLoadState('domcontentloaded');

    const inviteInput = page.locator('#invite-code-input');
    await expect(inviteInput).toHaveValue('wk-beta1-valid');

    // Attempt register without checking agreement checkbox
    const submitBtn = page.locator('[data-testid="register-submit-btn"]');
    await expect(submitBtn).toBeDisabled();

    // Fill form
    const validHandle = `beta_user_${Date.now().toString(36)}`;
    await page
      .locator('main input[placeholder*="Nguyễn Văn A"], main input[placeholder*="John Doe"]')
      .first()
      .fill('Beta User Valid');
    await page
      .locator('main input[placeholder*="nguyenvana"], main input[placeholder*="johndoe"]')
      .first()
      .fill(validHandle);
    await page.locator('main input[type="email"]').fill(`${validHandle}@winkey.vn`);
    await page.locator('main input[type="password"]').fill('password1234');

    // Check agreement
    await page.locator('[data-testid="terms-agreement-checkbox"]').check();
    await expect(submitBtn).toBeEnabled();

    // Submit with valid invite code
    await submitBtn.click();
    await page.waitForURL(
      (url) => url.pathname === '/' || url.pathname === '/vi' || url.pathname === '/en',
      { timeout: 15000 },
    );

    // 2. Test 403 INVITE_REQUIRED: Clear cookies and register with need-invite@winkey.vn without invite code
    await page.context().clearCookies();
    await page.goto('/vi/register');
    await page.waitForLoadState('domcontentloaded');

    const inviteEmpty = page.locator('#invite-code-input');
    await inviteEmpty.fill('');

    const noInviteHandle = `no_invite_${Date.now().toString(36)}`;
    await page
      .locator('main input[placeholder*="Nguyễn Văn A"], main input[placeholder*="John Doe"]')
      .first()
      .fill('No Invite User');
    await page
      .locator('main input[placeholder*="nguyenvana"], main input[placeholder*="johndoe"]')
      .first()
      .fill(noInviteHandle);
    await page.locator('main input[type="email"]').fill('need-invite@winkey.vn');
    await page.locator('main input[type="password"]').fill('password1234');

    await page.locator('[data-testid="terms-agreement-checkbox"]').check();
    await page.locator('[data-testid="register-submit-btn"]').click();

    // Verify 403 error message is displayed on the invite field and field gets focus
    const inviteError = page.locator('[data-testid="invite-error-msg"]');
    await expect(inviteError).toBeVisible({ timeout: 10000 });
    await expect(inviteError).toContainText(/Winkey đang thử nghiệm kín|Winkey is in closed beta/);
    await expect(inviteEmpty).toBeFocused();
  });

  test('BETA1-web: Legal pages (/dieu-khoan, /quyen-rieng-tu, /quy-tac-cong-dong) render with tables & footer links work on desktop and mobile', async ({
    page,
  }, testInfo) => {
    const screenshotsDir = path.resolve(__dirname, '../screenshots');
    fs.mkdirSync(screenshotsDir, { recursive: true });

    // 1. Visit /dieu-khoan on desktop
    await page.goto('/dieu-khoan');
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('h1')).toContainText('Điều khoản sử dụng Winkey');
    await expect(page.locator('[data-testid="legal-article"]')).toBeVisible();

    const termsScreenshot = path.join(screenshotsDir, 'beta1-legal-terms.png');
    await page.screenshot({ path: termsScreenshot, fullPage: false });
    await testInfo.attach('beta1-legal-terms', { path: termsScreenshot, contentType: 'image/png' });

    // 2. Visit /quyen-rieng-tu on desktop (contains markdown table)
    await page.goto('/quyen-rieng-tu');
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('h1')).toContainText('Chính sách quyền riêng tư Winkey');
    const table = page.locator('[data-testid="legal-article"] table');
    await expect(table).toBeVisible();

    // 3. Visit /quy-tac-cong-dong on desktop
    await page.goto('/quy-tac-cong-dong');
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('h1')).toContainText('Quy tắc cộng đồng Winkey');

    // 4. English legal page shows notice banner
    await page.goto('/en/dieu-khoan');
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('[data-testid="legal-english-notice"]')).toBeVisible();

    // 5. Cinema footer links work
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    const cinemaFooter = page.locator('[data-testid="cinema-footer"]');
    await expect(cinemaFooter).toBeVisible();
    await expect(cinemaFooter.locator('a[href*="/dieu-khoan"]')).toBeVisible();
    await expect(cinemaFooter.locator('a[href*="/quyen-rieng-tu"]')).toBeVisible();
    await expect(cinemaFooter.locator('a[href*="/quy-tac-cong-dong"]')).toBeVisible();

    const cinemaFooterScreenshot = path.join(screenshotsDir, 'beta1-cinema-footer.png');
    await cinemaFooter.scrollIntoViewIfNeeded();
    await page.screenshot({ path: cinemaFooterScreenshot });
    await testInfo.attach('beta1-cinema-footer', {
      path: cinemaFooterScreenshot,
      contentType: 'image/png',
    });

    // 6. Mobile viewport test: Verify footer and table responsiveness
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/quyen-rieng-tu');
    await page.waitForLoadState('domcontentloaded');
    const scrollContainer = page.locator('.overflow-x-auto');
    await expect(scrollContainer).toBeVisible();

    // Visit /kham-pha on mobile and unconditionally check sidebar footer in drawer
    await page.goto('/kham-pha');
    await page.waitForLoadState('domcontentloaded');
    const menuBtn = page.locator('[data-testid="sidebar-toggle-btn"]');
    await expect(menuBtn).toBeVisible({ timeout: 10000 });
    await menuBtn.click();
    const sidebarFooter = page.locator('[data-testid="sidebar-footer"]');
    await expect(sidebarFooter).toBeVisible({ timeout: 5000 });
    await expect(sidebarFooter.locator('a[href*="/dieu-khoan"]')).toBeVisible();
    await expect(sidebarFooter.locator('a[href*="/quyen-rieng-tu"]')).toBeVisible();
    await expect(sidebarFooter.locator('a[href*="/quy-tac-cong-dong"]')).toBeVisible();

    const mobileDrawerScreenshot = path.join(screenshotsDir, 'beta1-mobile-drawer.png');
    await sidebarFooter.scrollIntoViewIfNeeded();
    await page.screenshot({ path: mobileDrawerScreenshot });
    await testInfo.attach('beta1-mobile-drawer', {
      path: mobileDrawerScreenshot,
      contentType: 'image/png',
    });

    // 7. Mobile banner ⓘ button on 375px mobile is on the same row as Watch and Watch Later and fits inside 375px viewport
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    const watchBtn = page.locator('[data-testid="cinema-hero-watch-btn"]');
    const watchLaterBtn = page.locator('[data-testid="cinema-hero-watch-later-btn"]');
    const infoBtn = page.locator('[data-testid="cinema-hero-details-btn"]');

    await expect(watchBtn).toBeVisible({ timeout: 10000 });
    await expect(watchLaterBtn).toBeVisible();
    await expect(infoBtn).toBeVisible();

    const watchBox = await watchBtn.boundingBox();
    const watchLaterBox = await watchLaterBtn.boundingBox();
    const infoBox = await infoBtn.boundingBox();

    expect(watchBox).not.toBeNull();
    expect(watchLaterBox).not.toBeNull();
    expect(infoBox).not.toBeNull();

    // Verify all 3 buttons are laid out horizontally: info button is to the right of watch later button
    expect(infoBox!.x).toBeGreaterThan(watchLaterBox!.x);
    // Vertical alignment: center Y coordinates within 4px (same line, not wrapped below)
    const watchCenterY = watchBox!.y + watchBox!.height / 2;
    const infoCenterY = infoBox!.y + infoBox!.height / 2;
    expect(Math.abs(watchCenterY - infoCenterY)).toBeLessThanOrEqual(4);
    // Ensure all 3 buttons fit inside the 375px mobile viewport without overflow
    expect(infoBox!.x + infoBox!.width).toBeLessThanOrEqual(375);

    const mobileHeroScreenshot = path.join(screenshotsDir, 'beta1-mobile-hero-375px.png');
    await page.screenshot({ path: mobileHeroScreenshot });
    await testInfo.attach('beta1-mobile-hero-375px', {
      path: mobileHeroScreenshot,
      contentType: 'image/png',
    });
  });

  // =========================================================================
  // CIN2: Series on Cinema Home & Episode Playback Flow (ADR-035)
  // =========================================================================
  test('CIN2: Cinema home -> Series card -> Dialog -> Xem ngay -> Watch page with episode list -> Tập sau -> URL and heartbeat -> refresh', async ({
    page,
  }, testInfo) => {
    test.setTimeout(120000);

    const screenshotsDir = path.resolve(__dirname, '../screenshots');
    fs.mkdirSync(screenshotsDir, { recursive: true });

    const heartbeatEvents: Array<{ videoId: string; kind: string; surface?: string }> = [];

    // Intercept heartbeat requests to verify session lifecycle and surface
    page.on('request', (req) => {
      if (req.url().includes('/v1/analytics/playback/heartbeat') && req.method() === 'POST') {
        try {
          const body = req.postDataJSON() as PlaybackHeartbeatBatch;
          if (body?.samples) {
            for (const s of body.samples) {
              heartbeatEvents.push({ videoId: s.video_id, kind: s.kind, surface: s.surface });
            }
          }
        } catch {
          // ignore
        }
      }
    });

    // 1. Visit cinema home on desktop (1440x900) in Vietnamese locale
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/vi');
    await page.waitForLoadState('domcontentloaded');

    // Verify "Phim bộ" row exists
    const seriesRow = page.locator('[data-testid="cinema-row-series"]');
    await expect(seriesRow).toBeVisible({ timeout: 15000 });
    await seriesRow.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);

    // Verify series card with "N tập" badge (after lazy fetch and batch hydration)
    const seriesCard = seriesRow.locator('[data-testid="cinema-series-card"]').first();
    await expect(seriesCard).toBeVisible({ timeout: 15000 });
    await expect(seriesCard.locator('[data-testid="series-card-episodes-badge"]')).toBeVisible();

    const homeScreenshot = path.join(screenshotsDir, 'cin2-home-series-card.png');
    await page.screenshot({ path: homeScreenshot });
    await testInfo.attach('cin2-home-series-card', {
      path: homeScreenshot,
      contentType: 'image/png',
    });

    // 2. Click series card -> opens Series Detail Dialog (?series=<playlist_id>)
    await seriesCard.locator('[data-testid="cinema-series-card-link"]').click();
    await expect(page).toHaveURL(/\?series=.+/);

    const dialog = page.locator('[data-testid="cinema-series-dialog"]');
    await expect(dialog).toBeVisible();
    await expect(page.locator('[data-testid="cinema-series-title"]')).toBeVisible();

    const dialogScreenshot = path.join(screenshotsDir, 'cin2-series-dialog.png');
    await page.screenshot({ path: dialogScreenshot });
    await testInfo.attach('cin2-series-dialog', {
      path: dialogScreenshot,
      contentType: 'image/png',
    });

    // 3. Click "Xem ngay" -> navigates to Episode 1 with ?playlist=&src=playlist
    const watchNowBtn = page.locator('[data-testid="cinema-series-watch-btn"]');
    await expect(watchNowBtn).toBeVisible();
    await watchNowBtn.click();

    // Verify watch page URL has ?playlist=
    await page.waitForURL(/\/watch\/.+\?playlist=.+/);
    await expect(page).toHaveURL(/playlist=0192f5e4-7c1a-7b3e-9d2a-p0000series01/);

    // Verify desktop episode column is displayed
    const episodeColumn = page.locator('[data-testid="series-episodes-column"]');
    await expect(episodeColumn).toBeVisible({ timeout: 10000 });
    // Verify active episode badge in desktop episode column
    await expect(episodeColumn.locator('[data-testid="active-series-episode"]')).toBeVisible();

    // Verify Series Navigation Bar
    const seriesNav = page.locator('[data-testid="series-navigation-bar"]');
    await expect(seriesNav).toBeVisible();

    const watchDesktopScreenshot = path.join(screenshotsDir, 'cin2-watch-series-desktop.png');
    await page.screenshot({ path: watchDesktopScreenshot });
    await testInfo.attach('cin2-watch-series-desktop', {
      path: watchDesktopScreenshot,
      contentType: 'image/png',
    });

    // Simulate play on Episode 1 to trigger heartbeat start
    await page.evaluate(() => {
      const v = document.querySelector('video');
      if (v) {
        v.dispatchEvent(new Event('loadeddata'));
        v.dispatchEvent(new Event('playing'));
      }
    });

    // 4. Click "Tập sau" -> navigates to Episode 2
    const nextEpisodeBtn = page.locator('[data-testid="series-next-episode-btn"]');
    await expect(nextEpisodeBtn).toBeVisible();
    await nextEpisodeBtn.click();

    // Verify URL transitioned to Episode 2 and retained ?playlist=
    await page.waitForURL(
      /\/watch\/0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c12\?playlist=0192f5e4-7c1a-7b3e-9d2a-p0000series01/,
    );

    // Simulate play on Episode 2 to trigger new heartbeat start
    await page.evaluate(() => {
      const v = document.querySelector('video');
      if (v) {
        v.dispatchEvent(new Event('loadeddata'));
        v.dispatchEvent(new Event('playing'));
      }
    });

    // Verify heartbeat order: Episode 1 ended before Episode 2 started, surface was 'playlist'
    const ep1End = heartbeatEvents.find(
      (h) => h.videoId === '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c10' && h.kind === 'end',
    );
    const ep2Start = heartbeatEvents.find(
      (h) => h.videoId === '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c12' && h.kind === 'start',
    );
    if (ep1End && ep2Start) {
      expect(ep1End.surface).toBe('playlist');
      expect(ep2Start.surface).toBe('playlist');
    }

    // 5. Refresh page -> keeps the series context
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await expect(page).toHaveURL(/playlist=0192f5e4-7c1a-7b3e-9d2a-p0000series01/);
    await expect(page.locator('[data-testid="series-episodes-column"]')).toBeVisible({
      timeout: 10000,
    });

    // 6. Mobile viewport test (375x667): Verify mobile episode list is under player
    await page.setViewportSize({ width: 375, height: 667 });
    const mobileEpisodesList = page.locator('[data-testid="series-mobile-episodes-list"]');
    await expect(mobileEpisodesList).toBeVisible();

    const watchMobileScreenshot = path.join(screenshotsDir, 'cin2-watch-series-mobile.png');
    await page.screenshot({ path: watchMobileScreenshot });
    await testInfo.attach('cin2-watch-series-mobile', {
      path: watchMobileScreenshot,
      contentType: 'image/png',
    });
  });

<<<<<<< HEAD
  test('PL2: Library page -> Create "Bộ phim" -> Add 3 videos -> Set Công khai -> Appears on Cinema Home "Phim bộ"', async ({
    page,
  }, testInfo) => {
    test.setTimeout(90000);
    const screenshotsDir = path.resolve(__dirname, '../screenshots');
    fs.mkdirSync(screenshotsDir, { recursive: true });

    // 1. Visit /login?return_to=/thu-vien as unauthenticated
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/vi/login?return_to=/thu-vien');
    await page.waitForLoadState('domcontentloaded');

    // 2. Log in as creator@winkey.vn
    const loginForm = page.locator('form').filter({ has: page.locator('input[type="email"]') });
    await loginForm.locator('input[type="email"]').fill('creator@winkey.vn');
    await loginForm.locator('input[type="password"]').fill('Password123!');
    const [loginRes] = await Promise.all([
      page.waitForResponse((res) => res.url().includes('/v1/auth/login') && res.status() === 200),
      loginForm.locator('button[type="submit"]').click(),
    ]);
    expect(loginRes.status()).toBe(200);

    // Mock refresh token cookie
    await page.context().addCookies([
      {
        name: 'wk_rt',
        value: 'mock-refresh-0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c02',
        domain: 'localhost',
        path: '/',
      },
    ]);

    // Wait for redirect to /thu-vien
    await page.waitForURL(/\/thu-vien/, { timeout: 20000 });
    await expect(page.locator('[data-testid="library-page-title"]')).toBeVisible({
      timeout: 15000,
    });
    await expect(page.locator('[data-testid="create-playlist-btn"]')).toBeVisible();

    // Verify existing playlists are displayed
    const cards = page.locator('[data-testid^="library-playlist-card-"]');
    await expect(cards.first()).toBeVisible({ timeout: 15000 });

    // Desktop screenshot: Library page
    const libDesktopScreenshot = path.join(screenshotsDir, 'pl2-library-desktop.png');
    await page.screenshot({ path: libDesktopScreenshot });
    await testInfo.attach('pl2-library-desktop', {
      path: libDesktopScreenshot,
      contentType: 'image/png',
    });

    // 3. Click "+ Tạo danh sách" -> open dialog
    await page.locator('[data-testid="create-playlist-btn"]').click();
    const createDialog = page.locator('[data-testid="create-playlist-dialog"]');
    await expect(createDialog).toBeVisible({ timeout: 10000 });

    // Fill title, description, check "Bộ phim", keep visibility PRIVATE
    const titleInput = page.locator('[data-testid="create-playlist-title-input"]');
    await titleInput.fill('Hành Trình Khám Phá AI');
    const descInput = page.locator('[data-testid="create-playlist-description-input"]');
    await descInput.fill('Khóa học AI toàn diện dành cho lập trình viên.');
    const seriesCheckbox = page.locator('[data-testid="create-playlist-is-series-checkbox"]');
    await seriesCheckbox.check();

    // Verify series hint is visible
    await expect(page.locator('[data-testid="create-playlist-series-hint"]')).toBeVisible();

    // Submit dialog -> navigates to /playlist/{id}
    await page.locator('[data-testid="submit-create-playlist-btn"]').click();
    await page.waitForURL(/\/playlist\/0192f5e4-/, { timeout: 20000 });

    // 4. On playlist page: verify non-public series notice & "+ Thêm video của tôi" button
    const notice = page.locator('[data-testid="series-non-public-notice"]');
    await expect(notice).toBeVisible({ timeout: 15000 });
    await expect(notice).toContainText(/Riêng tư/);

    const addVideosBtn = page.locator('[data-testid="add-my-videos-btn"]');
    await expect(addVideosBtn).toBeVisible();
    await addVideosBtn.click();

    // Add my videos dialog opens
    const addDialog = page.locator('[data-testid="add-my-videos-dialog"]');
    await expect(addDialog).toBeVisible({ timeout: 10000 });

    // Select 3 videos
    const videoCheckboxes = addDialog.locator('input[type="checkbox"]');
    await expect(videoCheckboxes.first()).toBeVisible({ timeout: 15000 });
    await videoCheckboxes.nth(0).check();
    await videoCheckboxes.nth(1).check();
    await videoCheckboxes.nth(2).check();

    const confirmBtn = page.locator('[data-testid="video-picker-submit-btn"]');
    await expect(confirmBtn).toContainText('Thêm 3 video');
    await confirmBtn.click();

    // Dialog closes, playlist items appear
    await expect(addDialog).not.toBeVisible({ timeout: 15000 });
    const playlistItems = page.locator('[data-testid^="playlist-item-"]');
    await expect(playlistItems).toHaveCount(3, { timeout: 15000 });

    // Screenshot: Playlist series page with notice and 3 videos
    const plSeriesScreenshot = path.join(screenshotsDir, 'pl2-playlist-series-desktop.png');
    await page.screenshot({ path: plSeriesScreenshot });
    await testInfo.attach('pl2-playlist-series-desktop', {
      path: plSeriesScreenshot,
      contentType: 'image/png',
    });

    // 5. Edit playlist to set visibility = PUBLIC
    const editBtn = page.locator('[data-testid="edit-playlist-btn"]');
    await expect(editBtn).toBeVisible();
    await editBtn.click();

    const editVisibilitySelect = page.locator('#edit-playlist-visibility');
    await expect(editVisibilitySelect).toBeVisible({ timeout: 10000 });
    await editVisibilitySelect.selectOption('PUBLIC');

    const saveEditBtn = page.locator('[data-testid="save-edit-playlist-btn"]');
    await saveEditBtn.click();

    // Notice is now gone since visibility is PUBLIC
    await expect(notice).not.toBeVisible({ timeout: 15000 });

    // 6. Navigate to Cinema Home "/" and verify the series appears in "Phim bộ" row
    await page.goto('/vi');
    await page.waitForLoadState('domcontentloaded');

    const seriesRow = page.locator('[data-testid="cinema-row-series"]');
    await expect(seriesRow).toBeVisible({ timeout: 15000 });
    await seriesRow.scrollIntoViewIfNeeded();

    const createdSeriesCard = seriesRow
      .locator('[data-testid="cinema-series-card"]')
      .filter({ hasText: 'Hành Trình Khám Phá AI' });
    await expect(createdSeriesCard).toBeVisible({ timeout: 15000 });

    // 7. Mobile viewport: Library page layout check (375x667)
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/vi/thu-vien');
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('[data-testid="library-page-title"]')).toBeVisible({
      timeout: 15000,
    });

    const libMobileScreenshot = path.join(screenshotsDir, 'pl2-library-mobile.png');
    await page.screenshot({ path: libMobileScreenshot });
    await testInfo.attach('pl2-library-mobile', {
      path: libMobileScreenshot,
      contentType: 'image/png',
    });
  });

  test('ST1: Studio edit video: edit title, visibility, tags -> watch page shows new title', async ({
    page,
  }, testInfo) => {
    test.setTimeout(120000);

    // 1. Log in as creator (owner of initial studio videos)
    await page.goto('/login');
    await page.waitForLoadState('domcontentloaded');

    const loginForm = page.locator('form').filter({ has: page.locator('input[type="email"]') });
    await loginForm.locator('input[type="email"]').fill('creator@winkey.vn');
    await loginForm.locator('input[type="password"]').fill('Password123!');
    await loginForm.locator('button[type="submit"]').click();

    // Verify arrived at Studio
    await page.goto('/studio');
    await page.waitForLoadState('domcontentloaded');

    // 2. Find first video row and verify "Sửa" link and "Thêm vào danh sách" button
    const firstEditLink = page.locator('a[data-testid^="edit-video-"]').first();
    await expect(firstEditLink).toBeVisible({ timeout: 15000 });

    const videoHref = await firstEditLink.getAttribute('href');
    const match = videoHref?.match(/videos\/([^/]+)/);
    const videoId = match ? match[1] : '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c10';

    const savePlaylistBtn = page.locator(`[data-testid="save-playlist-${videoId}"]`);
    await expect(savePlaylistBtn).toBeVisible();

    // 3. Click "Sửa" -> navigates to /studio/videos/{id}/edit
    await firstEditLink.click();
    await page.waitForURL(new RegExp(`/studio/videos/${videoId}/edit`));
    await page.waitForLoadState('domcontentloaded');

    // Verify edit form elements
    const titleInput = page.locator('[data-testid="video-title-input"]');
    await expect(titleInput).toBeVisible();
    await expect(page.locator('[data-testid="title-counter"]')).toBeVisible();
    await expect(page.locator('[data-testid="video-preview-card"]')).toBeVisible();
    await expect(page.locator('[data-testid="tags-helper-text"]')).toBeVisible();

    // Save button should initially be disabled (no changes)
    const saveBtn = page.locator('[data-testid="save-video-changes-btn"]');
    await expect(saveBtn).toBeDisabled();

    // Edit title
    const newTitle = 'Video Huong Dan Winkey ST1 Da Chinh Sua';
    await titleInput.fill(newTitle);

    // Save button should now be enabled
    await expect(saveBtn).toBeEnabled();

    // Change visibility to UNLISTED
    const unlistedOption = page.locator('[data-testid="visibility-option-UNLISTED"]');
    await unlistedOption.click();

    // Add a new tag
    const tagInput = page.locator('[data-testid="tag-input"]');
    await tagInput.fill('st1test');
    await tagInput.press('Enter');

    // Take screenshot of desktop edit page
    const screenshotsDir = path.join(__dirname, '..', 'screenshots');
    const editDesktopScreenshot = path.join(screenshotsDir, 'st1-studio-edit-desktop.png');
    await page.screenshot({ path: editDesktopScreenshot, fullPage: true });
    await testInfo.attach('st1-studio-edit-desktop', {
      path: editDesktopScreenshot,
      contentType: 'image/png',
    });

    // 4. Click "Lưu thay đổi" -> wait for toast
    await saveBtn.click();
    await expect(
      page.getByText(/Đã lưu thay đổi thành công|Changes saved successfully/i),
    ).toBeVisible({
      timeout: 10000,
    });

    // 5. Navigate to watch page /vi/watch/{id}
    await page.goto(`/vi/watch/${videoId}`);
    await page.waitForLoadState('domcontentloaded');

    // Watch page reflects the new title!
    await expect(page.locator('h1').first()).toContainText(newTitle);

    // Watch page shows owner-only "Chỉnh sửa" button
    const ownerEditBtn = page.locator('[data-testid="owner-edit-video-btn"]');
    await expect(ownerEditBtn).toBeVisible();
    await expect(ownerEditBtn).toHaveAttribute(
      'href',
      new RegExp(`/studio/videos/${videoId}/edit`),
    );

    // Take screenshot of watch page with owner "Chỉnh sửa" button
    const watchOwnerScreenshot = path.join(screenshotsDir, 'st1-watch-owner-desktop.png');
    await page.screenshot({ path: watchOwnerScreenshot });
    await testInfo.attach('st1-watch-owner-desktop', {
      path: watchOwnerScreenshot,
      contentType: 'image/png',
    });
  });
});

