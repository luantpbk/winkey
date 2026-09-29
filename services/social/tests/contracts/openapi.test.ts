import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { buildApp } from '../../src/server.js';
import { getEnv } from '../../src/config/env.js';
import { createMockDb, createMockStore } from '../fixtures/mock-db.js';
import { ValkeyRateLimiter } from '../../src/rate-limit/valkey-limiter.js';
import type { FastifyInstance } from 'fastify';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('OpenAPI Contract Verification against social.v1.yaml and common.yaml', () => {
  let app: FastifyInstance;
  let ajv: Ajv;
  let validateComment: any;
  let validateCommentPage: any;
  let validateLikeState: any;
  let validateSubscriptionState: any;
  let validateSubscriptionPage: any;
  let validateProblem: any;

  const mockStore = createMockStore();

  const videoId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c01';
  const ownerId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c02';
  const authorId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c03';
  const channelId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c04';
  let commentId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c05';
  let replyId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c06';

  beforeAll(async () => {
    // 1. Load OpenAPI contracts
    const socialYamlPath = path.resolve(__dirname, '../../../../contracts/openapi/social.v1.yaml');
    const commonYamlPath = path.resolve(__dirname, '../../../../contracts/openapi/common.yaml');

    const socialSpec = parseYaml(fs.readFileSync(socialYamlPath, 'utf8'));
    const commonSpec = parseYaml(fs.readFileSync(commonYamlPath, 'utf8'));

    // 2. Setup Ajv
    ajv = new Ajv({ strict: false, allErrors: true });
    (addFormats as any)(ajv);

    commonSpec.$id = 'https://winkey.vn/contracts/openapi/common.yaml';
    socialSpec.$id = 'https://winkey.vn/contracts/openapi/social.v1.yaml';

    ajv.addSchema(commonSpec);
    ajv.addSchema(socialSpec);

    validateComment = ajv.getSchema(
      'https://winkey.vn/contracts/openapi/social.v1.yaml#/components/schemas/Comment',
    )!;
    validateCommentPage = ajv.getSchema(
      'https://winkey.vn/contracts/openapi/social.v1.yaml#/components/schemas/CommentPage',
    )!;
    validateLikeState = ajv.getSchema(
      'https://winkey.vn/contracts/openapi/social.v1.yaml#/components/schemas/LikeState',
    )!;
    validateSubscriptionState = ajv.getSchema(
      'https://winkey.vn/contracts/openapi/social.v1.yaml#/components/schemas/SubscriptionState',
    )!;
    validateSubscriptionPage = ajv.getSchema(
      'https://winkey.vn/contracts/openapi/social.v1.yaml#/components/schemas/SubscriptionPage',
    )!;
    validateProblem = ajv.getSchema(
      'https://winkey.vn/contracts/openapi/common.yaml#/components/schemas/Problem',
    )!;

    // 3. Populate mock store
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
        handle: 'author_user',
        display_name: 'Author User',
        avatar_key: 'avatars/author.jpg',
      },
      { id: ownerId, handle: 'owner_channel', display_name: 'Owner Channel', avatar_key: null },
      {
        id: channelId,
        handle: 'cool_creator',
        display_name: 'Cool Creator',
        avatar_key: 'avatars/creator.jpg',
      },
    );

    // 4. Build app
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

  it('POST /v1/videos/{video_id}/comments returns 201 matching Comment schema and Location header', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/videos/${videoId}/comments`,
      headers: {
        'x-user-id': authorId,
        'x-user-roles': 'creator',
      },
      payload: {
        body: '  This is an amazing video!  ',
      },
    });

    expect(res.statusCode).toBe(201);
    expect(res.headers.location).toMatch(/^\/v1\/comments\//);
    const body = res.json();
    commentId = body.id;

    const valid = validateComment(body);
    expect(validateComment.errors).toBeNull();
    expect(valid).toBe(true);
    expect(body.body).toBe('This is an amazing video!');
    expect(body.author.handle).toBe('author_user');
    expect(body.author.avatar_url).toBe('https://media.winkey.vn/avatars/author.jpg');
    expect(body.can_edit).toBe(true);
    expect(body.can_delete).toBe(true);
  });

  it('GET /v1/videos/{video_id}/comments returns 200 matching CommentPage schema', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/videos/${videoId}/comments`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    const valid = validateCommentPage(body);
    expect(validateCommentPage.errors).toBeNull();
    expect(valid).toBe(true);
    expect(body.items.length).toBeGreaterThan(0);
  });

  it('POST reply to a comment returns 201 matching Comment schema', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/videos/${videoId}/comments`,
      headers: {
        'x-user-id': ownerId,
        'x-user-roles': 'viewer',
      },
      payload: {
        parent_id: commentId,
        body: 'Thank you for watching!',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    replyId = body.id;

    const valid = validateComment(body);
    expect(validateComment.errors).toBeNull();
    expect(valid).toBe(true);
    expect(body.parent_id).toBe(commentId);
  });

  it('GET /v1/comments/{comment_id}/replies returns 200 matching CommentPage schema', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/comments/${commentId}/replies`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    const valid = validateCommentPage(body);
    expect(validateCommentPage.errors).toBeNull();
    expect(valid).toBe(true);
    expect(body.items.length).toBe(1);
    expect(body.items[0].id).toBe(replyId);
  });

  it('GET /v1/comments/{comment_id} returns 200 matching Comment schema', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/comments/${commentId}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    const valid = validateComment(body);
    expect(validateComment.errors).toBeNull();
    expect(valid).toBe(true);
  });

  it('PATCH /v1/comments/{comment_id} returns 200 matching Comment schema', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/comments/${commentId}`,
      headers: {
        'x-user-id': authorId,
      },
      payload: {
        body: 'Updated comment content',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    const valid = validateComment(body);
    expect(validateComment.errors).toBeNull();
    expect(valid).toBe(true);
    expect(body.body).toBe('Updated comment content');
    expect(body.edited_at).not.toBeNull();
  });

  it('PUT /v1/comments/{comment_id}/moderation returns 200 matching Comment schema', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/v1/comments/${commentId}/moderation`,
      headers: {
        'x-user-id': ownerId,
        'x-user-roles': 'moderator',
      },
      payload: {
        status: 'HIDDEN',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    const valid = validateComment(body);
    expect(validateComment.errors).toBeNull();
    expect(valid).toBe(true);
    expect(body.status).toBe('HIDDEN');

    // Restore to VISIBLE
    await app.inject({
      method: 'PUT',
      url: `/v1/comments/${commentId}/moderation`,
      headers: {
        'x-user-id': ownerId,
        'x-user-roles': 'admin',
      },
      payload: {
        status: 'VISIBLE',
      },
    });
  });

  it('GET /v1/videos/{video_id}/like returns 200 matching LikeState schema', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/videos/${videoId}/like`,
      headers: {
        'x-user-id': authorId,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    const valid = validateLikeState(body);
    expect(validateLikeState.errors).toBeNull();
    expect(valid).toBe(true);
  });

  it('PUT and DELETE /v1/videos/{video_id}/like return 200 matching LikeState schema', async () => {
    // Like
    const putRes = await app.inject({
      method: 'PUT',
      url: `/v1/videos/${videoId}/like`,
      headers: {
        'x-user-id': authorId,
      },
    });

    expect(putRes.statusCode).toBe(200);
    const putBody = putRes.json();
    expect(validateLikeState(putBody)).toBe(true);
    expect(putBody.liked).toBe(true);
    expect(putBody.like_count).toBe(1);

    // Unlike
    const delRes = await app.inject({
      method: 'DELETE',
      url: `/v1/videos/${videoId}/like`,
      headers: {
        'x-user-id': authorId,
      },
    });

    expect(delRes.statusCode).toBe(200);
    const delBody = delRes.json();
    expect(validateLikeState(delBody)).toBe(true);
    expect(delBody.liked).toBe(false);
    expect(delBody.like_count).toBe(0);
  });

  it('GET, PUT, DELETE /v1/channels/{channel_id}/subscription return 200 matching SubscriptionState schema', async () => {
    // GET initial
    const getRes = await app.inject({
      method: 'GET',
      url: `/v1/channels/${channelId}/subscription`,
    });
    expect(getRes.statusCode).toBe(200);
    expect(validateSubscriptionState(getRes.json())).toBe(true);

    // PUT subscribe
    const putRes = await app.inject({
      method: 'PUT',
      url: `/v1/channels/${channelId}/subscription`,
      headers: {
        'x-user-id': authorId,
      },
    });
    expect(putRes.statusCode).toBe(200);
    const putBody = putRes.json();
    expect(validateSubscriptionState(putBody)).toBe(true);
    expect(putBody.subscribed).toBe(true);
    expect(putBody.subscriber_count).toBe(1);

    // GET /v1/me/subscriptions
    const meRes = await app.inject({
      method: 'GET',
      url: '/v1/me/subscriptions',
      headers: {
        'x-user-id': authorId,
      },
    });
    expect(meRes.statusCode).toBe(200);
    const meBody = meRes.json();
    expect(validateSubscriptionPage(meBody)).toBe(true);
    expect(meBody.items.length).toBe(1);
    expect(meBody.items[0].channel.handle).toBe('cool_creator');

    // DELETE unsubscribe
    const delRes = await app.inject({
      method: 'DELETE',
      url: `/v1/channels/${channelId}/subscription`,
      headers: {
        'x-user-id': authorId,
      },
    });
    expect(delRes.statusCode).toBe(200);
    const delBody = delRes.json();
    expect(validateSubscriptionState(delBody)).toBe(true);
    expect(delBody.subscribed).toBe(false);
  });

  it('DELETE /v1/comments/{comment_id} returns 204', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/comments/${commentId}`,
      headers: {
        'x-user-id': authorId,
      },
    });

    expect(res.statusCode).toBe(204);
  });

  it('Error responses match RFC 9457 Problem schema in common.yaml', async () => {
    // 401 Unauthorized
    const unauthRes = await app.inject({
      method: 'POST',
      url: `/v1/videos/${videoId}/comments`,
      payload: { body: 'test' },
    });
    expect(unauthRes.statusCode).toBe(401);
    expect(unauthRes.headers['content-type']).toContain('application/problem+json');
    expect(validateProblem(unauthRes.json())).toBe(true);

    // 404 Video Not Found
    const notFoundRes = await app.inject({
      method: 'GET',
      url: '/v1/videos/00000000-0000-7000-8000-000000000000/comments',
    });
    expect(notFoundRes.statusCode).toBe(404);
    expect(notFoundRes.headers['content-type']).toContain('application/problem+json');
    expect(validateProblem(notFoundRes.json())).toBe(true);

    // 400 Self subscription
    const selfSubRes = await app.inject({
      method: 'PUT',
      url: `/v1/channels/${authorId}/subscription`,
      headers: { 'x-user-id': authorId },
    });
    expect(selfSubRes.statusCode).toBe(400);
    expect(validateProblem(selfSubRes.json())).toBe(true);
  });

  it('Validates UUID format and returns 400 or 404 according to contract', async () => {
    const invalidId = 'not-a-valid-uuid';

    // Routes declaring 400: return 400 INVALID_ID
    const getCommentsRes = await app.inject({
      method: 'GET',
      url: `/v1/videos/${invalidId}/comments`,
    });
    expect(getCommentsRes.statusCode).toBe(400);
    expect(getCommentsRes.json().code).toBe('INVALID_ID');

    const postCommentRes = await app.inject({
      method: 'POST',
      url: `/v1/videos/${invalidId}/comments`,
      headers: { 'x-user-id': authorId },
      payload: { body: 'test' },
    });
    expect(postCommentRes.statusCode).toBe(400);
    expect(postCommentRes.json().code).toBe('INVALID_ID');

    const patchCommentRes = await app.inject({
      method: 'PATCH',
      url: `/v1/comments/${invalidId}`,
      headers: { 'x-user-id': authorId },
      payload: { body: 'edited' },
    });
    expect(patchCommentRes.statusCode).toBe(400);
    expect(patchCommentRes.json().code).toBe('INVALID_ID');

    const getRepliesRes = await app.inject({
      method: 'GET',
      url: `/v1/comments/${invalidId}/replies`,
    });
    expect(getRepliesRes.statusCode).toBe(400);
    expect(getRepliesRes.json().code).toBe('INVALID_ID');

    const putModRes = await app.inject({
      method: 'PUT',
      url: `/v1/comments/${invalidId}/moderation`,
      headers: { 'x-user-id': authorId, 'x-user-roles': 'moderator' },
      payload: { status: 'HIDDEN' },
    });
    expect(putModRes.statusCode).toBe(400);
    expect(putModRes.json().code).toBe('INVALID_ID');

    const getSubRes = await app.inject({
      method: 'GET',
      url: `/v1/channels/${invalidId}/subscription`,
    });
    expect(getSubRes.statusCode).toBe(400);
    expect(getSubRes.json().code).toBe('INVALID_ID');

    const putSubRes = await app.inject({
      method: 'PUT',
      url: `/v1/channels/${invalidId}/subscription`,
      headers: { 'x-user-id': authorId },
    });
    expect(putSubRes.statusCode).toBe(400);
    expect(putSubRes.json().code).toBe('INVALID_ID');

    // Routes declaring only 404: return 404
    const getCommentRes = await app.inject({
      method: 'GET',
      url: `/v1/comments/${invalidId}`,
    });
    expect(getCommentRes.statusCode).toBe(404);

    const deleteCommentRes = await app.inject({
      method: 'DELETE',
      url: `/v1/comments/${invalidId}`,
      headers: { 'x-user-id': authorId },
    });
    expect(deleteCommentRes.statusCode).toBe(404);

    const getLikeRes = await app.inject({
      method: 'GET',
      url: `/v1/videos/${invalidId}/like`,
    });
    expect(getLikeRes.statusCode).toBe(404);

    const putLikeRes = await app.inject({
      method: 'PUT',
      url: `/v1/videos/${invalidId}/like`,
      headers: { 'x-user-id': authorId },
    });
    expect(putLikeRes.statusCode).toBe(404);

    const deleteLikeRes = await app.inject({
      method: 'DELETE',
      url: `/v1/videos/${invalidId}/like`,
      headers: { 'x-user-id': authorId },
    });
    expect(deleteLikeRes.statusCode).toBe(404);

    // DELETE channel subscription returns 200 for invalid/non-existent channel
    const delSubRes = await app.inject({
      method: 'DELETE',
      url: `/v1/channels/${invalidId}/subscription`,
      headers: { 'x-user-id': authorId },
    });
    expect(delSubRes.statusCode).toBe(200);
    expect(delSubRes.json().channel_id).toBe(invalidId);
    expect(delSubRes.json().subscribed).toBe(false);

    // Invalid X-User-Id header returns 401
    const invalidAuthRes = await app.inject({
      method: 'GET',
      url: `/v1/videos/${videoId}/comments`,
      headers: { 'x-user-id': 'invalid-user-uuid' },
    });
    expect(invalidAuthRes.statusCode).toBe(401);
    expect(invalidAuthRes.json().code).toBe('UNAUTHORIZED');

    // Invalid cursor returns 400 INVALID_CURSOR
    const invalidCursorRes = await app.inject({
      method: 'GET',
      url: `/v1/videos/${videoId}/comments?cursor=not-valid-base64-json`,
    });
    expect(invalidCursorRes.statusCode).toBe(400);
    expect(invalidCursorRes.json().code).toBe('INVALID_CURSOR');

    const invalidSubCursorRes = await app.inject({
      method: 'GET',
      url: `/v1/me/subscriptions?cursor=not-valid-base64-json`,
      headers: { 'x-user-id': authorId },
    });
    expect(invalidSubCursorRes.statusCode).toBe(400);
    expect(invalidSubCursorRes.json().code).toBe('INVALID_CURSOR');
  });
});
