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
    console.warn(`[persona:chatter] resetRateLimits warning: ${(err as Error)?.message || err}`);
  }
}

interface CspViolationRecord {
  blockedURI: string;
  violatedDirective: string;
  effectiveDirective: string;
  originalPolicy: string;
  disposition: string;
}

test.describe
  .serial('Persona: chatter (SOC-3a E2EE Chat Matrix, Multi-Context, 2nd Device, CSP)', () => {
  let desktopContext: BrowserContext;
  let mobileContext: BrowserContext;
  let device2Context: BrowserContext | null = null;

  let alicePage: Page;
  let bobPage: Page;
  let aliceDev2Page: Page | null = null;

  const suffix = Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
  const aliceHandle = `chatter_a_${suffix}`;
  const aliceEmail = `${aliceHandle}@winkey.test`;
  const aliceName = `Alice Chatter ${suffix}`;

  const bobHandle = `chatter_b_${suffix}`;
  const bobEmail = `${bobHandle}@winkey.test`;
  const bobName = `Bob Chatter ${suffix}`;

  let aliceId = '';
  let bobId = '';

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

    // Context 1: Desktop (Alice) - 1280 x 800
    desktopContext = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      locale: 'vi-VN',
    });
    alicePage = await desktopContext.newPage();
    await setupCspCollection(alicePage, 'alice-desktop');

    // Context 2: Mobile (Bob) - 360 x 740
    mobileContext = await browser.newContext({
      viewport: { width: 360, height: 740 },
      locale: 'vi-VN',
    });
    bobPage = await mobileContext.newPage();
    await setupCspCollection(bobPage, 'bob-mobile');
  });

  test.afterAll(async () => {
    if (alicePage) await reapCspViolations(alicePage, 'alice-desktop');
    if (bobPage) await reapCspViolations(bobPage, 'bob-mobile');
    if (aliceDev2Page) await reapCspViolations(aliceDev2Page, 'alice-dev2');

    await desktopContext?.close();
    await mobileContext?.close();
    if (device2Context) await device2Context.close();
  });

  test('register Alice (desktop) and Bob (mobile), and verify login', async () => {
    const inviteCodePath = path.resolve(__dirname, '../.run/keys/invite_code.txt');
    let inviteCode = manifest?.invite_code || process.env.INVITE_CODE || '';
    if (!inviteCode && fs.existsSync(inviteCodePath)) {
      inviteCode = fs.readFileSync(inviteCodePath, 'utf8').trim();
    }

    // Register Alice
    const regResAlice = await alicePage.request.post('/v1/auth/register', {
      data: {
        handle: aliceHandle,
        email: aliceEmail,
        display_name: aliceName,
        password: PASSWORD,
        ...(inviteCode ? { invite_code: inviteCode } : {}),
      },
    });
    expect(regResAlice.status(), `Register Alice failed: ${await regResAlice.text()}`).toBe(201);
    const aliceData = await regResAlice.json();
    aliceId = aliceData.user.id;
    expect(aliceId).toBeTruthy();

    // Register Bob
    const regResBob = await bobPage.request.post('/v1/auth/register', {
      data: {
        handle: bobHandle,
        email: bobEmail,
        display_name: bobName,
        password: PASSWORD,
        ...(inviteCode ? { invite_code: inviteCode } : {}),
      },
    });
    expect(regResBob.status(), `Register Bob failed: ${await regResBob.text()}`).toBe(201);
    const bobData = await regResBob.json();
    bobId = bobData.user.id;
    expect(bobId).toBeTruthy();

    // Alice logs in on Desktop
    await alicePage.goto('/login');
    await alicePage.locator('input[type="email"]').fill(aliceEmail);
    await alicePage.locator('input[type="password"]').fill(PASSWORD);
    await alicePage.locator('main form button[type="submit"]').click();
    await alicePage.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 15000 });

    // Bob logs in on Mobile
    await bobPage.goto('/login');
    await bobPage.locator('input[type="email"]').fill(bobEmail);
    await bobPage.locator('input[type="password"]').fill(PASSWORD);
    await bobPage.locator('main form button[type="submit"]').click();
    await bobPage.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 15000 });
  });

  test('request -> accept -> conversation (Alice initiates, Bob accepts from requests tab)', async () => {
    // 1. Alice opens /tin-nhan
    await alicePage.goto('/tin-nhan');
    await alicePage.waitForLoadState('domcontentloaded');

    // Wait for chat layout to be ready
    const newChatBtn = alicePage.locator('button:has-text("Tin mới")').first();
    await expect(newChatBtn).toBeVisible({ timeout: 15000 });

    // 2. Alice creates conversation with Bob using Bob user ID
    await newChatBtn.click();
    const directUserInput = alicePage.locator('input#direct-user-id');
    await expect(directUserInput).toBeVisible({ timeout: 10000 });
    await directUserInput.fill(bobId);

    const submitCreateBtn = alicePage.locator('button[type="submit"]:has-text("Tạo trò chuyện")');
    await submitCreateBtn.click();

    // Alice should see active conversation with Bob's name or placeholder
    await expect(directUserInput).not.toBeVisible({ timeout: 10000 });
    await expect(alicePage.locator(`text=${bobName}`).first()).toBeVisible({ timeout: 15000 });

    // 3. Bob opens /tin-nhan on Mobile
    await bobPage.goto('/tin-nhan');
    await bobPage.waitForLoadState('domcontentloaded');

    // Bob switches to "Lời mời" tab
    const requestsTab = bobPage.locator('button:has-text("Lời mời")');
    await expect(requestsTab).toBeVisible({ timeout: 15000 });
    await requestsTab.click();

    // Bob sees Alice's request
    const aliceReqItem = bobPage.locator(`button:has-text("${aliceName}")`).first();
    await expect(aliceReqItem).toBeVisible({ timeout: 15000 });
    await aliceReqItem.click();

    // 4. Bob sees the message request banner with Accept / Decline
    const acceptBtn = bobPage.locator('button:has-text("Chấp nhận")');
    await expect(acceptBtn).toBeVisible({ timeout: 10000 });
    await acceptBtn.click();

    // After acceptance, request banner disappears and composer is enabled
    await expect(acceptBtn).not.toBeVisible({ timeout: 10000 });
    const bobComposer = bobPage.locator('textarea[placeholder*="Nhập tin nhắn"]');
    await expect(bobComposer).toBeEnabled({ timeout: 10000 });

    // 5. Alice sends E2EE message to Bob
    const aliceComposer = alicePage.locator('textarea[placeholder*="Nhập tin nhắn"]');
    await expect(aliceComposer).toBeEnabled({ timeout: 10000 });
    const msg1Text = `Xin chào Bob! E2EE message #1 (${suffix})`;
    await aliceComposer.fill(msg1Text);
    await aliceComposer.press('Enter');

    // Verify Alice sees the decrypted bubble
    const aliceBubble = alicePage.locator(`text=${msg1Text}`).first();
    await expect(aliceBubble).toBeVisible({ timeout: 15000 });

    // 6. Bob receives and decrypts Alice's message
    const bobReceivedBubble = bobPage.locator(`text=${msg1Text}`).first();
    try {
      await expect(bobReceivedBubble).toBeVisible({ timeout: 5000 });
    } catch {
      // Bob was on 'REQUESTED' tab, reload /tin-nhan to land on 'ACTIVE' tab and select the accepted chat
      await bobPage.goto('/tin-nhan');
      const activeConvItem = bobPage.locator(`button:has-text("${aliceName}")`).first();
      await expect(activeConvItem).toBeVisible({ timeout: 15000 });
      await activeConvItem.click();
      await expect(bobReceivedBubble).toBeVisible({ timeout: 20000 });
    }

    // 7. Bob replies to Alice
    const bobActiveComposer = bobPage.locator('textarea[placeholder*="Nhập tin nhắn"]');
    const replyText = `Chào Alice! Reply E2EE from Mobile (${suffix})`;
    await bobActiveComposer.fill(replyText);
    await bobActiveComposer.press('Enter');

    // Verify Bob sees his own sent bubble
    await expect(bobPage.locator(`text=${replyText}`).first()).toBeVisible({ timeout: 15000 });

    // Verify Alice receives and decrypts Bob's reply
    const aliceReceivedReply = alicePage.locator(`text=${replyText}`).first();
    try {
      await expect(aliceReceivedReply).toBeVisible({ timeout: 5000 });
    } catch {
      const convAlice = alicePage.locator(`button:has-text("${bobName}")`).first();
      if (await convAlice.isVisible()) {
        await convAlice.click();
      }
      await expect(aliceReceivedReply).toBeVisible({ timeout: 20000 });
    }
  });

  test('safety number dialog matches on both sides (60 decimal digits)', async () => {
    // 1. Alice clicks "Mã an toàn" button
    const aliceSafetyBtn = alicePage.locator('button[title="Xem mã số an toàn"]');
    await expect(aliceSafetyBtn).toBeVisible({ timeout: 10000 });
    await aliceSafetyBtn.click();

    const aliceModalTitle = alicePage.locator('h3:has-text("Mã số an toàn E2EE")');
    await expect(aliceModalTitle).toBeVisible({ timeout: 10000 });
    const aliceDialog = alicePage.locator('div.fixed', { has: aliceModalTitle });

    // Wait for the numbers to render in the grid
    const aliceGrid = aliceDialog.locator('.grid > div');
    await expect(aliceGrid.first()).toBeVisible({ timeout: 10000 });
    const aliceCount = await aliceGrid.count();
    expect(aliceCount).toBe(12);

    const aliceGroups: string[] = [];
    for (let i = 0; i < aliceCount; i++) {
      const txt = (await aliceGrid.nth(i).textContent())?.trim() || '';
      aliceGroups.push(txt);
    }
    const aliceSafetyNumber = aliceGroups.join('');
    expect(aliceSafetyNumber).toHaveLength(60);
    expect(/^\d{60}$/.test(aliceSafetyNumber)).toBeTruthy();

    // 2. Bob clicks "Mã an toàn" button on mobile
    const bobSafetyBtn = bobPage.locator('button[title="Xem mã số an toàn"]');
    await expect(bobSafetyBtn).toBeVisible({ timeout: 10000 });
    await bobSafetyBtn.click();

    const bobModalTitle = bobPage.locator('h3:has-text("Mã số an toàn E2EE")');
    await expect(bobModalTitle).toBeVisible({ timeout: 10000 });
    const bobDialog = bobPage.locator('div.fixed', { has: bobModalTitle });

    const bobGrid = bobDialog.locator('.grid > div');
    await expect(bobGrid.first()).toBeVisible({ timeout: 10000 });
    const bobCount = await bobGrid.count();
    expect(bobCount).toBe(12);

    const bobGroups: string[] = [];
    for (let i = 0; i < bobCount; i++) {
      const txt = (await bobGrid.nth(i).textContent())?.trim() || '';
      bobGroups.push(txt);
    }
    const bobSafetyNumber = bobGroups.join('');
    expect(bobSafetyNumber).toHaveLength(60);

    // 3. Assert safety numbers are strictly identical on both ends
    expect(aliceSafetyNumber).toBe(bobSafetyNumber);

    // 4. Close dialogs
    await alicePage.locator('button:has-text("Đã hiểu")').click();
    await bobPage.locator('button:has-text("Đã hiểu")').click();
    await expect(aliceModalTitle).not.toBeVisible();
    await expect(bobModalTitle).not.toBeVisible();
  });

  test('a second device for Alice joins and sees new messages', async ({ browser }) => {
    // 1. Create 3rd browser context for Alice Device 2
    device2Context = await browser.newContext({
      viewport: { width: 1024, height: 768 },
      locale: 'vi-VN',
    });
    aliceDev2Page = await device2Context.newPage();
    await setupCspCollection(aliceDev2Page, 'alice-device2');

    // 2. Alice logs into the same account on Device 2
    await aliceDev2Page.goto('/login');
    await aliceDev2Page.locator('input[type="email"]').fill(aliceEmail);
    await aliceDev2Page.locator('input[type="password"]').fill(PASSWORD);
    await aliceDev2Page.locator('main form button[type="submit"]').click();
    await aliceDev2Page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 15000 });

    // 3. Alice Device 2 goes to /tin-nhan
    await aliceDev2Page.goto('/tin-nhan');
    await aliceDev2Page.waitForLoadState('domcontentloaded');

    // Wait for device registration & conversation list to load
    const convItem = aliceDev2Page.locator(`button:has-text("${bobName}")`).first();
    await expect(convItem).toBeVisible({ timeout: 20000 });
    await convItem.click();

    // 4. Bob sends a new message to the conversation
    const msg2Text = `Xin chào cả hai thiết bị của Alice! (${suffix})`;
    const bobComposer = bobPage.locator('textarea[placeholder*="Nhập tin nhắn"]');
    await bobComposer.fill(msg2Text);
    await bobComposer.press('Enter');

    // Bob sees his sent message
    await expect(bobPage.locator(`text=${msg2Text}`).first()).toBeVisible({ timeout: 15000 });

    // Alice Device 1 sees the new message
    const alice1Bubble = alicePage.locator(`text=${msg2Text}`).first();
    try {
      await expect(alice1Bubble).toBeVisible({ timeout: 5000 });
    } catch {
      const convAlice = alicePage.locator(`button:has-text("${bobName}")`).first();
      if (await convAlice.isVisible()) await convAlice.click();
      await expect(alice1Bubble).toBeVisible({ timeout: 20000 });
    }

    // Alice Device 2 sees the new message
    const alice2Bubble = aliceDev2Page.locator(`text=${msg2Text}`).first();
    try {
      await expect(alice2Bubble).toBeVisible({ timeout: 5000 });
    } catch {
      await aliceDev2Page.reload();
      await aliceDev2Page.waitForLoadState('domcontentloaded');
      const convAlice2 = aliceDev2Page.locator(`button:has-text("${bobName}")`).first();
      await expect(convAlice2).toBeVisible({ timeout: 15000 });
      await convAlice2.click();
      await expect(alice2Bubble).toBeVisible({ timeout: 20000 });
    }
  });

  test('delete for everyone (tombstone asserts on sender and recipient)', async () => {
    // 1. Setup dialog accept handler on Alice Device 1
    alicePage.on('dialog', (dialog) => dialog.accept());

    // 2. Alice deletes her message
    const msg1Text = `Xin chào Bob! E2EE message #1 (${suffix})`;
    const targetBubble = alicePage.locator(`text=${msg1Text}`).first();
    await expect(targetBubble).toBeVisible();

    // Hover over bubble group to reveal trash icon
    const bubbleContainer = alicePage.locator('div.group', { has: targetBubble }).first();
    await bubbleContainer.hover();

    const deleteBtn = bubbleContainer.locator('button[title="Thu hồi tin nhắn"]');
    await expect(deleteBtn).toBeVisible({ timeout: 5000 });
    await deleteBtn.click();

    // 3. Sender Alice Device 1 displays tombstone
    const tombstoneAlice = alicePage.locator('text=Tin nhắn đã bị thu hồi').first();
    await expect(tombstoneAlice).toBeVisible({ timeout: 10000 });
    await expect(targetBubble).not.toBeVisible();

    // 4. Recipient Bob displays tombstone
    // On Bob's page, re-select conversation or wait for tombstone
    const tombstoneBob = bobPage.locator('text=Tin nhắn đã bị thu hồi').first();
    try {
      await expect(tombstoneBob).toBeVisible({ timeout: 5000 });
    } catch {
      // If not yet refreshed by realtime hint, switch or reload conversation
      const convButton = bobPage.locator(`button:has-text("${aliceName}")`).first();
      if (await convButton.isVisible()) {
        await convButton.click();
      } else {
        await bobPage.reload();
      }
      await expect(tombstoneBob).toBeVisible({ timeout: 15000 });
    }

    // 5. Alice Device 2 also displays tombstone
    if (aliceDev2Page) {
      const tombstoneDev2 = aliceDev2Page.locator('text=Tin nhắn đã bị thu hồi').first();
      try {
        await expect(tombstoneDev2).toBeVisible({ timeout: 5000 });
      } catch {
        const convButton = aliceDev2Page.locator(`button:has-text("${bobName}")`).first();
        if (await convButton.isVisible()) {
          await convButton.click();
        } else {
          await aliceDev2Page.reload();
        }
        await expect(tombstoneDev2).toBeVisible({ timeout: 15000 });
      }
    }
  });

  test('collect securitypolicyviolation events and assert ZERO violations', async () => {
    // Collect from all active pages
    await reapCspViolations(alicePage, 'alice-desktop');
    await reapCspViolations(bobPage, 'bob-mobile');
    if (aliceDev2Page) {
      await reapCspViolations(aliceDev2Page, 'alice-device2');
    }

    console.log(
      `[persona:chatter] CSP Violations collected: ${collectedCspViolations.length}`,
      collectedCspViolations,
    );

    // Filter out potential non-CSP browser extension noise if any
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
