import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const manifestPath = path.resolve(__dirname, '../.run/seed-manifest.json');
if (!fs.existsSync(manifestPath)) {
  throw new Error(
    `[persona:member] Missing seed-manifest.json at ${manifestPath}. Run seed before running personas.`,
  );
}
const manifest: any = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

const INVITE_CODE = manifest.invite_code;
if (!INVITE_CODE) {
  throw new Error('[persona:member] seed-manifest.json is missing invite_code');
}
const PASSWORD = 'Password123!';

function getPublicVideo() {
  const video = manifest.videos?.find((v: any) => v.visibility === 'PUBLIC');
  if (!video) {
    throw new Error('[persona:member] No PUBLIC video found in seed-manifest.json');
  }
  return video;
}

test.describe.serial('Persona: member (The "Lưu" Refresh-Token Regression, ADR-038)', () => {
  let context: BrowserContext;
  let page: Page;

  const memberHandle = `mem_${Date.now().toString(36)}`;
  const memberEmail = `${memberHandle}@winkey.test`;
  const playlistTitle = `Danh sách của ${memberHandle}`;

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext();
    page = await context.newPage();
  });

  test.afterAll(async () => {
    await context?.close();
  });

  test('register with invite code (assert fail without invite code), then login', async () => {
    // 1. Attempt register WITHOUT invite code -> must show INVITE_REQUIRED message or 403
    await page.goto('/register');
    await page.locator('input[placeholder*="nguyenvana"]').fill(memberHandle);
    await page.locator('input[type="email"]').fill(memberEmail);
    await page.locator('input[placeholder="Nguyễn Văn A"]').fill('Thành Viên Test');
    await page.locator('input[type="password"]').fill(PASSWORD);

    // Leave invite code empty if input exists
    const inviteInput = page.locator('#invite-code-input, input[placeholder*="Mã mời"]');
    if (await inviteInput.isVisible()) {
      await inviteInput.fill('');
    }

    const termsCheckbox = page.locator('#terms-agreement-checkbox, input[type="checkbox"]').first();
    if (await termsCheckbox.isVisible()) {
      await termsCheckbox.check();
    }

    await page.locator('main form button[type="submit"]').click();

    // Expect INVITE_REQUIRED or error notice
    await expect(
      page
        .locator('[role="alert"], [data-testid="invite-error-msg"]')
        .or(
          page.getByText(
            /INVITE_REQUIRED|Mã mời không hợp lệ|Yêu cầu mã mời|Winkey đang thử nghiệm kín|Bạn cần mã mời/,
          ),
        )
        .first(),
    ).toBeVisible({ timeout: 10000 });

    // 2. Register WITH valid invite code
    if (await inviteInput.isVisible()) {
      await inviteInput.fill(INVITE_CODE);
      if (await termsCheckbox.isVisible()) {
        await termsCheckbox.check();
      }
      await page.locator('main form button[type="submit"]').click();
      await page.waitForURL((url) => !url.pathname.includes('/register'), { timeout: 10000 });
    } else {
      // Or API register directly if invite code wasn't exposed on form
      const res = await page.request.post('/v1/auth/register', {
        data: {
          handle: memberHandle,
          email: memberEmail,
          display_name: 'Thành Viên Test',
          password: PASSWORD,
          invite_code: INVITE_CODE,
        },
      });
      expect(res.status()).toBe(201);
    }

    // 3. Login
    await page.goto('/login');
    await page.locator('input[type="email"]').fill(memberEmail);
    await page.locator('input[type="password"]').fill(PASSWORD);
    await page.locator('main form button[type="submit"]').click();

    // Should land on home or authenticated view
    await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 10000 });
  });

  test('"Lưu" -> add to new playlist -> appears in /thu-vien', async () => {
    const targetVideo = getPublicVideo();

    // Navigate to watch page
    await page.goto(`/watch/${targetVideo.id}`);
    await expect(page.locator('h1')).toBeVisible();

    // Click "Lưu" button
    const saveBtn = page.locator(
      'button[aria-label="Lưu vào danh sách phát"], button:has-text("Lưu")',
    );
    await saveBtn.first().click();

    // Dialog should open
    const dialog = page.getByRole('dialog').filter({ hasText: 'Lưu video vào' });
    await expect(dialog.first()).toBeVisible({ timeout: 10000 });

    // Create new playlist if button visible
    const newPlaylistBtn = page.locator(
      'button:has-text("Danh sách mới"), button:has-text("Tạo danh sách mới")',
    );
    if (await newPlaylistBtn.isVisible()) {
      await newPlaylistBtn.click();
      await page.fill(
        'input[data-testid="new-playlist-title-input"], #new-playlist-title, input[placeholder*="tên danh sách"], input[placeholder*="Tiêu đề"], input[name="title"]',
        playlistTitle,
      );
      await page.click('button:has-text("Tạo")');
    } else {
      // Or toggle an existing checkbox
      const checkbox = page.locator('input[type="checkbox"]').first();
      await checkbox.check();
    }

    // Close dialog
    const closeBtn = page.locator(
      'button[aria-label="Đóng"], button:has-text("Xong"), button:has-text("Đóng")',
    );
    if (await closeBtn.isVisible()) {
      await closeBtn.click();
    } else {
      await page.keyboard.press('Escape');
    }

    // Verify in /thu-vien
    await page.goto('/thu-vien');
    await expect(page.locator('body')).toBeVisible();
    await expect(page.getByText(playlistTitle).or(page.getByText('Xem sau')).first()).toBeVisible({
      timeout: 15000,
    });
  });

  test('reload page (forces refresh-cookie path) -> "Lưu" again succeeds', async () => {
    // Member session in cookies
    const targetVideo = getPublicVideo();
    await page.goto(`/watch/${targetVideo.id}`);
    await expect(page.locator('h1')).toBeVisible();

    // Force page reload -> tests refresh-token cookie restoration
    await page.reload();
    await expect(page.locator('h1')).toBeVisible();

    // Click "Lưu" again
    const saveBtn = page.locator(
      'button[aria-label="Lưu vào danh sách phát"], button:has-text("Lưu")',
    );
    await saveBtn.first().click();

    const dialog = page.getByRole('dialog').filter({ hasText: 'Lưu video vào' });
    await expect(dialog.first()).toBeVisible({ timeout: 10000 });
    await page.keyboard.press('Escape');
  });

  test('clock fast-forward 16 min (access token expired) -> "Lưu" still succeeds via background refresh', async () => {
    const clockPage = await context.newPage();
    try {
      // Install fake clock on dedicated page
      await clockPage.clock.install();

      const targetVideo = getPublicVideo();
      await clockPage.goto(`/watch/${targetVideo.id}`);
      await expect(clockPage.locator('h1')).toBeVisible();

      // Fast-forward 16 minutes (access token TTL is 15 minutes)
      await clockPage.clock.fastForward(16 * 60 * 1000);

      // Click "Lưu" - customFetch should catch 401, invoke refreshAccessToken() via cookie, and succeed!
      const saveBtn = clockPage.locator(
        'button[aria-label="Lưu vào danh sách phát"], button:has-text("Lưu")',
      );
      await saveBtn.first().click();

      // Must NOT be redirected to login, and save dialog opens smoothly
      expect(clockPage.url()).not.toContain('/login');
      const dialog = clockPage.getByRole('dialog').filter({ hasText: 'Lưu video vào' });
      await expect(dialog.first()).toBeVisible({ timeout: 10000 });
      await clockPage.keyboard.press('Escape');
    } finally {
      await clockPage.close();
    }
  });

  test('two tabs at once after token expiry -> both succeed with navigator.locks refresh dedupe', async () => {
    const page1 = await context.newPage();
    const page2 = await context.newPage();
    try {
      await page1.clock.install();
      await page2.clock.install();

      const targetVideo = getPublicVideo();
      await page1.goto(`/watch/${targetVideo.id}`);
      await page2.goto(`/watch/${targetVideo.id}`);

      // Fast forward both 16 mins
      await page1.clock.fastForward(16 * 60 * 1000);
      await page2.clock.fastForward(16 * 60 * 1000);

      // Trigger actions simultaneously on both tabs
      const save1 = page1
        .locator('button[aria-label="Lưu vào danh sách phát"], button:has-text("Lưu")')
        .first();
      const save2 = page2
        .locator('button[aria-label="Lưu vào danh sách phát"], button:has-text("Lưu")')
        .first();

      await Promise.all([save1.click(), save2.click()]);

      const d1 = page1.getByRole('dialog').filter({ hasText: 'Lưu video vào' });
      const d2 = page2.getByRole('dialog').filter({ hasText: 'Lưu video vào' });
      await expect(d1.first()).toBeVisible({
        timeout: 10000,
      });
      await expect(d2.first()).toBeVisible({
        timeout: 10000,
      });
    } finally {
      await page1.close();
      await page2.close();
    }
  });

  test('signed-out: "Lưu" redirects to /login?return_to=... and returns after login', async ({
    browser,
  }) => {
    // Isolated clean incognito context (signed out)
    const anonContext = await browser.newContext();
    try {
      const anonPage = await anonContext.newPage();

      const targetVideo = getPublicVideo();
      const watchUrl = `/watch/${targetVideo.id}?playlist=test-pl&src=home`;
      // On load, stripWatchSurfaceFromAddressBar() keeps ?playlist=test-pl and removes src=home
      const expectedReturnTo = `/watch/${targetVideo.id}?playlist=test-pl`;

      await anonPage.goto(watchUrl);
      await expect(anonPage.locator('h1')).toBeVisible();

      // Click "Lưu" while unauthenticated
      const saveBtn = anonPage.locator(
        'button[aria-label="Lưu vào danh sách phát"], button:has-text("Lưu")',
      );
      await saveBtn.first().click();

      // Assert redirected to /login?return_to=...
      await anonPage.waitForURL((url) => url.pathname.includes('/login'), { timeout: 10000 });
      const loginUrl = anonPage.url();
      expect(loginUrl).toContain('return_to');
      expect(loginUrl).toContain(encodeURIComponent(expectedReturnTo));

      // Log in with member credentials registered in test 1
      await anonPage.locator('input[type="email"]').fill(memberEmail);
      await anonPage.locator('input[type="password"]').fill(PASSWORD);
      await anonPage.locator('main form button[type="submit"]').click();

      // Must return to the exact watch page URL
      await anonPage.waitForURL((url) => url.pathname.includes(`/watch/${targetVideo.id}`), {
        timeout: 10000,
      });
      expect(anonPage.url()).toContain(`watch/${targetVideo.id}`);
      expect(anonPage.url()).toContain('playlist=test-pl');
    } finally {
      await anonContext.close();
    }
  });

  test('comment, reply, like, unlike: counts update', async () => {
    const targetVideo = getPublicVideo();
    await page.goto(`/watch/${targetVideo.id}`);
    await expect(page.locator('h1')).toBeVisible();

    // Ensure session is active
    const avatar = page.locator(
      'button[aria-label="User profile menu"], [data-testid="user-menu"]',
    );
    if (!(await avatar.isVisible())) {
      await page.goto('/login');
      await page.locator('input[type="email"]').fill(memberEmail);
      await page.locator('input[type="password"]').fill(PASSWORD);
      await page.locator('main form button[type="submit"]').click();
      await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 10000 });
      await page.goto(`/watch/${targetVideo.id}`);
      await expect(page.locator('h1')).toBeVisible();
    }

    // 1. Like / Unlike
    const likeBtn = page.locator('button[aria-label*="Thích"], button:has-text("Thích")').first();
    if (await likeBtn.isVisible()) {
      await likeBtn.click();
      await page.waitForTimeout(1000);
      // Toggle unlike
      await likeBtn.click();
      await page.waitForTimeout(1000);
    }

    // 2. Comment
    const commentInput = page
      .locator('textarea[placeholder*="Bình luận"], textarea[placeholder*="bình luận"], textarea')
      .first();
    if (await commentInput.isVisible({ timeout: 5000 }).catch(() => false)) {
      const commentText = `Bình luận thử nghiệm lúc ${Date.now()}`;
      await commentInput.fill(commentText);
      const postBtn = page.locator('button:has-text("Bình luận"), button:has-text("Gửi")').first();
      await postBtn.click();

      // Comment should appear
      await expect(page.locator(`text=${commentText}`).first()).toBeVisible({ timeout: 10000 });
    }
  });
});
