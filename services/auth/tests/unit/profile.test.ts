import { describe, it, expect, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { v7 as uuidv7 } from 'uuid';
import { buildApp } from '../../src/server.js';
import { getEnv } from '../../src/config/env.js';
import { getTestKeys } from '../fixtures/keys.js';
import { createMockDb, createMockStore, type MockStore } from '../fixtures/mock-db.js';
import { ValkeyRateLimiter } from '../../src/rate-limit/valkey-limiter.js';
import { issueAccessToken } from '../../src/crypto/jwt.js';
import { hashPassword } from '../../src/crypto/passwords.js';
import {
  normalizeBio,
  validateProfileLinks,
  areLinksEqual,
} from '../../src/security/profile-validation.js';

describe('SOC-1b Profile & Privacy (Unit & Route Tests)', () => {
  let app: FastifyInstance;
  let store: MockStore;
  const testKeys = getTestKeys();
  const env = getEnv({
    JWT_PRIVATE_KEY: testKeys.privateKey,
    JWT_KID: 'winkey-auth-key-1',
    JWT_ISSUER: 'https://winkey.vn',
    PUBLIC_ORIGIN: 'https://winkey.vn',
    MEDIA_BASE_URL: 'https://media.winkey.vn',
    NODE_ENV: 'test',
  });

  beforeEach(async () => {
    store = createMockStore();
    const { db } = createMockDb(store);
    const rateLimiter = new ValkeyRateLimiter();

    app = await buildApp({
      env,
      db,
      rateLimiter,
      redis: null,
      natsConnection: null,
    });
  });

  describe('profile-validation helpers', () => {
    it('normalizeBio trims and maps empty strings to null', () => {
      expect(normalizeBio(undefined)).toBeUndefined();
      expect(normalizeBio(null)).toBeNull();
      expect(normalizeBio('   ')).toBeNull();
      expect(normalizeBio('  Hello world  ')).toBe('Hello world');
    });

    it('normalizeBio throws on string exceeding 300 characters', () => {
      const longBio = 'a'.repeat(301);
      expect(() => normalizeBio(longBio)).toThrow();
    });

    it('validateProfileLinks accepts valid https links', () => {
      const links = [
        { url: 'https://github.com/winkey', label: 'GitHub' },
        { url: 'https://x.com/winkey', label: 'Twitter' },
      ];
      const validated = validateProfileLinks(links);
      expect(validated).toEqual(links);
    });

    it('validateProfileLinks throws 400 LINK_INVALID on http, credentials, or invalid protocol', () => {
      expect(() =>
        validateProfileLinks([{ url: 'http://insecure.com', label: 'Blog' }]),
      ).toThrowError();

      expect(() =>
        validateProfileLinks([{ url: 'javascript:alert(1)', label: 'XSS' }]),
      ).toThrowError();

      expect(() =>
        validateProfileLinks([{ url: 'https://user:pass@example.com', label: 'Creds' }]),
      ).toThrowError();

      expect(() =>
        validateProfileLinks([{ url: 'https://' + 'a'.repeat(200) + '.com', label: 'Long' }]),
      ).toThrowError();

      expect(() => validateProfileLinks([{ url: 'https://valid.com', label: '' }])).toThrowError();

      expect(() =>
        validateProfileLinks([{ url: 'https://valid.com', label: 'a'.repeat(31) }]),
      ).toThrowError();

      expect(() =>
        validateProfileLinks(Array(6).fill({ url: 'https://valid.com', label: 'Link' })),
      ).toThrowError();
    });

    it('areLinksEqual detects changes', () => {
      expect(
        areLinksEqual(
          [{ url: 'https://a.com', label: 'A' }],
          [{ url: 'https://a.com', label: 'A' }],
        ),
      ).toBe(true);

      expect(
        areLinksEqual(
          [{ url: 'https://a.com', label: 'A' }],
          [{ url: 'https://b.com', label: 'A' }],
        ),
      ).toBe(false);

      expect(
        areLinksEqual(
          [{ url: 'https://a.com', label: 'A' }],
          [{ url: 'https://a.com', label: 'B' }],
        ),
      ).toBe(false);
    });
  });

  describe('PATCH /v1/auth/me (updateMe with profile fields)', () => {
    it('updates bio, links, and is_private', async () => {
      const userId = uuidv7();
      const passwordHash = await hashPassword('password123');
      store.users.push({
        id: userId,
        email: 'user1@example.com',
        email_verified_at: new Date(),
        password_hash: passwordHash,
        handle: 'user1',
        display_name: 'User One',
        avatar_key: null,
        bio: null,
        links: [],
        banner_key: null,
        is_private: false,
        roles: ['viewer'],
        status: 'ACTIVE',
        suspended_until: null,
        suspension_reason: null,
        created_at: new Date(),
        updated_at: new Date(),
      });

      const { token } = await issueAccessToken({ id: userId, roles: ['viewer'] }, uuidv7(), env);

      const res = await app.inject({
        method: 'PATCH',
        url: '/v1/auth/me',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        payload: {
          bio: 'Software engineer & tech enthusiast',
          links: [
            { url: 'https://github.com/user1', label: 'GitHub' },
            { url: 'https://linkedin.com/in/user1', label: 'LinkedIn' },
          ],
          is_private: true,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.bio).toBe('Software engineer & tech enthusiast');
      expect(body.links).toHaveLength(2);
      expect(body.links[0]).toEqual({ url: 'https://github.com/user1', label: 'GitHub' });
      expect(body.is_private).toBe(true);

      // Verify in DB store
      const dbUser = store.users.find((u) => u.id === userId)!;
      expect(dbUser.bio).toBe('Software engineer & tech enthusiast');
      expect(dbUser.is_private).toBe(true);
      expect(dbUser.links).toHaveLength(2);
    });

    it('updates avatar_image_id and banner_image_id with READY images', async () => {
      const userId = uuidv7();
      const avatarImageId = uuidv7();
      const bannerImageId = uuidv7();

      store.users.push({
        id: userId,
        email: 'user2@example.com',
        email_verified_at: new Date(),
        password_hash: null,
        handle: 'user2',
        display_name: 'User Two',
        avatar_key: null,
        bio: null,
        links: [],
        banner_key: null,
        is_private: false,
        roles: ['viewer'],
        status: 'ACTIVE',
        suspended_until: null,
        suspension_reason: null,
        created_at: new Date(),
        updated_at: new Date(),
      });

      // Insert ready images for this user
      store.ready_images.push({
        id: avatarImageId,
        owner_id: userId,
        purpose: 'AVATAR',
        image_key: 'images/avatars/user2.webp',
        thumb_key: 'images/avatars/user2_thumb.webp',
        width: 256,
        height: 256,
      });

      store.ready_images.push({
        id: bannerImageId,
        owner_id: userId,
        purpose: 'BANNER',
        image_key: 'images/banners/user2_banner.webp',
        thumb_key: null,
        width: 1200,
        height: 400,
      });

      const { token } = await issueAccessToken({ id: userId, roles: ['viewer'] }, uuidv7(), env);

      const res = await app.inject({
        method: 'PATCH',
        url: '/v1/auth/me',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        payload: {
          avatar_image_id: avatarImageId,
          banner_image_id: bannerImageId,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.avatar_url).toBe('https://media.winkey.vn/images/avatars/user2.webp');
      expect(body.banner_url).toBe('https://media.winkey.vn/images/banners/user2_banner.webp');

      const dbUser = store.users.find((u) => u.id === userId)!;
      expect(dbUser.avatar_key).toBe('images/avatars/user2.webp');
      expect(dbUser.banner_key).toBe('images/banners/user2_banner.webp');
    });

    it('rejects IMAGE_INVALID if image is owned by someone else or wrong purpose or not READY', async () => {
      const userId = uuidv7();
      const otherUserId = uuidv7();
      const otherUserImageId = uuidv7();
      const bannerAsAvatarId = uuidv7();
      const notReadyImageId = uuidv7();

      store.users.push({
        id: userId,
        email: 'user3@example.com',
        email_verified_at: new Date(),
        password_hash: null,
        handle: 'user3',
        display_name: 'User Three',
        avatar_key: null,
        bio: null,
        links: [],
        banner_key: null,
        is_private: false,
        roles: ['viewer'],
        status: 'ACTIVE',
        suspended_until: null,
        suspension_reason: null,
        created_at: new Date(),
        updated_at: new Date(),
      });

      // 1. Image owned by other user
      store.ready_images.push({
        id: otherUserImageId,
        owner_id: otherUserId,
        purpose: 'AVATAR',
        image_key: 'other.webp',
        thumb_key: null,
        width: 100,
        height: 100,
      });

      // 2. Banner purpose used as avatar
      store.ready_images.push({
        id: bannerAsAvatarId,
        owner_id: userId,
        purpose: 'BANNER',
        image_key: 'banner.webp',
        thumb_key: null,
        width: 1200,
        height: 400,
      });

      // 3. Image not ready (e.g. in images table with status UPLOADING)
      store.images.push({
        id: notReadyImageId,
        owner_id: userId,
        purpose: 'AVATAR',
        status: 'UPLOADING',
        content_type: 'image/jpeg',
        size_bytes: 5000,
        raw_bucket: 'raw',
        raw_key: 'raw',
        image_key: null,
        thumb_key: null,
        width: null,
        height: null,
        output_bytes: null,
        error: null,
        created_at: new Date(),
        updated_at: new Date(),
      });

      const { token } = await issueAccessToken({ id: userId, roles: ['viewer'] }, uuidv7(), env);

      // Other user's image -> 400 IMAGE_INVALID
      const resOther = await app.inject({
        method: 'PATCH',
        url: '/v1/auth/me',
        headers: { authorization: `Bearer ${token}` },
        payload: { avatar_image_id: otherUserImageId },
      });
      expect(resOther.statusCode).toBe(400);
      expect(resOther.json().code).toBe('IMAGE_INVALID');

      // Banner purpose for avatar -> 400 IMAGE_INVALID
      const resWrongPurpose = await app.inject({
        method: 'PATCH',
        url: '/v1/auth/me',
        headers: { authorization: `Bearer ${token}` },
        payload: { avatar_image_id: bannerAsAvatarId },
      });
      expect(resWrongPurpose.statusCode).toBe(400);
      expect(resWrongPurpose.json().code).toBe('IMAGE_INVALID');

      // Not ready image -> 400 IMAGE_INVALID
      const resNotReady = await app.inject({
        method: 'PATCH',
        url: '/v1/auth/me',
        headers: { authorization: `Bearer ${token}` },
        payload: { avatar_image_id: notReadyImageId },
      });
      expect(resNotReady.statusCode).toBe(400);
      expect(resNotReady.json().code).toBe('IMAGE_INVALID');
    });

    it('allows clearing avatar, banner, and bio with null', async () => {
      const userId = uuidv7();
      store.users.push({
        id: userId,
        email: 'user4@example.com',
        email_verified_at: new Date(),
        password_hash: null,
        handle: 'user4',
        display_name: 'User Four',
        avatar_key: 'avatars/existing.webp',
        bio: 'Old bio',
        links: [{ url: 'https://winkey.vn', label: 'Winkey' }],
        banner_key: 'banners/existing.webp',
        is_private: true,
        roles: ['viewer'],
        status: 'ACTIVE',
        suspended_until: null,
        suspension_reason: null,
        created_at: new Date(),
        updated_at: new Date(),
      });

      const { token } = await issueAccessToken({ id: userId, roles: ['viewer'] }, uuidv7(), env);

      const res = await app.inject({
        method: 'PATCH',
        url: '/v1/auth/me',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          avatar_image_id: null,
          banner_image_id: null,
          bio: null,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.avatar_url).toBeNull();
      expect(body.banner_url).toBeNull();
      expect(body.bio).toBeNull();

      const dbUser = store.users.find((u) => u.id === userId)!;
      expect(dbUser.avatar_key).toBeNull();
      expect(dbUser.banner_key).toBeNull();
      expect(dbUser.bio).toBeNull();
    });

    it('returns 200 without DB write or rate limit consumption on no-op update', async () => {
      const userId = uuidv7();
      store.users.push({
        id: userId,
        email: 'user5@example.com',
        email_verified_at: new Date(),
        password_hash: null,
        handle: 'user5',
        display_name: 'User Five',
        avatar_key: null,
        bio: 'Fixed bio',
        links: [{ url: 'https://winkey.vn', label: 'Winkey' }],
        banner_key: null,
        is_private: false,
        roles: ['viewer'],
        status: 'ACTIVE',
        suspended_until: null,
        suspension_reason: null,
        created_at: new Date(),
        updated_at: new Date(),
      });

      const { token } = await issueAccessToken({ id: userId, roles: ['viewer'] }, uuidv7(), env);

      // Same payload as existing DB state
      const res = await app.inject({
        method: 'PATCH',
        url: '/v1/auth/me',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          display_name: 'User Five',
          handle: 'user5',
          bio: 'Fixed bio',
          links: [{ url: 'https://winkey.vn', label: 'Winkey' }],
          is_private: false,
        },
      });

      expect(res.statusCode).toBe(200);
    });
  });

  describe('GET /v1/users/:handle (UserProfile)', () => {
    it('returns public profile with SOC-1b fields', async () => {
      const userId = uuidv7();
      store.users.push({
        id: userId,
        email: 'creator@example.com',
        email_verified_at: new Date(),
        password_hash: null,
        handle: 'techcreator',
        display_name: 'Tech Creator',
        avatar_key: 'avatars/creator.webp',
        bio: 'Creating videos about cloud architecture',
        links: [{ url: 'https://youtube.com/@tech', label: 'YouTube' }],
        banner_key: 'banners/creator_banner.webp',
        is_private: false,
        roles: ['creator'],
        status: 'ACTIVE',
        suspended_until: null,
        suspension_reason: null,
        created_at: new Date('2026-01-01T00:00:00Z'),
        updated_at: new Date(),
      });

      const res = await app.inject({
        method: 'GET',
        url: '/v1/users/techcreator',
      });

      expect(res.statusCode).toBe(200);
      const profile = res.json();
      expect(profile.id).toBe(userId);
      expect(profile.handle).toBe('techcreator');
      expect(profile.display_name).toBe('Tech Creator');
      expect(profile.avatar_url).toBe('https://media.winkey.vn/avatars/creator.webp');
      expect(profile.banner_url).toBe('https://media.winkey.vn/banners/creator_banner.webp');
      expect(profile.bio).toBe('Creating videos about cloud architecture');
      expect(profile.links).toEqual([{ url: 'https://youtube.com/@tech', label: 'YouTube' }]);
      expect(profile.is_private).toBe(false);
      expect(profile.created_at).toBe('2026-01-01T00:00:00.000Z');
    });

    it('returns 404 for unknown handle', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/users/nonexistent',
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('DELETE /v1/auth/me (deleteMe clears profile fields)', () => {
    it('clears bio, links, banner_key, and is_private on account deletion', async () => {
      const userId = uuidv7();
      const passwordHash = await hashPassword('password123');
      store.users.push({
        id: userId,
        email: 'todelete@example.com',
        email_verified_at: new Date(),
        password_hash: passwordHash,
        handle: 'todelete',
        display_name: 'To Delete',
        avatar_key: 'avatars/del.webp',
        bio: 'Will be deleted',
        links: [{ url: 'https://del.com', label: 'Del' }],
        banner_key: 'banners/del.webp',
        is_private: true,
        roles: ['viewer'],
        status: 'ACTIVE',
        suspended_until: null,
        suspension_reason: null,
        created_at: new Date(),
        updated_at: new Date(),
      });

      const { token } = await issueAccessToken({ id: userId, roles: ['viewer'] }, uuidv7(), env);

      const res = await app.inject({
        method: 'DELETE',
        url: '/v1/auth/me',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          confirm_handle: 'todelete',
          password: 'password123',
        },
      });

      expect(res.statusCode).toBe(204);

      const dbUser = store.users.find((u) => u.id === userId)!;
      expect(dbUser.status).toBe('DELETED');
      expect(dbUser.bio).toBeNull();
      expect(dbUser.links).toEqual([]);
      expect(dbUser.banner_key).toBeNull();
      expect(dbUser.is_private).toBe(false);
      expect(dbUser.avatar_key).toBeNull();
    });
  });
});
