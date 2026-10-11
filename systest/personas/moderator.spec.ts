import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const manifestPath = path.resolve(__dirname, '../.run/seed-manifest.json');
if (!fs.existsSync(manifestPath)) {
  throw new Error(
    `[persona:moderator] Missing seed-manifest.json at ${manifestPath}. Run seed before running personas.`,
  );
}
const manifest: any = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

if (!manifest.users?.[0]?.email) {
  throw new Error('[persona:moderator] Missing users[0].email in seed-manifest.json');
}
if (!manifest.moderator?.email) {
  throw new Error('[persona:moderator] Missing moderator.email in seed-manifest.json');
}
if (!manifest.curator?.email) {
  throw new Error('[persona:moderator] Missing curator.email in seed-manifest.json');
}

const PASSWORD = 'Password123!';

test.describe('Persona: moderator (Report, Hide, Owner Notice, Public 404 & Restore, ADR-038)', () => {
  let modToken = '';
  let memberToken = '';
  let targetVideo: any = null;

  test.beforeAll(async ({ request }) => {
    // 1. Member login token
    const uRes = await request.post('/v1/auth/login', {
      data: { email: manifest.users[0].email, password: PASSWORD },
    });
    if (!uRes.ok()) {
      throw new Error(`[persona:moderator] Failed to login member: HTTP ${uRes.status()}`);
    }
    memberToken = (await uRes.json()).access_token;

    // 2. Moderator login token
    const mRes = await request.post('/v1/auth/login', {
      data: { email: manifest.moderator.email, password: PASSWORD },
    });
    if (!mRes.ok()) {
      throw new Error(`[persona:moderator] Failed to login moderator: HTTP ${mRes.status()}`);
    }
    modToken = (await mRes.json()).access_token;

    const seriesVideoIds = new Set<string>();
    for (const s of manifest.series || []) {
      for (const epId of s.episode_ids || []) {
        if (epId) seriesVideoIds.add(epId);
      }
    }
    targetVideo = manifest.videos?.find(
      (v: any) =>
        v.visibility === 'PUBLIC' &&
        v.owner_handle === manifest.curator.handle &&
        !seriesVideoIds.has(v.id) &&
        v.id !== manifest.videos[0]?.id,
    );
    if (!targetVideo) {
      targetVideo = manifest.videos?.find((v: any) => v.visibility === 'PUBLIC');
    }
    if (!targetVideo) {
      throw new Error('[persona:moderator] No PUBLIC video found in seed-manifest.json');
    }
  });

  test('member reports video -> moderator hides it -> owner sees notice, public gets 404 -> restore', async ({
    page,
    request,
    browser,
  }) => {
    // 1. Member reports video
    const reportRes = await request.post('/v1/reports', {
      headers: { Authorization: `Bearer ${memberToken}` },
      data: {
        target_type: 'VIDEO',
        target_id: targetVideo.id,
        reason: 'SPAM',
        note: 'Báo cáo nội dung vi phạm tiêu chuẩn cộng đồng',
      },
    });
    expect([200, 201]).toContain(reportRes.status());

    // 2. Moderator logs into admin panel and hides video
    await page.goto('/login');
    await page.locator('input[type="email"]').fill(manifest.moderator.email);
    await page.locator('input[type="password"]').fill(PASSWORD);
    await page.locator('main form button[type="submit"]').click();
    await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 10000 });

    // Open Admin panel
    await page.goto('/admin');
    await expect(page.locator('body')).toBeVisible();

    // Hide video via moderation API (or moderation panel UI)
    const hideRes = await request.put(`/v1/videos/${targetVideo.id}/moderation`, {
      headers: { Authorization: `Bearer ${modToken}` },
      data: {
        state: 'HIDDEN',
        reason: 'Nội dung vi phạm nguyên tắc cộng đồng',
      },
    });
    expect(hideRes.status()).toBe(200);

    // 3. Public view receives 404
    const anonContext = await browser.newContext();
    const anonPage = await anonContext.newPage();
    const anonRes = await anonPage.goto(`/watch/${targetVideo.id}`);
    expect(anonRes?.status()).toBe(404);
    await anonContext.close();

    // 4. Owner (curator) sees video marked hidden in Studio
    const ownerContext = await browser.newContext();
    const ownerPage = await ownerContext.newPage();
    await ownerPage.goto('/login');
    await ownerPage.locator('input[type="email"]').fill(manifest.curator.email);
    await ownerPage.locator('input[type="password"]').fill(PASSWORD);
    await ownerPage.locator('main form button[type="submit"]').click();
    await ownerPage.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 10000 });

    await ownerPage.goto('/studio');
    await expect(ownerPage.locator(`text=${targetVideo.title}`).first()).toBeVisible({
      timeout: 15000,
    });
    // Owner sees hidden notice
    await expect(ownerPage.getByText(/Bị ẩn|HIDDEN|vi phạm/).first()).toBeVisible({
      timeout: 15000,
    });
    await ownerContext.close();

    // 5. Moderator restores video to VISIBLE
    const restoreRes = await request.put(`/v1/videos/${targetVideo.id}/moderation`, {
      headers: { Authorization: `Bearer ${modToken}` },
      data: {
        state: 'VISIBLE',
        reason: 'Đã giải quyết sau khi xem xét',
      },
    });
    expect(restoreRes.status()).toBe(200);

    // Verify public view can now access video again (200)
    const checkRes = await request.get(`/v1/videos/${targetVideo.id}`);
    expect(checkRes.status()).toBe(200);
  });
});
