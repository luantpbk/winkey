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

    // Regression: Multi-user subscription isolation with limit=1
    await app.inject({
      method: 'PUT',
      url: `/v1/channels/${channelId}/subscription`,
      headers: { 'x-user-id': authorId },
    });
    await app.inject({
      method: 'PUT',
      url: `/v1/channels/${ownerId}/subscription`,
      headers: { 'x-user-id': strangerId },
    });

    const authorSubsIsolated = await app.inject({
      method: 'GET',
      url: '/v1/me/subscriptions?limit=1',
      headers: { 'x-user-id': authorId },
    });
    expect(authorSubsIsolated.statusCode).toBe(200);
    expect(authorSubsIsolated.json().items).toHaveLength(1);
    expect(authorSubsIsolated.json().items[0].channel.id).toBe(channelId);

    const strangerSubsIsolated = await app.inject({
      method: 'GET',
      url: '/v1/me/subscriptions?limit=1',
      headers: { 'x-user-id': strangerId },
    });
    expect(strangerSubsIsolated.statusCode).toBe(200);
    expect(strangerSubsIsolated.json().items).toHaveLength(1);
    expect(strangerSubsIsolated.json().items[0].channel.id).toBe(ownerId);
  });

  it('Reports target validation, self-reporting rules, and 20/hr rate limit', async () => {
    const freshUserId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9888';
    mockStore.public_profiles.push({
      id: freshUserId,
      handle: 'fresh_reporter',
      display_name: 'Fresh Reporter',
      avatar_key: null,
    });

    // 1. Target not found
    const missingVideoRes = await app.inject({
      method: 'POST',
      url: '/v1/reports',
      headers: { 'x-user-id': freshUserId },
      payload: {
        target_type: 'VIDEO',
        target_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9991',
        reason: 'SPAM',
      },
    });
    expect(missingVideoRes.statusCode).toBe(404);
    expect(missingVideoRes.json().code).toBe('TARGET_NOT_FOUND');

    const missingUserRes = await app.inject({
      method: 'POST',
      url: '/v1/reports',
      headers: { 'x-user-id': freshUserId },
      payload: {
        target_type: 'USER',
        target_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9992',
        reason: 'SPAM',
      },
    });
    expect(missingUserRes.statusCode).toBe(404);
    expect(missingUserRes.json().code).toBe('TARGET_NOT_FOUND');

    // 2. Self-reporting rules
    // Video owner cannot report their own video
    const ownVideoRes = await app.inject({
      method: 'POST',
      url: '/v1/reports',
      headers: { 'x-user-id': ownerId },
      payload: { target_type: 'VIDEO', target_id: videoId, reason: 'SPAM' },
    });
    expect(ownVideoRes.statusCode).toBe(400);
    expect(ownVideoRes.json().code).toBe('CANNOT_REPORT_OWN_CONTENT');

    // Author cannot report their own comment
    const commentRes = await app.inject({
      method: 'POST',
      url: `/v1/videos/${videoId}/comments`,
      headers: { 'x-user-id': authorId },
      payload: { body: 'Test comment to be reported' },
    });
    const createdCommentId = commentRes.json().id;

    const ownCommentRes = await app.inject({
      method: 'POST',
      url: '/v1/reports',
      headers: { 'x-user-id': authorId },
      payload: { target_type: 'COMMENT', target_id: createdCommentId, reason: 'SPAM' },
    });
    expect(ownCommentRes.statusCode).toBe(400);
    expect(ownCommentRes.json().code).toBe('CANNOT_REPORT_OWN_CONTENT');

    // User cannot report self
    const selfUserRes = await app.inject({
      method: 'POST',
      url: '/v1/reports',
      headers: { 'x-user-id': freshUserId },
      payload: { target_type: 'USER', target_id: freshUserId, reason: 'SPAM' },
    });
    expect(selfUserRes.statusCode).toBe(400);
    expect(selfUserRes.json().code).toBe('CANNOT_REPORT_SELF');

    // 3. Rate limiting: 20 per hour
    // Perform reports up to limit
    const targetUserId = strangerId;
    for (let i = 0; i < 17; i++) {
      // already consumed 3 in above checks for freshUserId
      await app.inject({
        method: 'POST',
        url: '/v1/reports',
        headers: { 'x-user-id': freshUserId },
        payload: { target_type: 'USER', target_id: targetUserId, reason: 'SPAM' },
      });
    }

    // 21st request hits 429
    const limitedRes = await app.inject({
      method: 'POST',
      url: '/v1/reports',
      headers: { 'x-user-id': freshUserId },
      payload: { target_type: 'USER', target_id: targetUserId, reason: 'SPAM' },
    });
    expect(limitedRes.statusCode).toBe(429);
    expect(limitedRes.json().code).toBe('RATE_LIMIT_EXCEEDED');
  });

  it('Hidden video enforces 404 for viewers and allows access for moderators/admins', async () => {
    const hiddenVideoId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9777';
    mockStore.videos.push({
      id: hiddenVideoId,
      owner_id: ownerId,
      like_count: 5,
      comment_count: 2,
      hidden: true,
      created_at: new Date(),
    });

    const hiddenCommentId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9778';
    mockStore.comments.push({
      id: hiddenCommentId,
      video_id: hiddenVideoId,
      author_id: authorId,
      parent_id: null,
      body: 'Comment on hidden video',
      status: 'VISIBLE',
      reply_count: 0,
      created_at: new Date(),
      edited_at: null,
      updated_at: new Date(),
    });

    const viewerHeaders = { 'x-user-id': authorId, 'x-user-roles': 'viewer' };
    const modHeaders = { 'x-user-id': strangerId, 'x-user-roles': 'moderator' };

    // Viewer gets 404 on comment endpoints
    const getCommentsRes = await app.inject({
      method: 'GET',
      url: `/v1/videos/${hiddenVideoId}/comments`,
      headers: viewerHeaders,
    });
    expect(getCommentsRes.statusCode).toBe(404);

    const postCommentRes = await app.inject({
      method: 'POST',
      url: `/v1/videos/${hiddenVideoId}/comments`,
      headers: viewerHeaders,
      payload: { body: 'Cannot comment on hidden video' },
    });
    expect(postCommentRes.statusCode).toBe(404);

    // Viewer gets 404 on like endpoints
    const getLikeRes = await app.inject({
      method: 'GET',
      url: `/v1/videos/${hiddenVideoId}/like`,
      headers: viewerHeaders,
    });
    expect(getLikeRes.statusCode).toBe(404);

    const putLikeRes = await app.inject({
      method: 'PUT',
      url: `/v1/videos/${hiddenVideoId}/like`,
      headers: viewerHeaders,
    });
    expect(putLikeRes.statusCode).toBe(404);

    const delLikeRes = await app.inject({
      method: 'DELETE',
      url: `/v1/videos/${hiddenVideoId}/like`,
      headers: viewerHeaders,
    });
    expect(delLikeRes.statusCode).toBe(404);

    // Viewer gets 404 when reporting hidden video or comment on hidden video
    const reportVideoRes = await app.inject({
      method: 'POST',
      url: '/v1/reports',
      headers: viewerHeaders,
      payload: { target_type: 'VIDEO', target_id: hiddenVideoId, reason: 'SPAM' },
    });
    expect(reportVideoRes.statusCode).toBe(404);

    const reportCommentRes = await app.inject({
      method: 'POST',
      url: '/v1/reports',
      headers: viewerHeaders,
      payload: { target_type: 'COMMENT', target_id: hiddenCommentId, reason: 'SPAM' },
    });
    expect(reportCommentRes.statusCode).toBe(404);

    // Moderator gets 200 on hidden video comment endpoints
    const modGetComments = await app.inject({
      method: 'GET',
      url: `/v1/videos/${hiddenVideoId}/comments`,
      headers: modHeaders,
    });
    expect(modGetComments.statusCode).toBe(200);

    // Moderator gets 200 on hidden video like endpoint
    const modGetLike = await app.inject({
      method: 'GET',
      url: `/v1/videos/${hiddenVideoId}/like`,
      headers: modHeaders,
    });
    expect(modGetLike.statusCode).toBe(200);

    // Moderator CAN report hidden video
    const modReportVideo = await app.inject({
      method: 'POST',
      url: '/v1/reports',
      headers: modHeaders,
      payload: { target_type: 'VIDEO', target_id: hiddenVideoId, reason: 'VIOLENCE' },
    });
    expect(modReportVideo.statusCode).toBe(201);
  });

  it('Task C4: PRIVATE video restricts comments/likes to owner, moderators, admins; UNLISTED behaves like PUBLIC; visibility changes reopen', async () => {
    const privVideoId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9880';
    mockStore.videos.push({
      id: privVideoId,
      owner_id: ownerId,
      like_count: 3,
      comment_count: 1,
      hidden: false,
      visibility: 'PRIVATE',
      created_at: new Date(),
    });

    const privCommentId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9881';
    mockStore.comments.push({
      id: privCommentId,
      video_id: privVideoId,
      author_id: ownerId,
      parent_id: null,
      body: 'Owner comment on private video',
      status: 'VISIBLE',
      reply_count: 0,
      created_at: new Date(),
      edited_at: null,
      updated_at: new Date(),
    });

    const outsiderHeaders = { 'x-user-id': strangerId, 'x-user-roles': 'viewer' };
    const ownerHeaders = { 'x-user-id': ownerId, 'x-user-roles': 'viewer' };
    const modHeaders = { 'x-user-id': authorId, 'x-user-roles': 'moderator' };
    const adminHeaders = { 'x-user-id': authorId, 'x-user-roles': 'admin' };

    // 1. Outsider gets 404 on PRIVATE video endpoints
    const outCommentsRes = await app.inject({
      method: 'GET',
      url: `/v1/videos/${privVideoId}/comments`,
      headers: outsiderHeaders,
    });
    expect(outCommentsRes.statusCode).toBe(404);

    const outPostRes = await app.inject({
      method: 'POST',
      url: `/v1/videos/${privVideoId}/comments`,
      headers: outsiderHeaders,
      payload: { body: 'Outsider comment attempt' },
    });
    expect(outPostRes.statusCode).toBe(404);

    const outGetSingleComment = await app.inject({
      method: 'GET',
      url: `/v1/comments/${privCommentId}`,
      headers: outsiderHeaders,
    });
    expect(outGetSingleComment.statusCode).toBe(404);

    const outGetLike = await app.inject({
      method: 'GET',
      url: `/v1/videos/${privVideoId}/like`,
      headers: outsiderHeaders,
    });
    expect(outGetLike.statusCode).toBe(404);

    const outPutLike = await app.inject({
      method: 'PUT',
      url: `/v1/videos/${privVideoId}/like`,
      headers: outsiderHeaders,
    });
    expect(outPutLike.statusCode).toBe(404);

    const outDelLike = await app.inject({
      method: 'DELETE',
      url: `/v1/videos/${privVideoId}/like`,
      headers: outsiderHeaders,
    });
    expect(outDelLike.statusCode).toBe(404);

    // 2. Owner has full access to their PRIVATE video
    const ownerCommentsRes = await app.inject({
      method: 'GET',
      url: `/v1/videos/${privVideoId}/comments`,
      headers: ownerHeaders,
    });
    expect(ownerCommentsRes.statusCode).toBe(200);

    const ownerLikeRes = await app.inject({
      method: 'GET',
      url: `/v1/videos/${privVideoId}/like`,
      headers: ownerHeaders,
    });
    expect(ownerLikeRes.statusCode).toBe(200);

    // 3. Moderator has access to PRIVATE video
    const modCommentsRes = await app.inject({
      method: 'GET',
      url: `/v1/videos/${privVideoId}/comments`,
      headers: modHeaders,
    });
    expect(modCommentsRes.statusCode).toBe(200);

    // 4. Admin has access to PRIVATE video
    const adminCommentsRes = await app.inject({
      method: 'GET',
      url: `/v1/videos/${privVideoId}/comments`,
      headers: adminHeaders,
    });
    expect(adminCommentsRes.statusCode).toBe(200);

    // 5. UNLISTED video behaves like PUBLIC (outsider can access)
    const unlistedVideoId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9882';
    mockStore.videos.push({
      id: unlistedVideoId,
      owner_id: ownerId,
      like_count: 0,
      comment_count: 0,
      hidden: false,
      visibility: 'UNLISTED',
      created_at: new Date(),
    });

    const unlistedCommentsRes = await app.inject({
      method: 'GET',
      url: `/v1/videos/${unlistedVideoId}/comments`,
      headers: outsiderHeaders,
    });
    expect(unlistedCommentsRes.statusCode).toBe(200);

    const unlistedLikeRes = await app.inject({
      method: 'GET',
      url: `/v1/videos/${unlistedVideoId}/like`,
      headers: outsiderHeaders,
    });
    expect(unlistedLikeRes.statusCode).toBe(200);

    // 6. Visibility changes from PRIVATE to PUBLIC: reopens video for outsider
    const video = mockStore.videos.find((v) => v.id === privVideoId)!;
    video.visibility = 'PUBLIC';

    const reopenedCommentsRes = await app.inject({
      method: 'GET',
      url: `/v1/videos/${privVideoId}/comments`,
      headers: outsiderHeaders,
    });
    expect(reopenedCommentsRes.statusCode).toBe(200);
  });
});
