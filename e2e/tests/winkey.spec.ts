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

    // Verify owner display name or subscribe button
    await expect(
      page.locator('button:has-text("Đăng ký"), button:has-text("Đã đăng ký"), button:has-text("Subscribe")').first()
    ).toBeVisible();
    await expect(page.locator('h1')).toBeVisible();
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
    await page.waitForURL((url) => url.pathname === '/' || url.pathname === '/vi' || url.pathname === '/en', { timeout: 15000 });

    // 2. Navigate to upload
    await page.goto('/upload');
    await page.waitForLoadState('domcontentloaded');

    // Create temporary mock video file
    const sampleFilePath = path.join(process.cwd(), 'temp-test-video.mp4');
    fs.writeFileSync(sampleFilePath, 'Winkey MP4 Mock Content for E2E Upload');

    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(sampleFilePath);

    // Fill title
    const uploadTitleInput = page.locator('input[placeholder*="Tiêu đề video"], input[placeholder*="Video Title"], input[required]').first();
    await uploadTitleInput.fill('E2E Automated Video Upload');

    // Click Start Upload
    const startUploadBtn = page.locator('button:has-text("Bắt đầu tải lên"), button:has-text("Start Upload")');
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
      } catch {}
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
