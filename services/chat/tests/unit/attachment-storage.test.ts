import { describe, it, expect } from 'vitest';
import { loadEnv } from '../../src/config/env.js';
import {
  attachmentObjectKey,
  createAttachmentStorage,
} from '../../src/storage/attachment-storage.js';
import { parseDurationMs } from '../../src/utils/duration.js';

const s3Env = {
  NODE_ENV: 'test',
  CHAT_S3_ENDPOINT: 'http://garage.internal:3900',
  CHAT_S3_PUBLIC_ENDPOINT: 'https://s3.winkey.vn',
  CHAT_S3_REGION: 'garage',
  CHAT_S3_ACCESS_KEY_ID: 'GKTESTKEY',
  CHAT_S3_SECRET_ACCESS_KEY: 'test-secret-not-real',
};

describe('SOC-3b attachment storage (S3, presigned URLs)', () => {
  it('is null without the bucket env, so the service starts and answers 503', () => {
    expect(createAttachmentStorage(loadEnv({ NODE_ENV: 'test' }))).toBeNull();
    expect(
      createAttachmentStorage(loadEnv({ ...s3Env, CHAT_S3_SECRET_ACCESS_KEY: undefined })),
    ).toBeNull();
  });

  it('presigns a PUT on the public origin, path-style, signing Content-Length and Content-Type', async () => {
    const storage = createAttachmentStorage(loadEnv(s3Env))!;
    const key = attachmentObjectKey(
      '0192f5e4-7c1a-7b3e-9d2a-00000000c001',
      '0192f5e4-7c1a-7b3e-9d2a-00000000a001',
    );
    const { url, headers } = await storage.presignPut(key, 1234, 900);
    const u = new URL(url);
    expect(u.origin).toBe('https://s3.winkey.vn');
    expect(u.pathname).toBe(`/winkey-chat/${key}`);
    expect(u.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(u.searchParams.get('X-Amz-SignedHeaders')?.split(';')).toEqual(
      expect.arrayContaining(['content-length', 'content-type', 'host']),
    );
    // No SDK checksum of the presign-time (empty) body: the browser uploads the real bytes.
    expect([...u.searchParams.keys()].filter((k) => k.toLowerCase().includes('checksum'))).toEqual(
      [],
    );
    expect(headers).toEqual({
      'Content-Type': 'application/octet-stream',
      'Content-Length': '1234',
    });
    // The key never carries a file name: only the two ids.
    expect(key).toMatch(/^c\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/);
  });

  it('presigns a 5-minute GET', async () => {
    const storage = createAttachmentStorage(loadEnv(s3Env))!;
    const url = new URL(await storage.presignGet('c/x/y', 300));
    expect(url.origin).toBe('https://s3.winkey.vn');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
  });

  it('rejects a malformed CHAT_ATTACHMENT_TTL and parses durations', () => {
    expect(() => loadEnv({ NODE_ENV: 'test', CHAT_ATTACHMENT_TTL: 'thirty days' })).toThrow();
    expect(parseDurationMs('30d')).toBe(30 * 24 * 60 * 60 * 1000);
    expect(parseDurationMs('15m')).toBe(15 * 60 * 1000);
    expect(parseDurationMs('nonsense', 42)).toBe(42);
  });
});
