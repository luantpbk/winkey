import { describe, it, expect, beforeAll } from 'vitest';
import { buildApp } from '../../src/server.js';
import { getEnv } from '../../src/config/env.js';
import { createMockDb, createMockStore } from '../fixtures/mock-db.js';
import { ValkeyRateLimiter } from '../../src/rate-limit/valkey-limiter.js';
import type { FastifyInstance } from 'fastify';

describe('Social Service Flow (In-Memory)', () => {
  let app: FastifyInstance;
  const mockStore = createMockStore();

  const videoId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9101';
  const ownerId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9102';
  const authorId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9103';
  const strangerId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9104';
  const channelId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9105';

  beforeAll(async () => {
    mockStore.videos.push({
      id: videoId,
      owner_id: ownerId,
      like_count: 0,
      comment_count: 0,
      created_at: new Date(),
    });

    mockStore.public_profiles.push(
      {
        id: authorId,
        handle: 'alice_flow',
        display_name: 'Alice Flow',
        avatar_key: 'avatars/alice.jpg',
      },
      { id: ownerId, handle: 'bob_owner', display_name: 'Bob Owner', avatar_key: null },
      { id: strangerId, handle: 'david_stranger', display_name: 'David', avatar_key: null },
      {
        id: channelId,
        handle: 'charlie_channel',
        display_name: 'Charlie',
        avatar_key: 'avatars/charlie.jpg',
      },
    );

    const env = getEnv({
      NODE_ENV: 'test',
      MEDIA_BASE_URL: 'https://media.winkey.vn',
    });

    const { db } = createMockDb(mockStore);
    const rateLimiter = new ValkeyRateLimiter();

    app = await buildApp({
      env,
      db,
      rateLimiter,
    });
  });

  it('Health and Readiness checks work', async () => {
    const healthz = await app.inject({ method: 'GET', url: '/healthz' });
    expect(healthz.statusCode).toBe(200);
    expect(healthz.json().status).toBe('ok');

    const readyz = await app.inject({ method: 'GET', url: '/readyz' });
    expect(readyz.statusCode).toBe(200);
    expect(readyz.json().status).toBe('ok');
    expect(readyz.json().checks.db).toBe('ok');
  });

  it('Comment validation: body trimming and length constraints', async () => {
    // Empty body
    const emptyRes = await app.inject({
      method: 'POST',
      url: `/v1/videos/${videoId}/comments`,
      headers: { 'x-user-id': authorId },
      payload: { body: '   ' },
    });
    expect(emptyRes.statusCode).toBe(400);

    // Body too long (> 2000 chars)
    const longRes = await app.inject({
      method: 'POST',
      url: `/v1/videos/${videoId}/comments`,
      headers: { 'x-user-id': authorId },
      payload: { body: 'a'.repeat(2001) },
    });
    expect(longRes.statusCode).toBe(400);

    // Valid body with whitespace is trimmed
    const validRes = await app.inject({
      method: 'POST',
      url: `/v1/videos/${videoId}/comments`,
      headers: { 'x-user-id': authorId },
      payload: { body: '  Valid trimmed content  ' },
    });
    expect(validRes.statusCode).toBe(201);
    expect(validRes.json().body).toBe('Valid trimmed content');
  });

  it('Author permissions on edit and stranger rejection', async () => {
    const postRes = await app.inject({
      method: 'POST',
      url: `/v1/videos/${videoId}/comments`,
      headers: { 'x-user-id': authorId },
      payload: { body: 'Original body' },
    });
    const cId = postRes.json().id;

    // Stranger tries to edit -> 403
    const strangerRes = await app.inject({
      method: 'PATCH',
      url: `/v1/comments/${cId}`,
      headers: { 'x-user-id': strangerId },
      payload: { body: 'Stranger modification' },
    });
    expect(strangerRes.statusCode).toBe(403);

    // Author edits -> 200
    const authorRes = await app.inject({
      method: 'PATCH',
      url: `/v1/comments/${cId}`,
      headers: { 'x-user-id': authorId },
      payload: { body: 'Author edited body' },
    });
    expect(authorRes.statusCode).toBe(200);
    expect(authorRes.json().body).toBe('Author edited body');
  });

  it('Delete permissions: stranger rejected, owner and author allowed', async () => {
    // 1. Author deletes own comment
    const post1 = await app.inject({
      method: 'POST',
      url: `/v1/videos/${videoId}/comments`,
      headers: { 'x-user-id': authorId },
      payload: { body: 'To be deleted by author' },
    });
    const id1 = post1.json().id;

    const delAuthor = await app.inject({
      method: 'DELETE',
      url: `/v1/comments/${id1}`,
      headers: { 'x-user-id': authorId },
    });
    expect(delAuthor.statusCode).toBe(204);

    // 2. Stranger tries to delete -> 403
    const post2 = await app.inject({
      method: 'POST',
      url: `/v1/videos/${videoId}/comments`,
      headers: { 'x-user-id': authorId },
      payload: { body: 'Stranger cannot delete' },
    });
    const id2 = post2.json().id;

    const delStranger = await app.inject({
      method: 'DELETE',
      url: `/v1/comments/${id2}`,
      headers: { 'x-user-id': strangerId },
    });
    expect(delStranger.statusCode).toBe(403);

    // 3. Video owner deletes -> 204
    const delOwner = await app.inject({
      method: 'DELETE',
      url: `/v1/comments/${id2}`,
      headers: { 'x-user-id': ownerId },
    });
    expect(delOwner.statusCode).toBe(204);
  });

  it('Likes and unlikes flow', async () => {
    // Initial status
    const getInit = await app.inject({
      method: 'GET',
      url: `/v1/videos/${videoId}/like`,
      headers: { 'x-user-id': authorId },
    });
    expect(getInit.statusCode).toBe(200);
    expect(getInit.json().liked).toBe(false);

    // Like
    const putLike = await app.inject({
      method: 'PUT',
      url: `/v1/videos/${videoId}/like`,
      headers: { 'x-user-id': authorId },
    });
    expect(putLike.statusCode).toBe(200);
    expect(putLike.json().liked).toBe(true);

    // Duplicate like is idempotent
    const putLike2 = await app.inject({
      method: 'PUT',
      url: `/v1/videos/${videoId}/like`,
      headers: { 'x-user-id': authorId },
    });
    expect(putLike2.statusCode).toBe(200);

    // Unlike
    const delLike = await app.inject({
      method: 'DELETE',
      url: `/v1/videos/${videoId}/like`,
      headers: { 'x-user-id': authorId },
    });
    expect(delLike.statusCode).toBe(200);
    expect(delLike.json().liked).toBe(false);
  });

  it('Subscriptions and list subscriptions flow', async () => {
    // Self subscribe rejected
    const selfRes = await app.inject({
      method: 'PUT',
      url: `/v1/channels/${authorId}/subscription`,
      headers: { 'x-user-id': authorId },
    });
    expect(selfRes.statusCode).toBe(400);

    // Unknown channel rejected
    const unkRes = await app.inject({
      method: 'PUT',
      url: '/v1/channels/00000000-0000-7000-8000-000000000000/subscription',
      headers: { 'x-user-id': authorId },
    });
    expect(unkRes.statusCode).toBe(404);

    // Subscribe to channel
    const subRes = await app.inject({
      method: 'PUT',
      url: `/v1/channels/${channelId}/subscription`,
      headers: { 'x-user-id': authorId },
    });
    expect(subRes.statusCode).toBe(200);
    expect(subRes.json().subscribed).toBe(true);

    // List my subscriptions
    const mySubs = await app.inject({
      method: 'GET',
      url: '/v1/me/subscriptions',
      headers: { 'x-user-id': authorId },
    });
    expect(mySubs.statusCode).toBe(200);
    expect(mySubs.json().items.length).toBeGreaterThan(0);
    expect(mySubs.json().items[0].channel.handle).toBe('charlie_channel');

    // Unsubscribe
    const unsubRes = await app.inject({
      method: 'DELETE',
      url: `/v1/channels/${channelId}/subscription`,
      headers: { 'x-user-id': authorId },
    });
    expect(unsubRes.statusCode).toBe(200);
    expect(unsubRes.json().subscribed).toBe(false);
  });
});
