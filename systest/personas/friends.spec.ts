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
    console.warn(`[persona:friends] resetRateLimits warning: ${(err as Error)?.message || err}`);
  }
}

interface CspViolationRecord {
  blockedURI: string;
  violatedDirective: string;
  effectiveDirective: string;
  originalPolicy: string;
  disposition: string;
}

test.describe.serial('Persona: friends (SOC-3b / SOC-6b Friends & Unaccented Search)', () => {
  let user1Context: BrowserContext;
  let user2Context: BrowserContext;

  let user1Page: Page;
  let user2Page: Page;

  const suffix = Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
  const user1Handle = `tuan_${suffix}`;
  const user1Email = `${user1Handle}@winkey.test`;
  const user1Name = `Phạm Minh Đức ${suffix}`;

  const user2Handle = `long_${suffix}`;
  const user2Email = `${user2Handle}@winkey.test`;
  const user2Name = `Trần Bảo Hoàng Long ${suffix}`;

  let user1Id = '';
  let user2Id = '';

  const collectedCspViolations: { context: string; violation: CspViolationRecord }[] = [];

  async function setupCspCollection(p: Page, _label: string) {
    await p.addInitScript(() => {
      (window as any).__cspViolations = [];
      window.addEventListener('securitypolicyviolation', (e) => {
        const item: CspViolationRecord = {
          blockedURI: e.blockedURI,
          violatedDirective: e.violatedDirective,
          effectiveDirective: e.effectiveDirective,
          originalPolicy: e.originalPolicy,
          disposition: e.disposition,
        };
        (window as any).__cspViolations.push(item);
      });
    });
  }

  async function reapCspViolations(p: Page, label: string) {
    try {
      const records = await p.evaluate(() => (window as any).__cspViolations || []);
      for (const rec of records) {
        collectedCspViolations.push({ context: label, violation: rec });
      }
    } catch {
      // Page might be closed or navigating
    }
  }

  test.beforeAll(async ({ browser }) => {
    resetRateLimits();

    user1Context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: 'vi-VN',
    });
    user1Page = await user1Context.newPage();
    await setupCspCollection(user1Page, 'user1-tuan');

    user2Context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: 'vi-VN',
    });
    user2Page = await user2Context.newPage();
    await setupCspCollection(user2Page, 'user2-long');
  });

  test.afterAll(async () => {
    if (user1Page) await reapCspViolations(user1Page, 'user1-tuan');
    if (user2Page) await reapCspViolations(user2Page, 'user2-long');

    await user1Context?.close();
    await user2Context?.close();
  });

  test('register User 1 (Phạm Minh Đức) and User 2 (Trần Bảo Hoàng Long), and verify login', async () => {
    const inviteCodePath = path.resolve(__dirname, '../.run/keys/invite_code.txt');
    let inviteCode = manifest?.invite_code || process.env.INVITE_CODE || '';
    if (!inviteCode && fs.existsSync(inviteCodePath)) {
      inviteCode = fs.readFileSync(inviteCodePath, 'utf8').trim();
    }

    // Register User 1
    const regRes1 = await user1Page.request.post('/v1/auth/register', {
      data: {
        handle: user1Handle,
        email: user1Email,
        display_name: user1Name,
        password: PASSWORD,
        ...(inviteCode ? { invite_code: inviteCode } : {}),
      },
    });
    expect(regRes1.status(), `Register User 1 failed: ${await regRes1.text()}`).toBe(201);
    const data1 = await regRes1.json();
    user1Id = data1.user.id;
    expect(user1Id).toBeTruthy();

    // Register User 2
    const regRes2 = await user2Page.request.post('/v1/auth/register', {
      data: {
        handle: user2Handle,
        email: user2Email,
        display_name: user2Name,
        password: PASSWORD,
        ...(inviteCode ? { invite_code: inviteCode } : {}),
      },
    });
    expect(regRes2.status(), `Register User 2 failed: ${await regRes2.text()}`).toBe(201);
    const data2 = await regRes2.json();
    user2Id = data2.user.id;
    expect(user2Id).toBeTruthy();

    // User 1 logs in
    await user1Page.goto('/login');
    await user1Page.locator('input[type="email"]').fill(user1Email);
    await user1Page.locator('input[type="password"]').fill(PASSWORD);
    await user1Page.locator('main form button[type="submit"]').click();
    await user1Page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 15000 });

    // User 2 logs in
    await user2Page.goto('/login');
    await user2Page.locator('input[type="email"]').fill(user2Email);
    await user2Page.locator('input[type="password"]').fill(PASSWORD);
    await user2Page.locator('main form button[type="submit"]').click();
    await user2Page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 15000 });
  });

  test('search by unaccented name, send friend request, accept in /ban-be, and open chat', async () => {
    // 1. User 1 goes to /ban-be?tab=tim-ban
    await user1Page.goto('/ban-be?tab=tim-ban');
    await user1Page.waitForLoadState('domcontentloaded');

    // User 1 types unaccented query "hoang long"
    const searchInput = user1Page.locator('input[type="search"]');
    await expect(searchInput).toBeVisible({ timeout: 15000 });
    await searchInput.fill('hoang long');

    // User 2 "Trần Bảo Hoàng Long" appears in search results
    const user2Row = user1Page.locator('li', { hasText: user2Name });
    await expect(user2Row).toBeVisible({ timeout: 15000 });

    // User 1 clicks "Kết bạn"
    const friendBtn = user2Row.locator('button', { hasText: 'Kết bạn' }).first();
    await expect(friendBtn).toBeVisible({ timeout: 10000 });
    await friendBtn.click();

    // Button updates to "Đã gửi lời mời"
    await expect(user2Row.locator('text=Đã gửi lời mời').first()).toBeVisible({ timeout: 10000 });

    // 2. User 2 visits /ban-be?tab=loi-moi to accept the request
    await user2Page.goto('/ban-be?tab=loi-moi');
    await user2Page.waitForLoadState('domcontentloaded');

    // User 2 sees the friend request from User 1 "Phạm Minh Đức"
    const reqRow = user2Page.locator('li', { hasText: user1Name });
    await expect(reqRow).toBeVisible({ timeout: 15000 });

    // User 2 clicks "Chấp nhận"
    const acceptBtn = reqRow.locator('button:has-text("Chấp nhận")');
    await expect(acceptBtn).toBeVisible({ timeout: 10000 });
    await acceptBtn.click();

    // Verified: request handled and success banner/status appears
    await expect(acceptBtn).not.toBeVisible({ timeout: 10000 });

    // 3. User 1 visits /ban-be (Friends list)
    await user1Page.goto('/ban-be');
    await user1Page.waitForLoadState('domcontentloaded');

    // User 2 appears in User 1's friends list
    const friendRow = user1Page.locator('li', { hasText: user2Name });
    await expect(friendRow).toBeVisible({ timeout: 15000 });

    // User 1 clicks "Nhắn tin" link to start chat with User 2
    const chatLink = friendRow.locator(`a[href*="/tin-nhan?to=${user2Id}"]`).first();
    await expect(chatLink).toBeVisible({ timeout: 10000 });
    await chatLink.click();

    // Verify User 1 lands on /tin-nhan with User 2 selected
    await user1Page.waitForURL((url) => url.pathname.includes('/tin-nhan'), { timeout: 15000 });
    await expect(user1Page.locator(`text=${user2Name}`).first()).toBeVisible({ timeout: 15000 });

    // 4. Send chat message to newly connected friend
    const composer = user1Page.locator('textarea[placeholder*="Nhập tin nhắn"]');
    await expect(composer).toBeEnabled({ timeout: 15000 });
    const greetingText = `Chào bạn! Chúng ta đã là bạn bè trên Winkey (${suffix})`;
    await composer.fill(greetingText);
    await composer.press('Enter');

    // Sent message bubble appears
    await expect(user1Page.locator(`text=${greetingText}`).first()).toBeVisible({ timeout: 15000 });
  });

  test('collect securitypolicyviolation events and assert ZERO violations', async () => {
    await reapCspViolations(user1Page, 'user1-tuan');
    await reapCspViolations(user2Page, 'user2-long');

    console.log(
      `[persona:friends] CSP Violations collected: ${collectedCspViolations.length}`,
      collectedCspViolations,
    );

    const realViolations = collectedCspViolations.filter(
      (v) =>
        !v.violation.blockedURI.startsWith('chrome-extension://') &&
        !v.violation.blockedURI.startsWith('moz-extension://'),
    );

    expect(
      realViolations,
      `Detected Content Security Policy violations: ${JSON.stringify(realViolations, null, 2)}`,
    ).toHaveLength(0);
  });
});
