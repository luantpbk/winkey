import { describe, it, expect } from 'vitest';
import {
  createAuthClient,
  createUploadClient,
  createVideoClient,
  createWinkeyClient,
} from '../src/index.js';

describe('@winkey/api-client', () => {
  it('creates individual and unified clients', () => {
    const authClient = createAuthClient();
    const uploadClient = createUploadClient();
    const videoClient = createVideoClient();
    const unified = createWinkeyClient();

    expect(authClient).toBeDefined();
    expect(uploadClient).toBeDefined();
    expect(videoClient).toBeDefined();
    expect(unified.auth).toBeDefined();
    expect(unified.upload).toBeDefined();
    expect(unified.video).toBeDefined();
  });

  it('injects Bearer token via getAccessToken middleware', async () => {
    let capturedHeaders: Headers | undefined;
    const mockFetch: typeof fetch = async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init);
      capturedHeaders = req.headers;
      return new Response(JSON.stringify({ id: '123' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const client = createAuthClient({
      fetch: mockFetch,
      baseUrl: 'http://localhost:8080',
      getAccessToken: () => 'test-jwt-token-123',
    });

    await client.GET('/v1/auth/me');

    expect(capturedHeaders?.get('Authorization')).toBe('Bearer test-jwt-token-123');
  });

  it('does not overwrite explicitly passed Authorization header', async () => {
    let capturedHeaders: Headers | undefined;
    const mockFetch: typeof fetch = async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init);
      capturedHeaders = req.headers;
      return new Response(JSON.stringify({ id: '123' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const client = createAuthClient({
      fetch: mockFetch,
      baseUrl: 'http://localhost:8080',
      getAccessToken: () => 'default-token',
    });

    await client.GET('/v1/auth/me', {
      headers: {
        Authorization: 'Bearer explicit-token-override',
      },
    });

    expect(capturedHeaders?.get('Authorization')).toBe('Bearer explicit-token-override');
  });

  it('sends no Authorization header when getAccessToken returns null', async () => {
    let capturedHeaders: Headers | undefined;
    const mockFetch: typeof fetch = async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init);
      capturedHeaders = req.headers;
      return new Response(JSON.stringify({ id: '123' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const client = createAuthClient({
      fetch: mockFetch,
      baseUrl: 'http://localhost:8080',
      getAccessToken: () => null,
    });

    await client.GET('/v1/auth/me');

    expect(capturedHeaders?.has('Authorization')).toBe(false);
  });

  it('omits Authorization header for listRelatedVideos even when getAccessToken returns a token', async () => {
    let capturedHeaders: Headers | undefined;
    const mockFetch: typeof fetch = async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init);
      capturedHeaders = req.headers;
      return new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const client = createVideoClient({
      fetch: mockFetch,
      baseUrl: 'http://localhost:8080',
      getAccessToken: () => 'signed-in-user-token-xyz',
    });

    await client.GET('/v1/videos/{video_id}/related', {
      params: {
        path: { video_id: 'vid-123' },
        query: { limit: 12 },
      },
    });

    expect(capturedHeaders?.has('Authorization')).toBe(false);
  });
});
