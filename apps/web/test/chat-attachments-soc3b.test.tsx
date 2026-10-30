import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Blob as NodeBlob } from 'node:buffer';

const chatPost = vi.fn();
vi.mock('../src/lib/api-client', () => ({
  api: { chat: { POST: (...args: unknown[]) => chatPost(...args) } },
}));

import {
  decryptFile,
  encodeThumbnail,
  encryptFile,
  fitWithin,
  toBase64,
  uploadAttachment,
  IMAGE_MAX_EDGE,
  AttachmentError,
} from '../src/lib/e2ee/attachments';
import {
  parseChatEvent,
  serializeTextEvent,
  MAX_THUMB_BYTES,
  type AttachmentRef,
} from '../src/lib/e2ee/events';
import { AttachmentList } from '../src/components/chat/attachment-view';

const CONV = '0192f5e4-7c1a-7b3e-9d2a-00000000c001';
const ATT = '0192f5e4-7c1a-7b3e-9d2a-00000000a001';

async function makeRef(plain: Uint8Array<ArrayBuffer>, extra: Partial<AttachmentRef> = {}) {
  const enc = await encryptFile(plain);
  const ref: AttachmentRef = {
    v: 1,
    id: ATT,
    key: enc.key,
    iv: enc.iv,
    sha256: enc.sha256,
    mime: 'application/pdf',
    name: 'hop-dong.pdf',
    size: plain.length,
    ...extra,
  };
  return { enc, ref };
}

describe('SOC-3b: attachment crypto', () => {
  it('round-trips AES-256-GCM with a fresh key and IV per file', async () => {
    const plain = new TextEncoder().encode('Xin chào, đây là tệp bí mật 🔒');
    const a = await encryptFile(plain);
    const b = await encryptFile(plain);
    expect(a.key).not.toBe(b.key);
    expect(a.iv).not.toBe(b.iv);
    expect(Buffer.from(a.ciphertext).includes(Buffer.from(plain))).toBe(false);
    const out = await decryptFile(a.ciphertext, a);
    expect(new TextDecoder().decode(out)).toBe('Xin chào, đây là tệp bí mật 🔒');
  });

  it('refuses a ciphertext whose SHA-256 does not match, before decrypting', async () => {
    const { enc, ref } = await makeRef(new Uint8Array([1, 2, 3, 4]));
    const tampered = new Uint8Array(enc.ciphertext);
    tampered[0] = tampered[0]! ^ 0xff;
    await expect(decryptFile(tampered, ref)).rejects.toMatchObject({ code: 'INTEGRITY' });
    // A matching hash but the wrong key is refused too (GCM authentication).
    const other = await encryptFile(new Uint8Array([9]));
    await expect(decryptFile(enc.ciphertext, { ...ref, key: other.key })).rejects.toBeInstanceOf(
      AttachmentError,
    );
  });
});

describe('SOC-3b: preparing images', () => {
  it('keeps the long edge at or under 1600 px and never upscales', () => {
    expect(fitWithin(4032, 3024, IMAGE_MAX_EDGE)).toEqual({ width: 1600, height: 1200 });
    expect(fitWithin(1080, 1920, IMAGE_MAX_EDGE)).toEqual({ width: 900, height: 1600 });
    expect(fitWithin(800, 600, IMAGE_MAX_EDGE)).toEqual({ width: 800, height: 600 });
    expect(fitWithin(20000, 10, IMAGE_MAX_EDGE)).toEqual({ width: 1600, height: 1 });
  });

  it('shrinks the thumbnail until it fits in 8 KiB, or gives up', async () => {
    const calls: Array<[number, number, number]> = [];
    // A fake encoder whose output size depends on pixels and quality.
    const encode = async (w: number, h: number, q: number) => {
      calls.push([w, h, q]);
      return new NodeBlob([new Uint8Array(Math.round(w * h * q * 6))]) as unknown as Blob;
    };
    const thumb = await encodeThumbnail(1600, 1200, encode);
    expect(thumb).not.toBeNull();
    expect(thumb!.length).toBeLessThanOrEqual(MAX_THUMB_BYTES);
    expect(Math.max(calls.at(-1)![0], calls.at(-1)![1])).toBeLessThanOrEqual(64);

    const never = await encodeThumbnail(
      1600,
      1200,
      async () => new NodeBlob([new Uint8Array(9000)]) as unknown as Blob,
    );
    expect(never).toBeNull();
  });
});

describe('SOC-3b: the encrypted event shape', () => {
  it('round-trips and validates attachment refs', async () => {
    const { ref } = await makeRef(new Uint8Array([1]), { thumb: toBase64(new Uint8Array(100)) });
    const parsed = parseChatEvent(serializeTextEvent('Ảnh nè', [ref]));
    expect(parsed).toEqual({ type: 'text', body: 'Ảnh nè', attachments: [ref] });
    expect(parseChatEvent('{"type":"text","body":"hi"}')).toEqual({ type: 'text', body: 'hi' });
  });

  it('rejects malformed or unknown events instead of trusting them', async () => {
    const { ref } = await makeRef(new Uint8Array([1]));
    const bad = (patch: Record<string, unknown>) =>
      parseChatEvent(
        JSON.stringify({ type: 'text', body: '', attachments: [{ ...ref, ...patch }] }),
      );
    expect(bad({ v: 2 })).toBeNull();
    expect(bad({ id: 'not-a-uuid' })).toBeNull();
    expect(bad({ key: toBase64(new Uint8Array(16)) })).toBeNull(); // 128-bit key
    expect(bad({ iv: toBase64(new Uint8Array(16)) })).toBeNull();
    expect(bad({ mime: 'text/html; charset=utf-8' })).toBeNull();
    expect(bad({ size: -1 })).toBeNull();
    expect(bad({ thumb: toBase64(new Uint8Array(MAX_THUMB_BYTES + 100)) })).toBeNull();
    expect(parseChatEvent(JSON.stringify({ type: 'html', body: '<b>x</b>' }))).toBeNull();
    expect(parseChatEvent('not json')).toBeNull();
    const tooMany = Array.from({ length: 11 }, () => ref);
    expect(
      parseChatEvent(JSON.stringify({ type: 'text', body: '', attachments: tooMany })),
    ).toBeNull();
  });
});

