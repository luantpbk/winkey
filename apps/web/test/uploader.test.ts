import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  MultipartUploader,
  computeFileFingerprint,
  type UploadProgress,
} from '../src/lib/uploader/uploader';
import {
  saveUploadSession,
  getUploadSession,
  deleteUploadSession,
} from '../src/lib/uploader/indexeddb';

describe('MultipartUploader State Machine', () => {
  const dummyFile = new File(['a'.repeat(35 * 1024 * 1024)], 'test-video.mp4', {
    type: 'video/mp4',
    lastModified: 1700000000000,
  });

  beforeEach(async () => {
    const fp = computeFileFingerprint(dummyFile);
    await deleteUploadSession(fp);
    vi.restoreAllMocks();
  });

  const getRequestBody = async (input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof init?.body === 'string') {
      try {
        return JSON.parse(init.body);
      } catch {
        return {};
      }
    }
    if (input instanceof Request) {
      try {
        const text = await input.clone().text();
        return text ? JSON.parse(text) : {};
      } catch {
        return {};
      }
    }
    return {};
  };

  it('runs full multipart upload flow: init -> presign -> parallel PUTs -> complete', async () => {
    let parallelCount = 0;
    let maxObservedParallel = 0;
    const completedPartsSent: any[] = [];

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : '';
      const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();

      // POST /v1/uploads
      if (url.includes('/v1/uploads') && method === 'POST' && !url.includes('/parts') && !url.includes('/complete')) {
        return new Response(
          JSON.stringify({
            video_id: 'video-uuid-12345',
            part_size: 16 * 1024 * 1024,
            part_count: 3,
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } }
        );
      }

      // POST /v1/uploads/{id}/parts
      if (url.includes('/parts') && method === 'POST') {
        const body = await getRequestBody(input, init);
        const partNumbers = body.part_numbers || [];
        return new Response(
          JSON.stringify({
            urls: partNumbers.map((pn: number) => ({
              part_number: pn,
              url: `https://s3.winkey.vn/upload/part-${pn}?sig=mock`,
            })),
            expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      // PUT to S3
      if (method === 'PUT') {
        parallelCount++;
        maxObservedParallel = Math.max(maxObservedParallel, parallelCount);
        await new Promise((r) => setTimeout(r, 20));
        parallelCount--;
        return new Response(null, {
          status: 200,
          headers: { ETag: '"test-etag-mock"' },
        });
      }

      // POST /v1/uploads/{id}/complete
      if (url.includes('/complete') && method === 'POST') {
        const body = await getRequestBody(input, init);
        completedPartsSent.push(...(body.parts || []));
        return new Response(
          JSON.stringify({
            video_id: 'video-uuid-12345',
            status: 'UPLOADED',
            progress: 25,
            error: null,
          }),
          { status: 202, headers: { 'Content-Type': 'application/json' } }
        );
      }

      return new Response(null, { status: 404 });
    });

    const progressUpdates: UploadProgress[] = [];
    const uploader = new MultipartUploader({
      file: dummyFile,
      title: 'Test Video',
      onProgress: (p) => progressUpdates.push(p),
    });

    const videoId = await uploader.start();

    expect(videoId).toBe('video-uuid-12345');
    expect(maxObservedParallel).toBeLessThanOrEqual(4);
    expect(completedPartsSent.length).toBe(3);
    // Unchanged ETag string sent back as per contract
    expect(completedPartsSent[0].etag).toBe('"test-etag-mock"');
    expect(progressUpdates.some((p) => p.status === 'completed')).toBe(true);

    const saved = await getUploadSession(computeFileFingerprint(dummyFile));
    expect(saved).toBeNull();
  });

  it('retries part uploads with exponential backoff on transient failure', async () => {
    let putAttemptCount = 0;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : '';
      const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();

      if (url.includes('/v1/uploads') && method === 'POST' && !url.includes('/parts') && !url.includes('/complete')) {
        return new Response(
          JSON.stringify({
            video_id: 'video-retry-123',
            part_size: 35 * 1024 * 1024,
            part_count: 1,
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (url.includes('/parts') && method === 'POST') {
        return new Response(
          JSON.stringify({
            urls: [{ part_number: 1, url: 'https://s3.winkey.vn/part-1' }],
            expires_at: new Date().toISOString(),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (method === 'PUT') {
        putAttemptCount++;
        if (putAttemptCount < 3) {
          return new Response('S3 Internal Error', { status: 500 });
        }
        return new Response(null, {
          status: 200,
          headers: { ETag: '"etag-retry-ok"' },
        });
      }

      if (url.includes('/complete') && method === 'POST') {
        return new Response(JSON.stringify({ status: 'UPLOADED' }), { status: 202 });
      }

      return new Response(null, { status: 404 });
    });

    const uploader = new MultipartUploader({
      file: dummyFile,
      title: 'Retry Test',
      maxRetries: 3,
    });

    const videoId = await uploader.start();

    expect(videoId).toBe('video-retry-123');
    expect(putAttemptCount).toBe(3); // 2 failures + 1 success
  });

  it('resumes incomplete upload from IndexedDB session state', async () => {
    const fp = computeFileFingerprint(dummyFile);
    await saveUploadSession({
      fingerprint: fp,
      video_id: 'resumed-video-id-999',
      part_size: 18 * 1024 * 1024,
      part_count: 2,
      completed_parts: [{ part_number: 1, etag: 'etag-saved-part-1' }],
      created_at: Date.now() - 10000,
    });

    const presignedPartNumbers: number[] = [];
    const putParts: number[] = [];
    let completedPartsPayload: any[] = [];

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : '';
      const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();

      if (url.includes('/parts') && method === 'POST') {
        const body = await getRequestBody(input, init);
        presignedPartNumbers.push(...(body.part_numbers || []));
        return new Response(
          JSON.stringify({
            urls: (body.part_numbers || []).map((pn: number) => ({
              part_number: pn,
              url: `https://s3.winkey.vn/part-${pn}`,
            })),
            expires_at: new Date().toISOString(),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (method === 'PUT') {
        const partMatch = url.match(/part-(\d+)/);
        if (partMatch) putParts.push(parseInt(partMatch[1], 10));
        return new Response(null, {
          status: 200,
          headers: { ETag: '"etag-for-part-2"' },
        });
      }

      if (url.includes('/complete') && method === 'POST') {
        const body = await getRequestBody(input, init);
        completedPartsPayload = body.parts || [];
        return new Response(JSON.stringify({ status: 'UPLOADED' }), { status: 202 });
      }

      return new Response(null, { status: 404 });
    });

    const uploader = new MultipartUploader({
      file: dummyFile,
      title: 'Resumed Upload',
    });

    const videoId = await uploader.start();

    expect(videoId).toBe('resumed-video-id-999');
    expect(presignedPartNumbers).toEqual([2]);
    expect(putParts).toEqual([2]);
    expect(completedPartsPayload).toEqual([
      { part_number: 1, etag: 'etag-saved-part-1' },
      { part_number: 2, etag: '"etag-for-part-2"' },
    ]);
  });

  it('refreshes presigned URL when S3 returns 403 (expired TTL) and retries successfully', async () => {
    let presignCallCount = 0;
    let putAttemptCount = 0;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : '';
      const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();

      if (url.includes('/v1/uploads') && method === 'POST' && !url.includes('/parts') && !url.includes('/complete')) {
        return new Response(
          JSON.stringify({
            video_id: 'video-403-refresh',
            part_size: 35 * 1024 * 1024,
            part_count: 1,
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (url.includes('/parts') && method === 'POST') {
        presignCallCount++;
        return new Response(
          JSON.stringify({
            urls: [{ part_number: 1, url: `https://s3.winkey.vn/part-1?token=${presignCallCount}` }],
            expires_at: new Date().toISOString(),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (method === 'PUT') {
        putAttemptCount++;
        if (url.includes('token=1')) {
          // First attempt gets 403 forbidden (expired presigned URL)
          return new Response('Forbidden: Request has expired', { status: 403 });
        }
        // Second attempt with fresh URL succeeds
        return new Response(null, {
          status: 200,
          headers: { ETag: '"fresh-token-etag"' },
        });
      }

      if (url.includes('/complete') && method === 'POST') {
        return new Response(JSON.stringify({ status: 'UPLOADED' }), { status: 202 });
      }

      return new Response(null, { status: 404 });
    });

    const uploader = new MultipartUploader({
      file: dummyFile,
      title: 'S3 403 URL Expiration Test',
      maxRetries: 3,
    });

    const videoId = await uploader.start();

    expect(videoId).toBe('video-403-refresh');
    expect(presignCallCount).toBe(2); // First presign + re-presign on 403
    expect(putAttemptCount).toBe(2); // 403 failed + fresh retry succeeded
  });

  it('cancels upload and sends DELETE /v1/uploads/{id}', async () => {
    let deleteCalled = false;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : '';
      const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();

      if (url.includes('/v1/uploads') && method === 'POST' && !url.includes('/parts')) {
        return new Response(
          JSON.stringify({
            video_id: 'cancel-test-id',
            part_size: 16 * 1024 * 1024,
            part_count: 5,
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (url.includes('/parts') && method === 'POST') {
        const body = await getRequestBody(input, init);
        const partNumbers = body.part_numbers || [1, 2, 3, 4, 5];
        return new Response(
          JSON.stringify({
            urls: partNumbers.map((pn: number) => ({
              part_number: pn,
              url: `https://s3.winkey.vn/part-${pn}`,
            })),
            expires_at: new Date().toISOString(),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (method === 'PUT') {
        return new Promise((resolve, reject) => {
          if (init?.signal?.aborted) {
            const err = new Error('AbortError');
            err.name = 'AbortError';
            return reject(err);
          }
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('AbortError');
            err.name = 'AbortError';
            reject(err);
          });
        });
      }

      if (url.includes('/v1/uploads/cancel-test-id') && method === 'DELETE') {
        deleteCalled = true;
        return new Response(null, { status: 204 });
      }

      return new Response(null, { status: 404 });
    });

    const uploader = new MultipartUploader({
      file: dummyFile,
      title: 'Cancel Test',
    });

    const uploadPromise = uploader.start();

    setTimeout(() => {
      uploader.cancel();
    }, 50);

    await expect(uploadPromise).rejects.toThrow('UPLOAD_CANCELLED');
    expect(deleteCalled).toBe(true);

    const saved = await getUploadSession(computeFileFingerprint(dummyFile));
    expect(saved).toBeNull();
  });
});
