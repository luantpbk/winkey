import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const manifestPath = path.resolve(__dirname, '../.run/seed-manifest.json');
if (!fs.existsSync(manifestPath)) {
  throw new Error(
    `[persona:role-upgrade] Missing seed-manifest.json at ${manifestPath}. Run seed before running personas.`,
  );
}
const manifest: any = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

if (!manifest.moderator?.email) {
  throw new Error('[persona:role-upgrade] Missing moderator in seed-manifest.json');
}

const INVITE_CODE = manifest.invite_code;
if (!INVITE_CODE) {
  throw new Error('[persona:role-upgrade] Missing invite_code in seed-manifest.json');
}

const PASSWORD = 'Password123!';
const testClipPath = path.resolve(__dirname, '../.run/seed_clip_16x9.mp4');
const fallbackClipPath = path.resolve(__dirname, '../.run/clip.mp4');
const clipPath = fs.existsSync(testClipPath) ? testClipPath : fallbackClipPath;

function resetRateLimits() {
  try {
    const script = path.resolve(__dirname, '../reset-ratelimits.sh');
    if (fs.existsSync(script)) {
      execSync(`bash "${script}"`, { stdio: 'ignore' });
    }
  } catch (err) {
    console.warn(
      `[persona:role-upgrade] Warning: failed to reset rate limits: ${(err as Error)?.message || err}`,
    );
  }
}

