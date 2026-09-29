import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VideoClient } from '../../src/video/video-client.js';

describe('VideoClient', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('allows access on 200 OK and caches the decision', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
    });
    globalThis.fetch = mockFetch;

    const client = new VideoClient('http://video-svc:8080');
    const videoId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c01';
    const userId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c02';
    const roles = ['creator'];

    const allowed = await client.canAccessVideo({ videoId, userId, roles });
    expect(allowed).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const callArgs = mockFetch.mock.calls[0];
    expect(callArgs[0]).toBe(`http://video-svc:8080/v1/videos/${videoId}`);
    expect(callArgs[1]?.headers?.['X-User-Id']).toBe(userId);
    expect(callArgs[1]?.headers?.['X-User-Roles']).toBe('creator');

    // Second call for same video & user hits cache
    const secondCall = await client.canAccessVideo({ videoId, userId, roles });
    expect(secondCall).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('forbids access on 404 or other non-200 responses', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 404,
    });
    globalThis.fetch = mockFetch;

    const client = new VideoClient('http://video-svc:8080');
    const videoId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c99';

    const allowed = await client.canAccessVideo({ videoId, userId: null });
    expect(allowed).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('fails closed on network errors', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('Connection refused'));
    globalThis.fetch = mockFetch;

    const client = new VideoClient('http://video-svc:8080');
    const videoId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c01';

    const allowed = await client.canAccessVideo({ videoId });
    expect(allowed).toBe(false);
  });
});