describe('SOC-3b: upload', () => {
  beforeEach(() => {
    chatPost.mockReset();
  });

  it('creates, PUTs exactly the signed headers, completes, and returns the ref', async () => {
    const put = vi.fn();
    class FakeXhr {
      upload: {
        onprogress?: (e: { lengthComputable: boolean; loaded: number; total: number }) => void;
      } = {};
      status = 200;
      onload?: () => void;
      headers: Record<string, string> = {};
      open(method: string, url: string) {
        put(method, url);
      }
      setRequestHeader(k: string, v: string) {
        this.headers[k] = v;
      }
      send(body: Uint8Array) {
        put('headers', this.headers, body.length);
        this.upload.onprogress?.({
          lengthComputable: true,
          loaded: body.length,
          total: body.length,
        });
        this.onload?.();
      }
      abort() {}
    }
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    chatPost.mockImplementation(async (path: string, opts: { body?: { size_bytes: number } }) => {
      if (path.endsWith('/attachments')) {
        return {
          data: {
            attachment: { id: ATT },
            upload_url: 'https://s3.test/winkey-chat/c/x/y?sig',
            upload_headers: {
              'Content-Type': 'application/octet-stream',
              'Content-Length': String(opts.body!.size_bytes),
            },
          },
          response: new Response(null, { status: 201 }),
        };
      }
      return {
        data: { id: ATT, state: 'UPLOADED' },
        response: new Response(null, { status: 200 }),
      };
    });
    const progress = vi.fn();
    const ref = await uploadAttachment({
      conversationId: CONV,
      deviceId: '0192f5e4-7c1a-7b3e-9d2a-00000000d001',
      prepared: { bytes: new Uint8Array(1000), mime: 'application/pdf', name: 'a.pdf' },
      onProgress: progress,
    });
    const size = chatPost.mock.calls[0]![1].body.size_bytes;
    expect(size).toBe(1000 + 16); // GCM tag
    expect(put).toHaveBeenCalledWith('PUT', 'https://s3.test/winkey-chat/c/x/y?sig');
    expect(put).toHaveBeenCalledWith(
      'headers',
      { 'Content-Type': 'application/octet-stream' },
      size,
    );
    expect(progress).toHaveBeenCalledWith(1);
    expect(chatPost.mock.calls[1]![0]).toContain('/complete');
    expect(ref).toMatchObject({
      v: 1,
      id: ATT,
      mime: 'application/pdf',
      name: 'a.pdf',
      size: 1000,
    });
    vi.unstubAllGlobals();
  });
});

describe('SOC-3b: showing attachments', () => {
  const created: string[] = [];
  beforeEach(() => {
    chatPost.mockReset();
    created.length = 0;
    vi.stubGlobal(
      'URL',
      Object.assign(URL, {
        createObjectURL: vi.fn(() => {
          created.push('blob:x');
          return 'blob:winkey/1';
        }),
        revokeObjectURL: vi.fn(),
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('decrypts a file on demand, after checking its hash, and revokes the blob URL on unmount', async () => {
    const plain = new TextEncoder().encode('%PDF-1.7');
    const { enc, ref } = await makeRef(plain);
    chatPost.mockResolvedValue({
      data: { url: 'https://s3.test/get?sig', expires_at: '', size_bytes: enc.ciphertext.length },
      response: new Response(null, { status: 200 }),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(enc.ciphertext)),
    );
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    const { unmount } = render(<AttachmentList conversationId={CONV} attachments={[ref]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Tải về hop-dong.pdf' }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(chatPost.mock.calls[0]![0]).toContain('/download');
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:winkey/1');
  });

  it('says "Tệp đã hết hạn" on 410, and never shows a file that fails the hash check', async () => {
    const { ref } = await makeRef(new Uint8Array([1, 2]), {
      mime: 'image/webp',
      name: 'anh.webp',
      width: 1600,
      height: 1200,
    });
    chatPost.mockResolvedValueOnce({
      data: undefined,
      error: { code: 'ATTACHMENT_EXPIRED' },
      response: new Response(null, { status: 410 }),
    });
    render(<AttachmentList conversationId={CONV} attachments={[ref]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Xem ảnh anh.webp' }));
    expect(await screen.findByText('Tệp đã hết hạn')).toBeTruthy();

    chatPost.mockResolvedValueOnce({
      data: { url: 'https://s3.test/get?sig', expires_at: '', size_bytes: 3 },
      response: new Response(null, { status: 200 }),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array([7, 7, 7]))),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Xem ảnh anh.webp' }));
    expect(await screen.findByText('Tệp không hợp lệ, không thể hiển thị')).toBeTruthy();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
});
