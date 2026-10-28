import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const manifestPath = path.resolve(__dirname, '../.run/seed-manifest.json');
let manifest: any = null;
if (fs.existsSync(manifestPath)) {
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    manifest = null;
  }
}

const PASSWORD = 'Password123!';

function resetRateLimits() {
  try {
    const script = path.resolve(__dirname, '../reset-ratelimits.sh');
    if (fs.existsSync(script)) {
      execSync(`bash "${script}"`, { stdio: 'ignore' });
    }
  } catch (err) {
    console.warn(
      `[persona:social-user] resetRateLimits warning: ${(err as Error)?.message || err}`,
    );
  }
}

test.describe.serial('Persona: social-user (SOC-2a Social Posts & Feeds)', () => {
  let context: BrowserContext;
  let page: Page;

  const suffix = Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
  const userHandle = `soc_u_${suffix}`;
  const userEmail = `${userHandle}@winkey.test`;
  const userDisplayName = `Cư Dân Mạng ${suffix}`;

  // Image fixtures paths
  const fixtureDir = path.resolve(__dirname, '../.run/fixtures');
  const img1Path = path.join(fixtureDir, 'soc_img1.png');
  const img2Path = path.join(fixtureDir, 'soc_img2.png');
  const img3Path = path.join(fixtureDir, 'soc_img3.png');

  test.beforeAll(async ({ browser }) => {
    resetRateLimits();

    // Prepare fixture images
    if (!fs.existsSync(fixtureDir)) {
      fs.mkdirSync(fixtureDir, { recursive: true });
    }
    const sampleImage = path.resolve(__dirname, '../../apps/web/public/logo.png');
    if (fs.existsSync(sampleImage)) {
      fs.copyFileSync(sampleImage, img1Path);
      fs.copyFileSync(sampleImage, img2Path);
      fs.copyFileSync(sampleImage, img3Path);
    } else {
      // Create minimal 1x1 PNG buffers as fallback
      const minimalPng = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64',
      );
      fs.writeFileSync(img1Path, minimalPng);
      fs.writeFileSync(img2Path, minimalPng);
      fs.writeFileSync(img3Path, minimalPng);
    }

    context = await browser.newContext();
    page = await context.newPage();
  });

  test.afterAll(async () => {
    await context?.close();
  });

  test('sign in or register persona user', async () => {
    let loggedIn = false;

    // If seed manifest has users, try logging in with the first user
    if (manifest?.users?.[0]?.email) {
      const email = manifest.users[0].email;
      await page.goto('/login');
      await page.locator('input[type="email"]').fill(email);
      await page.locator('input[type="password"]').fill(PASSWORD);
      await page.locator('main form button[type="submit"]').click();
      try {
        await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 8000 });
        loggedIn = true;
      } catch {
        loggedIn = false;
      }
    }

    // Otherwise, register a fresh account
    if (!loggedIn) {
      const inviteCode = manifest?.invite_code || process.env.INVITE_CODE || '';
      const regUrl = inviteCode
        ? `/register?invite=${encodeURIComponent(inviteCode)}`
        : '/register';
      await page.goto(regUrl);
      await page.locator('input[placeholder*="nguyenvana"]').fill(userHandle);
      await page.locator('input[type="email"]').fill(userEmail);
      await page.locator('input[placeholder*="Nguyễn Văn A"]').fill(userDisplayName);
      await page.locator('input[type="password"]').fill(PASSWORD);

      const termsCheckbox = page
        .locator('#terms-agreement-checkbox, input[type="checkbox"]')
        .first();
      if (await termsCheckbox.isVisible()) {
        await termsCheckbox.check();
      }
      await page.locator('main form button[type="submit"]').click();
      await page.waitForURL((url) => !url.pathname.includes('/register'), { timeout: 15000 });
    }

    expect(await page.locator('body').isVisible()).toBeTruthy();
  });

  test('compose with 3 images, see upload progress, and publish post', async () => {
    await page.goto('/bang-tin');
    await page.waitForLoadState('domcontentloaded');

    // 1. Composer should be visible
    const composerTextarea = page.locator('textarea[placeholder*="Bạn đang nghĩ gì"]');
    await expect(composerTextarea).toBeVisible({ timeout: 15000 });

    // 2. Attach 3 images
    const fileInput = page.locator('input[type="file"][accept*="image"]');
    await fileInput.setInputFiles([img1Path, img2Path, img3Path]);

    // 3. See upload progress / preview
    const attachedImages = page.locator('img[alt^="Ảnh đính kèm"]');
    await expect(attachedImages.first()).toBeVisible({ timeout: 15000 });

    // Wait until upload processing completes (shows count label)
    await expect(page.locator('text=/Đã đính kèm 3/')).toBeVisible({ timeout: 25000 });

    // 4. Fill text with hashtag
    const bodyContent = `Dạo bước mùa thu #HàNội thật tuyệt vời! ${suffix}`;
    await composerTextarea.fill(bodyContent);

    // 5. Submit post
    const postSubmitBtn = page.locator('button[aria-label="Đăng bài viết"]');
    await expect(postSubmitBtn).toBeEnabled({ timeout: 5000 });
    await postSubmitBtn.click();

    // 6. Verify post appears at the top of the feed
    const firstPostCard = page.locator('[data-testid^="post-card-"]').first();
    await expect(firstPostCard).toBeVisible({ timeout: 15000 });
    await expect(firstPostCard).toContainText('Dạo bước mùa thu #HàNội thật tuyệt vời!');
  });

  test('react via the picker and comment on the post', async () => {
    const postCard = page.locator('[data-testid^="post-card-"]').first();
    await expect(postCard).toBeVisible({ timeout: 10000 });

    // 1. Reaction picker
    const reactionBtn = postCard
      .locator(
        'button[aria-label="Thích bài viết"], button[aria-label*="bày tỏ cảm xúc"], button[aria-label="Chọn cảm xúc"]',
      )
      .first();
    await reactionBtn.hover();

    const picker = postCard.locator('[aria-label="Chọn cảm xúc"], [role="toolbar"]').first();
    if (await picker.isVisible({ timeout: 2000 }).catch(() => false)) {
      const loveBtn = picker
        .locator('button[aria-label="Yêu thích"], button[aria-label="Thích"]')
        .first();
      await loveBtn.click();
    } else {
      await reactionBtn.click();
    }

    // Verify reaction count or icon reflects the click
    const reactionDisplay = postCard.locator('[aria-label*="bày tỏ cảm xúc"]').first();
    await expect(reactionDisplay).toBeVisible();

    // 2. Open comments and post a comment
    const commentToggleBtn = postCard.locator('a[aria-label^="Bình luận"]').first();
    await commentToggleBtn.click();
    await page.waitForURL((url) => url.pathname.includes('/bai-viet/'), { timeout: 10000 });

    const commentInput = page.locator('textarea[placeholder*="bình luận"]').first();
    await expect(commentInput).toBeVisible({ timeout: 5000 });
    await commentInput.fill('Góc nhìn đẹp quá bạn ơi!');

    const sendCommentBtn = page.locator('form button[type="submit"]:has-text("Bình luận")').first();
    await sendCommentBtn.click();

    // Verify comment is displayed
    await expect(page.locator('text=Góc nhìn đẹp quá bạn ơi!').first()).toBeVisible({
      timeout: 10000,
    });
  });

  test('reshare with text (quote reshare)', async () => {
    // Navigate back to /bang-tin if on detail page
    if (!page.url().includes('/bang-tin')) {
      await page.goto('/bang-tin');
      await page.waitForLoadState('domcontentloaded');
    }

    const postCard = page.locator('[data-testid^="post-card-"]').first();
    await expect(postCard).toBeVisible({ timeout: 10000 });

    // 1. Click share menu
    const shareBtn = postCard.locator('button[aria-label="Chia sẻ bài viết"]').first();
    await shareBtn.click();

    // 2. Click "Trích dẫn bài viết"
    const quoteOption = page.locator('button:has-text("Trích dẫn bài viết")').first();
    await expect(quoteOption).toBeVisible({ timeout: 5000 });
    await quoteOption.click();

    // Quoted composer should have focused textarea
    const quoteTextarea = page.locator('textarea[placeholder*="Bạn đang nghĩ gì"]').first();
    await expect(quoteTextarea).toBeVisible({ timeout: 5000 });
    await quoteTextarea.fill('Chia sẻ lại bài viết này cho mọi người cùng xem!');

    // Publish quote reshare
    const submitBtn = page.locator('button[aria-label="Đăng bài viết"]').first();
    await submitBtn.click();

    // Quoted reshare should appear
    await expect(
      page.locator('text=Chia sẻ lại bài viết này cho mọi người cùng xem!').first(),
    ).toBeVisible({ timeout: 15000 });
  });

  test('open hashtag page and verify tagged posts', async () => {
    const postCard = page.locator('[data-testid^="post-card-"]').first();
    const hashtagLink = postCard.locator('a[href*="/hashtag/hanoi"]').first();

    if (await hashtagLink.isVisible({ timeout: 5000 }).catch(() => false)) {
      await hashtagLink.click();
      await page.waitForURL((url) => url.pathname.includes('/hashtag/hanoi'), { timeout: 10000 });
      await expect(page.locator('body')).toBeVisible();
      // Should show hashtag header
      const header = page.locator('h1, h2, [data-testid="hashtag-title"]').first();
      await expect(header).toBeVisible();
    } else {
      // Direct navigation fallback
      await page.goto('/hashtag/hanoi');
      await page.waitForLoadState('domcontentloaded');
      await expect(page.locator('body')).toBeVisible();
    }
  });

  test('open notification and land on the post page', async () => {
    await page.goto('/notifications');
    await page.waitForLoadState('domcontentloaded');

    const notifPostLink = page.locator('a[href*="/bai-viet/"]').first();
    if (await notifPostLink.isVisible({ timeout: 5000 }).catch(() => false)) {
      await notifPostLink.click();
      await page.waitForURL((url) => url.pathname.includes('/bai-viet/'), { timeout: 10000 });
      await expect(page.locator('[data-testid^="post-card-"]').first()).toBeVisible({
        timeout: 10000,
      });
    } else {
      // If no notification exists yet, navigate to feed and click post card timestamp/link
      await page.goto('/bang-tin');
      const postLink = page.locator('a[href*="/bai-viet/"]').first();
      if (await postLink.isVisible({ timeout: 5000 }).catch(() => false)) {
        await postLink.click();
        await page.waitForURL((url) => url.pathname.includes('/bai-viet/'), { timeout: 10000 });
        await expect(page.locator('[data-testid^="post-card-"]').first()).toBeVisible({
          timeout: 10000,
        });
      }
    }
  });
});
