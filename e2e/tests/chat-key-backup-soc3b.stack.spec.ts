import { test, expect } from '@playwright/test';
import {
  createUser,
  cspViolations,
  login,
  mediaContext,
  openConversation,
  pairWithConversation,
} from './helpers/stack-pair';

/**
 * SOC-3b key backup end to end: A chats, turns on backup, then logs in on a fresh browser profile (a new E2EE
 * device without keys), restores with the passphrase and reads the old messages.
 */
test.use({ channel: 'chrome' });

test.describe('SOC-3b: key backup and restore', () => {
  test.setTimeout(240_000);

  test('enable backup, restore on a fresh profile, read the old messages', async ({ browser }) => {
    const an = await createUser('an', 'An Sao Lưu');
    const binh = await createUser('binh', 'Bình Bạn');
    await pairWithConversation(an, binh);

    const ctxA = await mediaContext(browser);
    const ctxB = await mediaContext(browser);
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();
    await login(a, an);
    await login(b, binh);
    await openConversation(a, binh.name);
    await openConversation(b, an.name);

    await b.getByPlaceholder(/Nhập tin nhắn/).fill('Tin cũ từ Bình trước khi An đổi máy');
    await b.keyboard.press('Enter');
    await expect(a.getByText('Tin cũ từ Bình trước khi An đổi máy')).toBeVisible({
      timeout: 30_000,
    });

    // Turn on backup with the generated passphrase.
    await a.goto('/vi/cai-dat/bao-mat');
    await a.getByRole('button', { name: 'Bật sao lưu' }).click();
    const phrase = (await a.getByTestId('generated-passphrase').textContent())!.trim();
    expect(phrase.split(' ')).toHaveLength(5);
    await a.getByLabel('Nhập lại cụm mật khẩu để xác nhận').fill(phrase);
    await a.getByLabel(/Tôi đã lưu cụm mật khẩu/).check();
    await a.screenshot({ path: 'test-results/backup-1-setup.png' });
    await a.getByRole('dialog').getByRole('button', { name: 'Bật sao lưu' }).click();
    await expect(a.getByTestId('backup-status')).toContainText(
      /Đang bật · [1-9]\d*\/[1-9]\d* khoá/,
      {
        timeout: 120_000,
      },
    );
    await a.screenshot({ path: 'test-results/backup-2-on.png' });

    // A fresh profile = a new device with no keys.
    const ctxA2 = await mediaContext(browser);
    const a2 = await ctxA2.newPage();
    await login(a2, an);
    await openConversation(a2, binh.name);
    await expect(a2.getByText('Đang chờ khoá giải mã…').first()).toBeVisible({ timeout: 30_000 });
    const banner = a2.getByRole('region', { name: 'Khôi phục lịch sử tin nhắn' });
    await expect(banner).toBeVisible({ timeout: 30_000 });
    await a2.screenshot({ path: 'test-results/backup-3-banner.png' });
    await banner.getByRole('button', { name: 'Khôi phục lịch sử' }).click();

    await a2.getByLabel('Cụm mật khẩu khôi phục').fill('sai mật khẩu hoàn toàn');
    await a2.getByRole('dialog').getByRole('button', { name: 'Khôi phục', exact: true }).click();
    await expect(a2.getByRole('dialog').getByRole('alert')).toHaveText(
      'Cụm mật khẩu khôi phục không đúng.',
      {
        timeout: 120_000,
      },
    );

    await a2.getByLabel('Cụm mật khẩu khôi phục').fill(phrase);
    await a2.getByRole('dialog').getByRole('button', { name: 'Khôi phục', exact: true }).click();
    await expect(banner).toBeHidden({ timeout: 120_000 });
    await openConversation(a2, binh.name);
    await expect(a2.getByText('Tin cũ từ Bình trước khi An đổi máy')).toBeVisible({
      timeout: 30_000,
    });
    await a2.screenshot({ path: 'test-results/backup-4-restored.png' });

    for (const p of [a, b, a2]) expect(await cspViolations(p)).toEqual([]);
    await ctxA.close();
    await ctxB.close();
    await ctxA2.close();
  });
});
