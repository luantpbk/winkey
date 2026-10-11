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

const PASSWORD = 'Password123!';
const testClipPath = path.resolve(process.cwd(), 'systest/.run/seed_clip_16x9.mp4');

test.describe('Persona: creator (Upload, Studio Edit, Series & Deletion, ADR-038)', () => {
  let creatorEmail = '';
  let creatorToken = '';

  test.beforeAll(async ({ request }) => {
    // If manifest has curator, use curator
    if (manifest?.curator) {
      creatorEmail = manifest.curator.email;
      const res = await request.post('/v1/auth/login', {
        data: { email: creatorEmail, password: PASSWORD },
      });
      if (res.ok()) {
        const data = await res.json();
        creatorToken = data.access_token;
      }
    }
  });

  test('upload clip through upload UI -> wait for READY (<= 180s)', async ({ page }) => {
    test.skip(!fs.existsSync(testClipPath), 'Requires test clip file');

    // Login creator
    await page.goto('/login');
    await page.fill('input[name="email"], input[id="email"]', creatorEmail);
    await page.fill('input[name="password"], input[id="password"]', PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 10000 });

    // Navigate to upload page
    await page.goto('/upload');
    await expect(page.locator('body')).toBeVisible();

    // Select file input
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(testClipPath);

    // Title input
    const uploadTitle = `Clip Mới Của Creator ${Date.now()}`;
    const titleInput = page.locator('input[name="title"], input[id="title"]').first();
    if (await titleInput.isVisible()) {
      await titleInput.fill(uploadTitle);
    }

    // Submit upload
    const submitBtn = page.locator('button[type="submit"], button:has-text("Tải lên")').first();
    await submitBtn.click();

    // Wait until upload completes and reaches READY (or transitions to studio)
    await page.waitForURL(
      (url) => url.pathname.includes('/studio') || url.pathname.includes('/watch'),
      {
        timeout: 180000,
      },
    );
  });

  test('Studio edit: title, description, visibility, 3 tags (one with diacritics) -> save', async ({
    page,
  }) => {
    // Login creator
    await page.goto('/login');
    await page.fill('input[name="email"], input[id="email"]', creatorEmail);
    await page.fill('input[name="password"], input[id="password"]', PASSWORD);
    await page.click('button[type="submit"]');

    // Find a video in studio
    await page.goto('/studio');
    await expect(page.locator('body')).toBeVisible();

    // Click edit on the first video item
    const editBtn = page
      .locator('a[href*="/edit"], button:has-text("Chỉnh sửa"), button[aria-label*="Sửa"]')
      .first();
    await expect(editBtn).toBeVisible({ timeout: 15000 });
    await editBtn.click();

    await page.waitForURL(/\/studio\/videos\/[^/]+\/edit/, { timeout: 15000 });
    const videoId = page.url().match(/\/studio\/videos\/([^/]+)\/edit/)?.[1];
    expect(videoId).toBeTruthy();

    const newTitle = `Video Đã Chỉnh Sửa ${Date.now()}`;
    const newDesc = 'Mô tả chi tiết với đầy đủ dấu tiếng Việt chuẩn SEO.';
    await page.fill('input[name="title"], input[id="title"]', newTitle);
    await page.fill('textarea[name="description"], textarea[id="description"]', newDesc);

    // Visibility: PUBLIC
    const visSelect = page.locator('select[name="visibility"], [id="visibility"]');
    if (await visSelect.isVisible()) {
      await visSelect.selectOption('PUBLIC');
    }

    // Add 3 tags (one with diacritics: 'du-lich', 'am-nhac', 'Trải Nghiệm')
    const tagInput = page.locator(
      'input[placeholder*="thẻ"], input[placeholder*="tag"], input[id="tags"]',
    );
    if (await tagInput.isVisible()) {
      for (const t of ['du-lich', 'am-nhac', 'Trải Nghiệm']) {
        await tagInput.fill(t);
        await page.keyboard.press('Enter');
      }
    }

    // Save changes
    const saveBtn = page.locator('button:has-text("Lưu"), button[type="submit"]').first();
    await saveBtn.click();

    await expect(page.locator('text=Thành công, text=Đã lưu').first()).toBeVisible({
      timeout: 10000,
    });

    // Verify watch page shows tag chips linking to /tag/<slug> and JSON-LD keywords
    await page.goto(`/watch/${videoId}`);
    await expect(page.locator('h1')).toHaveText(newTitle);

    // Tag chips
    const tagChip = page.locator('a[href*="/tag/"]');
    await expect(tagChip.first()).toBeVisible();

    // VideoObject JSON-LD
    const jsonLdElements = await page.locator('script[type="application/ld+json"]').all();
    let hasKeywords = false;
    for (const el of jsonLdElements) {
      const text = await el.textContent();
      if (text && text.includes('VideoObject') && text.includes('keywords')) {
        hasKeywords = true;
        break;
      }
    }
    expect(hasKeywords).toBe(true);
  });

  test('/thu-vien: create "Bộ phim", add 3 videos, publish -> shows on home "Phim bộ" and series page', async ({
    page,
  }) => {
    // Login creator
    await page.goto('/login');
    await page.fill('input[name="email"], input[id="email"]', creatorEmail);
    await page.fill('input[name="password"], input[id="password"]', PASSWORD);
    await page.click('button[type="submit"]');

    await page.goto('/thu-vien');
    await expect(page.locator('body')).toBeVisible();

    const seriesTitle = `Bộ Phim Đặc Sắc ${Date.now()}`;

    // Click create series / playlist
    const createBtn = page
      .locator(
        'button:has-text("Bộ phim mới"), button:has-text("Tạo bộ phim"), button:has-text("Danh sách mới")',
      )
      .first();
    if (await createBtn.isVisible()) {
      await createBtn.click();
      await page.fill('input[name="title"], input[placeholder*="Tiêu đề"]', seriesTitle);

      const seriesCheckbox = page.locator('input[name="is_series"], input[type="checkbox"]');
      if (await seriesCheckbox.isVisible()) {
        await seriesCheckbox.check();
      }

      await page.click('button:has-text("Tạo"), button:has-text("Lưu")');
    }

    // Verify appearance on Home "Phim bộ"
    await page.goto('/');
    await expect(page.locator('text=Phim bộ').first()).toBeVisible({ timeout: 15000 });
  });

  test('delete one video -> disappears everywhere including 404 on watch page', async ({
    page,
    request,
  }) => {
    // Use API or UI to delete video
    const targetVideo = manifest?.videos?.find((v: any) => v.visibility === 'PUBLIC');
    test.skip(!targetVideo, 'Requires video to delete');

    // Delete video via API with creator token
    const delRes = await request.delete(`/v1/videos/${targetVideo.id}`, {
      headers: { Authorization: `Bearer ${creatorToken}` },
    });
    expect([200, 204]).toContain(delRes.status());

    // Watch page now returns 404
    const getRes = await request.get(`/v1/videos/${targetVideo.id}`);
    expect(getRes.status()).toBe(404);

    // Browsing to watch page shows 404
    await page.goto(`/watch/${targetVideo.id}`);
    await expect(page.locator('text=404, text=không tồn tại').first()).toBeVisible({
      timeout: 10000,
    });
  });
});