test.describe
  .serial('Persona: role-upgrade (ADR-046 Viewer Signup, Upgrade Request & Admin Approval)', () => {
  let viewerContext: BrowserContext;
  let viewerPage: Page;
  let viewerToken = '';

  const suffix = Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
  const viewerHandle = `view_${suffix}`;
  const viewerEmail = `${viewerHandle}@winkey.test`;
  const viewerDisplayName = `Khán Giả ${suffix}`;

  test.beforeAll(async ({ browser }) => {
    resetRateLimits();
    viewerContext = await browser.newContext();
    viewerPage = await viewerContext.newPage();
  });

  test.afterAll(async () => {
    await viewerContext?.close();
  });

  test('register with invite -> demote to viewer via psql -> refresh picks up viewer -> no Upload/Studio in nav', async () => {
    // 1. Navigate to /register with invite code
    await viewerPage.goto(`/register?invite=${encodeURIComponent(INVITE_CODE)}`);
    await expect(viewerPage.locator('body')).toBeVisible();

    // Fill registration form
    await viewerPage.locator('input[placeholder*="Nguyễn Văn A"]').fill(viewerDisplayName);
    await viewerPage.locator('input[placeholder*="nguyenvana"]').fill(viewerHandle);
    await viewerPage.locator('input[type="email"]').fill(viewerEmail);
    await viewerPage.locator('input[type="password"]').fill(PASSWORD);

    const termsCheckbox = viewerPage
      .locator('#terms-agreement-checkbox, input[type="checkbox"]')
      .first();
    if (await termsCheckbox.isVisible()) {
      await termsCheckbox.check();
    }

    // Submit registration
    await viewerPage.locator('main form button[type="submit"]').click();
    await viewerPage.waitForURL((url) => !url.pathname.includes('/register'), { timeout: 15000 });

    // 2. Right after signup, demote with the seed's psql pattern:
    // UPDATE auth.users SET roles='{viewer}' WHERE id=...
    const userId = execSync(
      `docker exec -i winkey-postgres psql -U winkey_migrator -d winkey -t -A -c "SELECT id FROM auth.users WHERE email = '${viewerEmail}';"`,
    )
      .toString()
      .trim();
    expect(userId).toBeTruthy();
    execSync(
      `docker exec -i winkey-postgres psql -U winkey_migrator -d winkey -c "UPDATE auth.users SET roles = '{viewer}' WHERE id = '${userId}';"`,
    );

    // 3. reload() — the boot refresh picks up viewer; assert roles == ['viewer'] via /v1/auth/refresh
    const refreshResPromise = viewerPage.waitForResponse(
      (res) => res.url().includes('/v1/auth/refresh') && res.request().method() === 'POST',
    );
    await viewerPage.reload();
    await expect(viewerPage.locator('body')).toBeVisible();

    const refreshRes = await refreshResPromise;
    expect(refreshRes.status()).toBe(200);
    const refreshData = await refreshRes.json();
    expect(refreshData.user.roles).toEqual(['viewer']);
    viewerToken = refreshData.access_token;

    // 4. Assert no Upload / Studio in global nav
    await expect(viewerPage.locator('[data-testid="topbar-upload-btn"]')).not.toBeVisible();
    await expect(viewerPage.locator('a[href="/upload"]')).not.toBeVisible();
    await expect(viewerPage.locator('a[href="/studio"]')).not.toBeVisible();
    await expect(viewerPage.locator('[data-testid="user-menu-studio-btn"]')).not.toBeVisible();
  });

  test('/upload shows upgrade page -> POST /v1/uploads returns 403', async () => {
    // 5. Direct navigation to /upload shows upgrade page instead of upload dropzone
    await viewerPage.goto('/upload');
    await expect(viewerPage.getByText(/Trở thành Nhà sáng tạo Winkey/i)).toBeVisible({
      timeout: 10000,
    });
    await expect(viewerPage.locator('[data-testid="creator-request-textarea"]')).toBeVisible();
    await expect(viewerPage.locator('[data-testid="upload-tab-single"]')).not.toBeVisible();

    // 6. Direct API POST /v1/uploads returns 403 CREATOR_ROLE_REQUIRED
    const uploadRes = await viewerPage.request.post('/v1/uploads', {
      headers: { Authorization: `Bearer ${viewerToken}` },
      data: {
        title: 'Bypass Attempt Video',
        description: 'Should be rejected with 403',
        filename: 'clip.mp4',
        content_type: 'video/mp4',
        size_bytes: 1024,
      },
    });

    expect(uploadRes.status()).toBe(403);
    const errBody = await uploadRes.json();
    expect(errBody.code || errBody.title || errBody.detail).toMatch(
      /CREATOR_ROLE_REQUIRED|Forbidden/i,
    );
  });

  test('send creator request (/nang-cap) -> status becomes PENDING', async () => {
    // 7. Navigate to /nang-cap and send creator request
    await viewerPage.goto('/nang-cap');
    const textarea = viewerPage.locator('[data-testid="creator-request-textarea"]');
    await expect(textarea).toBeVisible({ timeout: 10000 });

    const requestMessage =
      'Tôi muốn đăng tải các video trải nghiệm công nghệ và du lịch văn hóa Việt Nam.';
    await textarea.fill(requestMessage);

    const submitBtn = viewerPage.locator('[data-testid="creator-request-submit-btn"]');
    await expect(submitBtn).toBeEnabled();
    await submitBtn.click();

    // Assert status transitions to PENDING
    await expect(viewerPage.locator('[data-testid="upgrade-creator-pending"]')).toBeVisible({
      timeout: 15000,
    });
    await expect(viewerPage.getByText(/Yêu cầu đang chờ duyệt/i)).toBeVisible();
    await expect(viewerPage.getByText(requestMessage)).toBeVisible();
  });

  test('admin (sim_mod) approves in Admin tab "Yêu cầu sáng tạo"', async ({ browser }) => {
    // 8. Admin logs in using separate isolated context
    resetRateLimits();
    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();

    await adminPage.goto('/login');
    await adminPage.locator('input[type="email"]').fill(manifest.moderator.email);
    await adminPage.locator('input[type="password"]').fill(PASSWORD);
    await adminPage.locator('main form button[type="submit"]').click();
    await adminPage.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 15000 });

    // Open Admin page -> "Yêu cầu sáng tạo" tab
    await adminPage.goto('/admin');
    const creatorRequestsTab = adminPage.locator('[data-testid="admin-tab-creator-requests"]');
    await expect(creatorRequestsTab).toBeVisible({ timeout: 10000 });
    await creatorRequestsTab.click();

    // Verify user's request appears in table
    const userRow = adminPage.locator('tr').filter({ hasText: viewerHandle }).first();
    await expect(userRow).toBeVisible({ timeout: 15000 });

    // Click Duyệt button on user's row
    const approveBtn = userRow.locator('button').filter({ hasText: 'Duyệt' }).first();
    await expect(approveBtn).toBeVisible();
    await approveBtn.click();

    // Confirm approve in modal dialog
    const confirmBtn = adminPage.locator('[data-testid="confirm-approve-btn"]');
    await expect(confirmBtn).toBeVisible({ timeout: 10000 });
    await confirmBtn.click();

    // Toast confirmation
    await expect(
      adminPage.getByText(new RegExp(`Đã cấp quyền Creator cho @${viewerHandle}`, 'i')),
    ).toBeVisible({ timeout: 15000 });

    await adminContext.close();
  });

  test('after admin approval, assert POST /v1/auth/refresh returns creator, then upload -> 201', async () => {
    // 9. Reload viewerPage on /nang-cap to trigger boot refresh; assert POST /v1/auth/refresh returns creator
    const refreshResPromise = viewerPage.waitForResponse(
      (res) => res.url().includes('/v1/auth/refresh') && res.request().method() === 'POST',
    );
    await viewerPage.reload();
    await expect(viewerPage.locator('body')).toBeVisible();

    const refreshRes = await refreshResPromise;
    expect(refreshRes.status()).toBe(200);
    const refreshData = await refreshRes.json();
    expect(refreshData.user.roles).toContain('creator');
    viewerToken = refreshData.access_token;

    // Navigate to /upload: user is creator, upload button in global nav must now be visible
    await viewerPage.goto('/upload');
    await expect(viewerPage.locator('[data-testid="topbar-upload-btn"]')).toBeVisible({
      timeout: 15000,
    });

    // /upload page now shows upload UI instead of upgrade request view
    await expect(viewerPage.locator('[data-testid="creator-request-textarea"]')).not.toBeVisible();
    const fileInput = viewerPage.locator('input[type="file"]');
    await expect(fileInput).toBeAttached({ timeout: 15000 });

    // 10. Upload starts (POST /v1/uploads returns 201)
    const clipSizeBytes = fs.existsSync(clipPath) ? fs.statSync(clipPath).size : 1024 * 512;
    const startUploadRes = await viewerPage.request.post('/v1/uploads', {
      headers: { Authorization: `Bearer ${viewerToken}` },
      data: {
        title: 'Video Đầu Tiên Sau Khi Được Phê Duyệt Creator',
        description: 'ROLE1 persona e2e verification',
        filename: 'clip.mp4',
        content_type: 'video/mp4',
        size_bytes: clipSizeBytes,
      },
    });

    expect(startUploadRes.status()).toBe(201);
    const startData = await startUploadRes.json();
    expect(startData.video_id).toBeTruthy();
    console.log(
      `[persona:role-upgrade] Successfully created video upload: ${startData.video_id} (HTTP 201)`,
    );
  });
});
