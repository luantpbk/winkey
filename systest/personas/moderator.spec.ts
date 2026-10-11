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

test.describe('Persona: moderator (Report, Hide, Owner Notice, Public 404 & Restore, ADR-038)', () => {
  let modToken = '';
  let memberToken = '';
  let targetVideo: any = null;

  test.beforeAll(async ({ request }) => {
    // 1. Member login token
    if (manifest?.users?.[0]) {
      const uRes = await request.post('/v1/auth/login', {
        data: { email: manifest.users[0].email, password: PASSWORD },
      });
      if (uRes.ok()) {
        const data = await uRes.json();
        memberToken = data.access_token;
      }
    }

    // 3. Moderator login token
    if (manifest?.moderator) {
      const mRes = await request.post('/v1/auth/login', {
        data: { email: manifest.moderator.email, password: PASSWORD },
      });
      if (mRes.ok()) {
        const data = await mRes.json();
        modToken = data.access_token;
      }
    }

    targetVideo = manifest?.videos?.find((v: any) => v.visibility === 'PUBLIC');
  });

  test('member reports video -> moderator hides it -> owner sees notice, public gets 404 -> restore', async ({
    page,
    request,
    browser,
  }) => {
    test.skip(!targetVideo, 'Requires target video');

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
    await page.fill('input[name="email"], input[id="email"]', manifest.moderator.email);
    await page.fill('input[name="password"], input[id="password"]', PASSWORD);
    await page.click('button[type="submit"]');
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
    await ownerPage.fill('input[name="email"], input[id="email"]', manifest.curator.email);
    await ownerPage.fill('input[name="password"], input[id="password"]', PASSWORD);
    await ownerPage.click('button[type="submit"]');

    await ownerPage.goto('/studio');
    await expect(ownerPage.locator(`text=${targetVideo.title}`).first()).toBeVisible({
      timeout: 15000,
    });
    // Owner sees hidden notice
    await expect(ownerPage.locator('text=Bị ẩn, text=HIDDEN, text=vi phạm').first()).toBeVisible({
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
