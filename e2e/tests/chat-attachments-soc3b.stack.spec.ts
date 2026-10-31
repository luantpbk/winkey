import { test, expect } from '@playwright/test';
import zlib from 'node:zlib';
import {
  sharedPair,
  cspViolations,
  login,
  mediaContext,
  openConversation,
  pairWithConversation,
} from './helpers/stack-pair';

/**
 * SOC-3b encrypted attachments end to end on a running stack with a `winkey-chat` bucket (Garage locally):
 * A sends an image and a PDF; B views the image and downloads the PDF, decrypted in the browser.
 */
test.use({ channel: 'chrome' });

/** A 2400×1600 PNG (solid colour), built without image libraries: the browser must scale it to ≤ 1600 px. */
function bigPng(): Buffer {
  const w = 2400;
  const h = 1600;
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // RGB
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) row.set([217, 0, 43], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test.describe('SOC-3b: encrypted attachments', () => {
  test.setTimeout(180_000);

  test('A sends an image and a PDF; B views the image and downloads the PDF', async ({
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
    await openConversation(a, binh.name);
    await openConversation(b, an.name);

    const pdf = Buffer.from('%PDF-1.4\n% Winkey E2E\n' + 'hop dong '.repeat(500));
    await a.getByTestId('chat-file-input').setInputFiles([
      { name: 'ho-guom.png', mimeType: 'image/png', buffer: bigPng() },
      { name: 'hop-dong.pdf', mimeType: 'application/pdf', buffer: pdf },
    ]);
    await expect(a.getByText(/Sẵn sàng · /)).toHaveCount(2, { timeout: 60_000 });
    await a.screenshot({ path: 'test-results/attach-1-ready.png' });
    await a.getByPlaceholder(/Nhập tin nhắn/).fill('Ảnh và hợp đồng nè');
    await a.getByRole('button', { name: 'Gửi', exact: true }).click();
    await expect(a.getByRole('button', { name: /Xem ảnh ho-guom\.webp/ })).toBeVisible({
      timeout: 30_000,
    });

    // B: thumbnail first, decrypt on click.
    const view = b.getByRole('button', { name: /Xem ảnh ho-guom\.webp/ });
    await expect(view).toBeVisible({ timeout: 30_000 });
    await b.screenshot({ path: 'test-results/attach-2-thumbnail.png' });
    await view.click();
    const img = b.getByRole('img', { name: 'ho-guom.webp' });
    await expect(img).toBeVisible({ timeout: 30_000 });
    expect(await img.getAttribute('src')).toMatch(/^blob:/);
    const width = await img.evaluate((el) => (el as HTMLImageElement).naturalWidth);
    expect(width).toBeLessThanOrEqual(1600);
    expect(width).toBeGreaterThan(0);
    await img.evaluate((el) => el.scrollIntoView({ block: 'end' }));
    await b.screenshot({ path: 'test-results/attach-3-image.png' });

    // Full size opens in an in-page lightbox, never a blob: URL in a new tab.
    const pagesBefore = b.context().pages().length;
    await b.getByRole('button', { name: 'Phóng to ảnh ho-guom.webp' }).click();
    const lightbox = b.getByRole('dialog', { name: 'ho-guom.webp' });
    await expect(lightbox).toBeVisible();
    expect(b.context().pages()).toHaveLength(pagesBefore);
    await b.screenshot({ path: 'test-results/attach-4-lightbox.png' });
    await b.keyboard.press('Escape');
    await expect(lightbox).toBeHidden();

    const downloadPromise = b.waitForEvent('download');
    await b.getByRole('button', { name: 'Tải về hop-dong.pdf' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('hop-dong.pdf');
    const saved = await download.path();
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(saved!).equals(pdf)).toBe(true);

    expect(await cspViolations(a)).toEqual([]);
    expect(await cspViolations(b)).toEqual([]);
    await ctxA.close();
    await ctxB.close();
  });
});
