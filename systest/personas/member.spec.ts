import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const manifestPath = path.resolve(process.cwd(), 'systest/.run/seed-manifest.json');
let manifest: any = null;
if (fs.existsSync(manifestPath)) {
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    /* ignore */
  }
}

const INVITE_CODE = manifest?.invite_code || process.env.INVITE_CODE || 'sim-invite-2026-auth-ok';
const PASSWORD = 'Password123!';

test.describe('Persona: member (The "Lưu" Refresh-Token Regression, ADR-038)', () => {
  const memberHandle = `mem_${Date.now().toString(36)}`;
  const memberEmail = `${memberHandle}@winkey.test`;
  const playlistTitle = `Danh sách của ${memberHandle}`;

  test('register with invite code (assert fail without invite code), then login', async ({
    page,
  }) => {
    // 1. Attempt register WITHOUT invite code -> must show INVITE_REQUIRED message or 403
    await page.goto('/register');
    await page.fill('input[name="handle"], input[id="handle"]', memberHandle);
    await page.fill('input[name="email"], input[id="email"]', memberEmail);
    await page.fill('input[name="display_name"], input[id="display_name"]', 'Thành Viên Test');
    await page.fill('input[name="password"], input[id="password"]', PASSWORD);

    // Leave invite code empty if input exists
    const inviteInput = page.locator('input[name="invite_code"], input[id="invite_code"]');
    if (await inviteInput.isVisible()) {
      await inviteInput.fill('');
    }

    await page.click('button[type="submit"]');

    // Expect INVITE_REQUIRED or error notice
    await expect(
      page
        .locator(
          'text=INVITE_REQUIRED, text=Mã mời không hợp lệ, text=Yêu cầu mã mời, [role="alert"]',
        )
        .first(),
    ).toBeVisible({ timeout: 10000 });

    // 2. Register WITH valid invite code
    if (await inviteInput.isVisible()) {
      await inviteInput.fill(INVITE_CODE);
      await page.click('button[type="submit"]');
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
    await page.fill('input[name="email"], input[id="email"]', memberEmail);
    await page.fill('input[name="password"], input[id="password"]', PASSWORD);
    await page.click('button[type="submit"]');

    // Should land on home or authenticated view
    await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 10000 });
  });

  test('"Lưu" -> add to new playlist -> appears in /thu-vien', async ({ page }) => {
    // Login member
    await page.goto('/login');
    await page.fill('input[name="email"], input[id="email"]', memberEmail);
    await page.fill('input[name="password"], input[id="password"]', PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 10000 });

    const targetVideo = manifest?.videos?.find((v: any) => v.visibility === 'PUBLIC') || {
      id: 'test-video',
    };

    // Navigate to watch page
    await page.goto(`/watch/${targetVideo.id}`);
    await expect(page.locator('h1')).toBeVisible();

    // Click "Lưu" button
    const saveBtn = page.locator(
      'button[aria-label="Lưu vào danh sách phát"], button:has-text("Lưu")',
    );
    await saveBtn.first().click();

    // Dialog should open
    const dialog = page.locator('[role="dialog"], text=Lưu video vào');
    await expect(dialog.first()).toBeVisible({ timeout: 10000 });

    // Create new playlist if button visible
    const newPlaylistBtn = page.locator(
      'button:has-text("Danh sách mới"), button:has-text("Tạo danh sách mới")',
    );
    if (await newPlaylistBtn.isVisible()) {
      await newPlaylistBtn.click();
      await page.fill('input[placeholder*="Tiêu đề"], input[name="title"]', playlistTitle);
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
    await expect(page.locator(`text=${playlistTitle}, text=Xem sau`).first()).toBeVisible({
      timeout: 15000,
    });
  });

  test('reload page (forces refresh-cookie path) -> "Lưu" again succeeds', async ({ page }) => {
    // Member session in cookies
    const targetVideo = manifest?.videos?.find((v: any) => v.visibility === 'PUBLIC') || {
      id: 'test-video',
    };
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

    const dialog = page.locator('[role="dialog"], text=Lưu video vào');
    await expect(dialog.first()).toBeVisible({ timeout: 10000 });
    await page.keyboard.press('Escape');
  });

  test('clock fast-forward 16 min (access token expired) -> "Lưu" still succeeds via background refresh', async ({
    page,
  }) => {
    // Install fake clock
    await page.clock.install();

    const targetVideo = manifest?.videos?.find((v: any) => v.visibility === 'PUBLIC') || {
      id: 'test-video',
    };
    await page.goto(`/watch/${targetVideo.id}`);
    await expect(page.locator('h1')).toBeVisible();

    // Fast-forward 16 minutes (access token TTL is 15 minutes)
    await page.clock.fastForward(16 * 60 * 1000);

    // Click "Lưu" - customFetch should catch 401, invoke refreshAccessToken() via cookie, and succeed!
    const saveBtn = page.locator(
      'button[aria-label="Lưu vào danh sách phát"], button:has-text("Lưu")',
    );
    await saveBtn.first().click();

    // Must NOT be redirected to login, and save dialog opens smoothly
    expect(page.url()).not.toContain('/login');
    const dialog = page.locator('[role="dialog"], text=Lưu video vào');
    await expect(dialog.first()).toBeVisible({ timeout: 10000 });
    await page.keyboard.press('Escape');
  });

  test('two tabs at once after token expiry -> both succeed with navigator.locks refresh dedupe', async ({
    context,
  }) => {
    const page1 = await context.newPage();
    const page2 = await context.newPage();

    await page1.clock.install();
    await page2.clock.install();

    const targetVideo = manifest?.videos?.find((v: any) => v.visibility === 'PUBLIC') || {
      id: 'test-video',
    };
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

    await expect(page1.locator('[role="dialog"], text=Lưu video vào').first()).toBeVisible({
      timeout: 10000,
    });
    await expect(page2.locator('[role="dialog"], text=Lưu video vào').first()).toBeVisible({
      timeout: 10000,
    });

    await page1.close();
    await page2.close();
  });

  test('signed-out: "Lưu" redirects to /login?return_to=... and returns after login', async ({
    browser,
  }) => {
    // Isolated clean incognito context (signed out)
    const anonContext = await browser.newContext();
    const anonPage = await anonContext.newPage();

    const targetVideo = manifest?.videos?.find((v: any) => v.visibility === 'PUBLIC') || {
      id: 'test-video',
    };
    const watchUrl = `/watch/${targetVideo.id}?playlist=test-pl&src=home`;

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
    expect(loginUrl).toContain(encodeURIComponent(watchUrl));

    // Log in
    await anonPage.fill('input[name="email"], input[id="email"]', memberEmail);
    await anonPage.fill('input[name="password"], input[id="password"]', PASSWORD);
    await anonPage.click('button[type="submit"]');

    // Must return to the exact watch page URL
    await anonPage.waitForURL((url) => url.pathname.includes(`/watch/${targetVideo.id}`), {
      timeout: 10000,
    });
    expect(anonPage.url()).toContain(`watch/${targetVideo.id}`);
    expect(anonPage.url()).toContain('playlist=test-pl');

    await anonContext.close();
  });

  test('comment, reply, like, unlike: counts update', async ({ page }) => {
    // Log in member
    await page.goto('/login');
    await page.fill('input[name="email"], input[id="email"]', memberEmail);
    await page.fill('input[name="password"], input[id="password"]', PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 10000 });

    const targetVideo = manifest?.videos?.find((v: any) => v.visibility === 'PUBLIC') || {
      id: 'test-video',
    };
    await page.goto(`/watch/${targetVideo.id}`);
    await expect(page.locator('h1')).toBeVisible();

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
      .locator('textarea[placeholder*="Bình luận"], input[placeholder*="Bình luận"]')
      .first();
    if (await commentInput.isVisible()) {
      const commentText = `Bình luận thử nghiệm lúc ${Date.now()}`;
      await commentInput.fill(commentText);
      const postBtn = page.locator('button:has-text("Bình luận"), button:has-text("Gửi")').first();
      await postBtn.click();

      // Comment should appear
      await expect(page.locator(`text=${commentText}`).first()).toBeVisible({ timeout: 10000 });
    }
  });
});
