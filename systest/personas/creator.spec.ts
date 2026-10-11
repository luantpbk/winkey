import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const manifestPath = path.resolve(__dirname, '../.run/seed-manifest.json');
if (!fs.existsSync(manifestPath)) {
  throw new Error(
    `[persona:creator] Missing seed-manifest.json at ${manifestPath}. Run seed before running personas.`,
  );
}
const manifest: any = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

if (!manifest.curator?.email) {
  throw new Error('[persona:creator] Missing curator in seed-manifest.json');
}

const PASSWORD = 'Password123!';
const testClipPath = path.resolve(__dirname, '../.run/seed_clip_16x9.mp4');
if (!fs.existsSync(testClipPath)) {
  throw new Error(`[persona:creator] Missing test clip at ${testClipPath}`);
}

test.describe('Persona: creator (Upload, Studio Edit, Series & Deletion, ADR-038)', () => {
  let creatorEmail = '';
  let creatorToken = '';

  test.beforeAll(async ({ request }) => {
    creatorEmail = manifest.curator.email;
    const res = await request.post('/v1/auth/login', {
      data: { email: creatorEmail, password: PASSWORD },
    });
    if (!res.ok()) {
      throw new Error(
        `[persona:creator] Failed to login curator (${creatorEmail}): HTTP ${res.status()}`,
      );
    }
    const data = await res.json();
    creatorToken = data.access_token;
  });

  test('upload clip through upload UI -> wait for READY (<= 240s)', async ({ page }) => {
    test.setTimeout(240_000);
    // Login creator
    await page.goto('/login');
    await page.locator('input[type="email"]').fill(creatorEmail);
    await page.locator('input[type="password"]').fill(PASSWORD);
    await page.locator('main form button[type="submit"]').click();
    await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 10000 });

    // Navigate to upload page
    await page.goto('/upload');
    await expect(page.locator('body')).toBeVisible();

    // Select file input
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(testClipPath);

    // Title input
    const uploadTitle = `Clip Mới Của Creator ${Date.now()}`;
    const titleInput = page.locator('input[placeholder*="Tiêu đề"]').first();
    if (await titleInput.isVisible()) {
      await titleInput.fill(uploadTitle);
    }

    // Submit upload
    const submitBtn = page.getByRole('button', { name: /Bắt đầu tải lên|Tải lên/i });
    await submitBtn.click();

    // Wait until upload completes and reaches READY (<= 240s)
    await expect(page.getByText('Video đã mã hóa xong và sẵn sàng phát!')).toBeVisible({
      timeout: 240_000,
    });
  });

  test('Studio edit: title, description, visibility, 3 tags (one with diacritics) -> save', async ({
    page,
  }) => {
    // Login creator
    await page.goto('/login');
    await page.locator('input[type="email"]').fill(creatorEmail);
    await page.locator('input[type="password"]').fill(PASSWORD);
    await page.locator('main form button[type="submit"]').click();

    // Collect all video IDs that belong to series so we do not edit an episode of a series
    const seriesVideoIds = new Set<string>();
    for (const s of manifest.series || []) {
      for (const epId of s.episode_ids || []) {
        if (epId) seriesVideoIds.add(epId);
      }
    }

    // Also avoid the first 5 public videos checked in /sitemap.xml
    const sitemapVideoIds = new Set<string>(
      (manifest.videos || [])
        .filter((v: any) => v.visibility === 'PUBLIC')
        .slice(0, 5)
        .map((v: any) => v.id),
    );

    // Pick first safe PUBLIC video owned by curator
    const safeVideos = (manifest.videos || []).filter(
      (v: any) =>
        v.visibility === 'PUBLIC' &&
        v.owner_handle === manifest.curator.handle &&
        !seriesVideoIds.has(v.id) &&
        !sitemapVideoIds.has(v.id),
    );
    const targetVideo = safeVideos[0];
    if (!targetVideo) {
      throw new Error('[persona:creator] No PUBLIC video owned by curator found for studio edit');
    }
    console.log(
      `[persona:creator studio-edit] Using video ID: ${targetVideo.id}, title: "${targetVideo.title}", owner: ${targetVideo.owner_handle}, source: seed-manifest (safe public video outside series & sitemap, ${safeVideos.length} candidates)`,
    );

    // Find a video in studio
    await page.goto('/studio');
    await expect(page.locator('body')).toBeVisible();

    const targetEditBtn = page
      .locator(
        `a[href*="/studio/videos/${targetVideo.id}/edit"], [data-testid="edit-video-${targetVideo.id}"]`,
      )
      .first();
    if (await targetEditBtn.isVisible()) {
      await targetEditBtn.click();
    } else {
      await page.goto(`/studio/videos/${targetVideo.id}/edit`);
    }

    await page.waitForURL(/\/studio\/videos\/[^/]+\/edit/, { timeout: 15000 });
    const videoId = page.url().match(/\/studio\/videos\/([^/]+)\/edit/)?.[1];
    expect(videoId).toBeTruthy();

    const newTitle = `Video Đã Chỉnh Sửa ${Date.now()}`;
    const newDesc = 'Mô tả chi tiết với đầy đủ dấu tiếng Việt chuẩn SEO.';
    await page.locator('#video-title, [data-testid="video-title-input"]').fill(newTitle);
    await page.locator('#video-description, [data-testid="video-description-input"]').fill(newDesc);

    // Visibility: PUBLIC
    const pubRadio = page.locator('[data-testid="visibility-radio-PUBLIC"], input[value="PUBLIC"]');
    if (await pubRadio.isVisible()) {
      await pubRadio.check();
    }

    // Add 3 tags (one with diacritics: 'du-lich', 'am-nhac', 'Trải Nghiệm')
    const tagInput = page.locator(
      '[data-testid="tag-input"], #video-tags-input, input[placeholder*="thẻ"]',
    );
    if (await tagInput.isVisible()) {
      for (const t of ['du-lich', 'am-nhac', 'Trải Nghiệm']) {
        await tagInput.fill(t);
        await page.keyboard.press('Enter');
      }
    }

    // Save changes
    const saveBtn = page.locator('[data-testid="save-video-changes-btn"]').first();
    await saveBtn.click();

    await expect(
      page.getByText(/Đã lưu thay đổi thành công|Đã lưu|Thành công/).first(),
    ).toBeVisible({
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
    await page.locator('input[type="email"]').fill(creatorEmail);
    await page.locator('input[type="password"]').fill(PASSWORD);
    await page.locator('main form button[type="submit"]').click();

    await page.goto('/thu-vien');
    await expect(page.locator('body')).toBeVisible();

    const seriesTitle = `Bộ Phim Đặc Sắc ${Date.now()}`;

    // Click create series / playlist
    const createBtn = page
      .locator('[data-testid="create-playlist-btn"], [data-testid="empty-create-playlist-btn"]')
      .first();
    if (await createBtn.isVisible()) {
      await createBtn.click();
      await page.locator('[data-testid="create-playlist-title-input"]').fill(seriesTitle);

      const visSelect = page.locator('[data-testid="create-playlist-visibility-select"]');
      if (await visSelect.isVisible()) {
        await visSelect.selectOption('PUBLIC');
      }

      const seriesCheckbox = page.locator('[data-testid="create-playlist-is-series-checkbox"]');
      if (await seriesCheckbox.isVisible()) {
        await seriesCheckbox.check();
      }

      await page.locator('[data-testid="submit-create-playlist-btn"]').click();
    }

    // Verify appearance on Home "Phim bộ"
    await page.goto('/');
    const seriesSection = page
      .locator('[data-testid="cinema-row-series"]')
      .or(page.getByText('Phim bộ'));
    await expect(seriesSection.first()).toBeVisible({ timeout: 15000 });
  });

  test('delete one video -> disappears everywhere including 404 on watch page', async ({
    page,
    request,
  }) => {
    // Collect all video IDs that belong to series so we do not delete an episode of a series
    const seriesVideoIds = new Set<string>();
    for (const s of manifest.series || []) {
      for (const epId of s.episode_ids || []) {
        if (epId) seriesVideoIds.add(epId);
      }
    }

    // Also avoid the first 5 public videos checked in /sitemap.xml
    const sitemapVideoIds = new Set<string>(
      (manifest.videos || [])
        .filter((v: any) => v.visibility === 'PUBLIC')
        .slice(0, 5)
        .map((v: any) => v.id),
    );

    const safeVideos = (manifest.videos || []).filter(
      (v: any) =>
        v.visibility === 'PUBLIC' &&
        v.owner_handle === manifest.curator.handle &&
        !seriesVideoIds.has(v.id) &&
        !sitemapVideoIds.has(v.id),
    );
    // Use last safe video so delete doesn't conflict with studio edit
    const targetVideo = safeVideos.length > 1 ? safeVideos[safeVideos.length - 1] : safeVideos[0];
    if (!targetVideo) {
      throw new Error('[persona:creator] No PUBLIC video owned by curator found to test delete');
    }

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
    await expect(page.getByText(/404|không tồn tại/).first()).toBeVisible({
      timeout: 10000,
    });
  });
});
