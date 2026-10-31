import { test, expect } from '@playwright/test';
import {
  sharedPair,
  cspViolations,
  login,
  mediaContext,
  openConversation,
  pairWithConversation,
} from './helpers/stack-pair';

/**
 * SOC-4a 1-1 calls end to end on a running stack: two browser contexts with Chrome's fake camera and microphone.
 * Run: E2E_STACK_URL=http://127.0.0.1:8080 pnpm --filter e2e test:stack calls-soc4a
 */
test.use({
  channel: 'chrome',
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
});

test.describe('SOC-4a: 1-1 voice calls over the E2EE channel', () => {
  test.setTimeout(240_000);

  test('a voice call connects, both see the timer, hang-up writes the history line; then a missed call', async ({
    browser,
  }) => {
    const [an, binh] = await sharedPair();
    await pairWithConversation(an, binh);

    const ctxA = await mediaContext(browser);
    const ctxB = await mediaContext(browser);
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();
    await login(a, an);
    await login(b, binh);
    // Both devices are registered before the call (B's CallProvider listens on every page from then on).
    await openConversation(a, binh.name);
    await openConversation(b, an.name);
    await b.goto('/vi/bang-tin'); // B is elsewhere in the app when the call comes in
    await b.waitForTimeout(1500);

    await a.getByRole('button', { name: 'Gọi thoại' }).click();
    const incoming = b.getByRole('alertdialog', { name: an.name });
    await expect(incoming).toBeVisible({ timeout: 30_000 });
    await expect(incoming).toContainText('Cuộc gọi thoại đến');
    await a.screenshot({ path: 'test-results/calls-1-caller-calling.png' });
    await b.screenshot({ path: 'test-results/calls-2-incoming-overlay.png' });
    await incoming.getByRole('button', { name: 'Trả lời' }).click();

    // Connected: the status shows a running timer (mm:ss) on both sides.
    await expect(a.getByTestId('call-status')).toHaveText(/^\d{2}:\d{2}$/, { timeout: 45_000 });
    await expect(b.getByTestId('call-status')).toHaveText(/^\d{2}:\d{2}$/, { timeout: 45_000 });
    await a.waitForTimeout(3000);
    await a.screenshot({ path: 'test-results/calls-3-connected-caller.png' });
    await b.screenshot({ path: 'test-results/calls-4-connected-callee.png' });

    await a.getByRole('button', { name: 'Kết thúc cuộc gọi' }).click();
    await expect(b.getByTestId('call-status')).toHaveText('Cuộc gọi đã kết thúc', {
      timeout: 30_000,
    });

    // History line in the conversation, on both sides.
    await a
      .getByRole('button', { name: 'Đóng' })
      .click()
      .catch(() => {});
    await expect(a.getByTestId('call-history-line').last()).toContainText(
      /Cuộc gọi thoại · \d+ giây/,
      {
        timeout: 30_000,
      },
    );
    await openConversation(b, an.name);
    await expect(b.getByTestId('call-history-line').last()).toContainText(
      /Cuộc gọi thoại · \d+ giây/,
      {
        timeout: 30_000,
      },
    );
    await b.getByTestId('call-history-line').last().scrollIntoViewIfNeeded();
    await b.screenshot({ path: 'test-results/calls-5-history.png' });

    // Missed: nobody answers within 45 s.
    await a.getByRole('button', { name: 'Gọi thoại' }).click();
    await expect(b.getByRole('alertdialog', { name: an.name })).toBeVisible({ timeout: 30_000 });
    await expect(a.getByTestId('call-status')).toHaveText('Không có người trả lời', {
      timeout: 60_000,
    });
    await expect(b.getByRole('alertdialog', { name: an.name })).toBeHidden({ timeout: 15_000 });
    await expect(b.getByTestId('call-history-line').last()).toContainText('Cuộc gọi thoại nhỡ', {
      timeout: 30_000,
    });
    await b.getByTestId('call-history-line').last().scrollIntoViewIfNeeded();
    await b.screenshot({ path: 'test-results/calls-6-missed.png' });

    expect(await cspViolations(a)).toEqual([]);
    expect(await cspViolations(b)).toEqual([]);
    await ctxA.close();
    await ctxB.close();
  });
});
