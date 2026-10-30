import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'kysely';
import type { Database } from '../db/types.js';
import type { Kysely } from 'kysely';
import { ProblemError } from '../errors/problem.js';
import { requireAuth, isValidUuid } from '../utils/auth.js';
import {
  verifyDeviceRegistrationSignature,
  verifySignedKeySignature,
} from '../crypto/canonical-ed25519.js';
import type { RealtimeHintDispatcher } from '../realtime/hints.js';

export interface DevicesRouteDependencies {
  db: Kysely<Database>;
  hints: RealtimeHintDispatcher;
}

export const devicesRoute: FastifyPluginAsync<DevicesRouteDependencies> = async (
  fastify,
  { db, hints },
) => {
  // 1. GET /v1/chat/devices - The caller's active devices (newest first)
  fastify.get('/v1/chat/devices', async (request, reply) => {
    const caller = requireAuth(request);

    const devices = await db
      .selectFrom('chat.devices')
      .selectAll()
      .where('user_id', '=', caller.userId)
      .where('deleted_at', 'is', null)
      .orderBy('created_at', 'desc')
      .execute();

    const items = devices.map((d) => ({
      id: d.id,
      display_name: d.display_name,
      curve25519_key: d.curve25519_key,
      ed25519_key: d.ed25519_key,
      created_at: new Date(d.created_at).toISOString(),
      last_seen_at: new Date(d.last_seen_at).toISOString(),
    }));

    return reply.status(200).send({ items });
  });

  // 2. PUT /v1/chat/devices/:device_id - Register or update own device
  fastify.put<{
    Params: { device_id: string };
    Body: {
      display_name: string;
      curve25519_key: string;
      ed25519_key: string;
      signature: string;
      fallback_key?: {
        key_id: string;
        public_key: string;
        signature: string;
      };
    };
  }>('/v1/chat/devices/:device_id', async (request, reply) => {
    const caller = requireAuth(request);
    const { device_id } = request.params;

    if (!isValidUuid(device_id)) {
      throw ProblemError.badRequest('Invalid device ID format', 'INVALID_DEVICE_ID');
    }

    const { display_name, curve25519_key, ed25519_key, signature, fallback_key } =
      request.body || {};

    if (
      !display_name ||
      typeof display_name !== 'string' ||
      display_name.trim().length === 0 ||
      display_name.length > 64
    ) {
      throw ProblemError.badRequest(
        'display_name must be between 1 and 64 characters',
        'INVALID_DISPLAY_NAME',
      );
    }
    if (!curve25519_key || typeof curve25519_key !== 'string' || curve25519_key.length !== 43) {
      throw ProblemError.badRequest(
        'curve25519_key must be 43-character unpadded base64',
        'INVALID_KEY',
      );
    }
    if (!ed25519_key || typeof ed25519_key !== 'string' || ed25519_key.length !== 43) {
      throw ProblemError.badRequest(
        'ed25519_key must be 43-character unpadded base64',
        'INVALID_KEY',
      );
    }
    if (!signature || typeof signature !== 'string' || signature.length !== 86) {
      throw ProblemError.badRequest(
        'signature must be 86-character unpadded base64',
        'INVALID_SIGNATURE',
      );
    }

    // Verify device registration signature
    const validDeviceSig = verifyDeviceRegistrationSignature(
      device_id,
      caller.userId,
      curve25519_key,
      ed25519_key,
      signature,
    );
    if (!validDeviceSig) {
      throw ProblemError.badRequest('Invalid device registration signature', 'INVALID_SIGNATURE');
    }

    // Verify fallback key signature if present
    if (fallback_key) {
      if (
        !fallback_key.key_id ||
        typeof fallback_key.key_id !== 'string' ||
        fallback_key.key_id.length > 64
      ) {
        throw ProblemError.badRequest('Invalid fallback key_id', 'INVALID_FALLBACK_KEY');
      }
      if (
        !fallback_key.public_key ||
        typeof fallback_key.public_key !== 'string' ||
        fallback_key.public_key.length !== 43
      ) {
        throw ProblemError.badRequest('Invalid fallback public_key', 'INVALID_FALLBACK_KEY');
      }
      if (
        !fallback_key.signature ||
        typeof fallback_key.signature !== 'string' ||
        fallback_key.signature.length !== 86
      ) {
        throw ProblemError.badRequest('Invalid fallback signature', 'INVALID_FALLBACK_KEY');
      }

      const validFallbackSig = verifySignedKeySignature(
        device_id,
        fallback_key.key_id,
        fallback_key.public_key,
        fallback_key.signature,
        ed25519_key,
        true,
      );
      if (!validFallbackSig) {
        throw ProblemError.badRequest('Invalid fallback key signature', 'INVALID_SIGNATURE');
      }
    }

    let isNewRegistration = false;
    let registeredDevice: {
      id: string;
      display_name: string;
      curve25519_key: string;
      ed25519_key: string;
      created_at: Date;
      last_seen_at: Date;
    };
    let sharedUserIds: string[] = [];

    await db.transaction().execute(async (trx) => {
      // Per-user advisory lock to strictly serialize device operations
      await sql`SELECT pg_advisory_xact_lock(hashtext('chat-dev:' || ${caller.userId}::text))`.execute(
        trx,
      );

      const existingDevice = await trx
        .selectFrom('chat.devices')
        .selectAll()
        .where('id', '=', device_id)
        .executeTakeFirst();

      if (existingDevice) {
        if (existingDevice.user_id !== caller.userId || existingDevice.deleted_at !== null) {
          throw ProblemError.conflict(
            'Device ID is in use or was previously removed',
            'DEVICE_ID_IN_USE',
          );
        }
        if (
          existingDevice.curve25519_key !== curve25519_key ||
          existingDevice.ed25519_key !== ed25519_key
        ) {
          throw ProblemError.conflict(
            'Device cryptographic keys are immutable',
            'DEVICE_KEYS_IMMUTABLE',
          );
        }

        // Update display name and fallback key
        const updated = await trx
          .updateTable('chat.devices')
          .set({
            display_name: display_name.trim(),
            fallback_key_id: fallback_key ? fallback_key.key_id : existingDevice.fallback_key_id,
            fallback_key: fallback_key ? fallback_key.public_key : existingDevice.fallback_key,
            fallback_signature: fallback_key
              ? fallback_key.signature
              : existingDevice.fallback_signature,
            last_seen_at: new Date(),
          })
          .where('id', '=', device_id)
          .returningAll()
          .executeTakeFirstOrThrow();

        registeredDevice = {
          id: updated.id,
          display_name: updated.display_name,
          curve25519_key: updated.curve25519_key,
          ed25519_key: updated.ed25519_key,
          created_at: new Date(updated.created_at),
          last_seen_at: new Date(updated.last_seen_at),
        };
      } else {
        // New registration: check active device limit (max 10)
        const countRes = await trx
          .selectFrom('chat.devices')
          .select(sql<string>`count(*)`.as('count'))
          .where('user_id', '=', caller.userId)
          .where('deleted_at', 'is', null)
          .executeTakeFirstOrThrow();

        if (Number(countRes.count) >= 10) {
          throw ProblemError.conflict(
            'Maximum 10 active devices allowed per user',
            'TOO_MANY_DEVICES',
          );
        }

        // Check identity key uniqueness across all devices
        const keyInUse = await trx
          .selectFrom('chat.devices')
          .select('id')
          .where('curve25519_key', '=', curve25519_key)
          .executeTakeFirst();

        if (keyInUse) {
          throw ProblemError.conflict('Identity key already in use', 'IDENTITY_KEY_IN_USE');
        }

        try {
          const inserted = await trx
            .insertInto('chat.devices')
            .values({
              id: device_id,
              user_id: caller.userId,
              display_name: display_name.trim(),
              curve25519_key,
              ed25519_key,
              signature,
              fallback_key_id: fallback_key ? fallback_key.key_id : null,
              fallback_key: fallback_key ? fallback_key.public_key : null,
              fallback_signature: fallback_key ? fallback_key.signature : null,
            })
            .returningAll()
            .executeTakeFirstOrThrow();

          isNewRegistration = true;
          registeredDevice = {
            id: inserted.id,
            display_name: inserted.display_name,
            curve25519_key: inserted.curve25519_key,
            ed25519_key: inserted.ed25519_key,
            created_at: new Date(inserted.created_at),
            last_seen_at: new Date(inserted.last_seen_at),
          };
        } catch (err: unknown) {
          const pgErr = err as { code?: string; constraint?: string };
          if (pgErr.code === '23505' && pgErr.constraint === 'devices_curve25519') {
            throw ProblemError.conflict('Identity key already in use', 'IDENTITY_KEY_IN_USE');
          }
          if (pgErr.code === '23505') {
            throw ProblemError.conflict('Device ID is already in use', 'DEVICE_ID_IN_USE');
          }
          throw err;
        }

        // Find users sharing active or requested conversations with caller
        const sharedUsersRes = await sql<{ user_id: string }>`
          SELECT DISTINCT m2.user_id
          FROM chat.members m1
          JOIN chat.members m2 ON m2.conversation_id = m1.conversation_id
          WHERE m1.user_id = ${caller.userId}::uuid
            AND m1.state IN ('ACTIVE', 'REQUESTED')
            AND m2.user_id != ${caller.userId}::uuid
            AND m2.state IN ('ACTIVE', 'REQUESTED')
        `.execute(trx);

        sharedUserIds = sharedUsersRes.rows.map((r) => r.user_id);
      }
    });

    if (isNewRegistration) {
      hints.publishHint(caller.userId, { kind: 'DEVICES', user_id: caller.userId });
      for (const uid of sharedUserIds) {
        hints.publishHint(uid, { kind: 'DEVICES', user_id: caller.userId });
      }
    }

    const statusCode = isNewRegistration ? 201 : 200;
    return reply.status(statusCode).send({
      id: registeredDevice!.id,
      display_name: registeredDevice!.display_name,
      curve25519_key: registeredDevice!.curve25519_key,
      ed25519_key: registeredDevice!.ed25519_key,
      created_at: registeredDevice!.created_at.toISOString(),
      last_seen_at: registeredDevice!.last_seen_at.toISOString(),
    });
  });

  // 3. DELETE /v1/chat/devices/:device_id - Remove own device
  fastify.delete<{ Params: { device_id: string } }>(
    '/v1/chat/devices/:device_id',
    async (request, reply) => {
      const caller = requireAuth(request);
      const { device_id } = request.params;

      if (!isValidUuid(device_id)) {
        throw ProblemError.badRequest('Invalid device ID format', 'INVALID_DEVICE_ID');
      }

      let sharedUserIds: string[] = [];
      let wasActive = false;

      await db.transaction().execute(async (trx) => {
        const dev = await trx
          .selectFrom('chat.devices')
          .selectAll()
          .where('id', '=', device_id)
          .where('user_id', '=', caller.userId)
          .executeTakeFirst();

        if (!dev) {
          throw ProblemError.notFound('Device not found', 'DEVICE_NOT_FOUND');
        }

        if (dev.deleted_at !== null) {
          // Already deleted (idempotent)
          return;
        }

        wasActive = true;
        await trx
          .updateTable('chat.devices')
          .set({ deleted_at: new Date() })
          .where('id', '=', device_id)
          .execute();

        await trx.deleteFrom('chat.one_time_keys').where('device_id', '=', device_id).execute();

        await trx
          .deleteFrom('chat.to_device')
          .where('recipient_device_id', '=', device_id)
          .execute();

        const sharedUsersRes = await sql<{ user_id: string }>`
        SELECT DISTINCT m2.user_id
        FROM chat.members m1
        JOIN chat.members m2 ON m2.conversation_id = m1.conversation_id
        WHERE m1.user_id = ${caller.userId}::uuid
          AND m1.state IN ('ACTIVE', 'REQUESTED')
          AND m2.user_id != ${caller.userId}::uuid
          AND m2.state IN ('ACTIVE', 'REQUESTED')
      `.execute(trx);

        sharedUserIds = sharedUsersRes.rows.map((r) => r.user_id);
      });

      if (wasActive) {
        hints.publishHint(caller.userId, { kind: 'DEVICES', user_id: caller.userId });
        for (const uid of sharedUserIds) {
          hints.publishHint(uid, { kind: 'DEVICES', user_id: caller.userId });
        }
      }

      return reply.status(204).send();
    },
  );

  // 4. POST /v1/chat/devices/:device_id/one-time-keys - Upload signed OTKs
  fastify.post<{
    Params: { device_id: string };
    Body: {
      keys: Array<{
        key_id: string;
        public_key: string;
        signature: string;
      }>;
    };
  }>('/v1/chat/devices/:device_id/one-time-keys', async (request, reply) => {
    const caller = requireAuth(request);
    const { device_id } = request.params;

    if (!isValidUuid(device_id)) {
      throw ProblemError.badRequest('Invalid device ID format', 'INVALID_DEVICE_ID');
    }

    const { keys } = request.body || {};
    if (!Array.isArray(keys) || keys.length === 0 || keys.length > 100) {
      throw ProblemError.badRequest('keys must be an array of 1 to 100 items', 'INVALID_KEYS');
    }

    const dev = await db
      .selectFrom('chat.devices')
      .selectAll()
      .where('id', '=', device_id)
      .where('user_id', '=', caller.userId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();

    if (!dev) {
      throw ProblemError.notFound('Active device not found', 'DEVICE_NOT_FOUND');
    }

    // Verify all key signatures
    for (const k of keys) {
      if (!k.key_id || typeof k.key_id !== 'string' || k.key_id.length > 64) {
        throw ProblemError.badRequest('Invalid key_id format', 'INVALID_KEY');
      }
      if (!k.public_key || typeof k.public_key !== 'string' || k.public_key.length !== 43) {
        throw ProblemError.badRequest(
          'public_key must be 43-character unpadded base64',
          'INVALID_KEY',
        );
      }
      if (!k.signature || typeof k.signature !== 'string' || k.signature.length !== 86) {
        throw ProblemError.badRequest(
          'signature must be 86-character unpadded base64',
          'INVALID_KEY',
        );
      }

      const validSig = verifySignedKeySignature(
        device_id,
        k.key_id,
        k.public_key,
        k.signature,
        dev.ed25519_key,
        false,
      );
      if (!validSig) {
        throw ProblemError.badRequest('Invalid one-time key signature', 'INVALID_SIGNATURE');
      }
    }

    let finalCount = 0;
    await db.transaction().execute(async (trx) => {
      const existingRes = await trx
        .selectFrom('chat.one_time_keys')
        .select(sql<string>`count(*)`.as('count'))
        .where('device_id', '=', device_id)
        .executeTakeFirstOrThrow();

      const currentCount = Number(existingRes.count);

      // Find which ones already exist for this device (idempotent ignore)
      const inputKeyIds = [...new Set(keys.map((k) => k.key_id))];
      const existingKeyRows = await trx
        .selectFrom('chat.one_time_keys')
        .select('key_id')
        .where('device_id', '=', device_id)
        .where('key_id', 'in', inputKeyIds)
        .execute();

      const existingSet = new Set(existingKeyRows.map((r) => r.key_id));
      const newKeys = keys.filter((k) => !existingSet.has(k.key_id));

      if (currentCount + newKeys.length > 100) {
        throw ProblemError.conflict(
          'Cannot exceed 100 stored one-time keys per device',
          'TOO_MANY_ONE_TIME_KEYS',
        );
      }

      if (newKeys.length > 0) {
        await trx
          .insertInto('chat.one_time_keys')
          .values(
            newKeys.map((k) => ({
              device_id,
              key_id: k.key_id,
              public_key: k.public_key,
              signature: k.signature,
            })),
          )
          .onConflict((oc) => oc.columns(['device_id', 'key_id']).doNothing())
          .execute();
      }

      const finalCountRes = await trx
        .selectFrom('chat.one_time_keys')
        .select(sql<string>`count(*)`.as('count'))
        .where('device_id', '=', device_id)
        .executeTakeFirstOrThrow();

      finalCount = Number(finalCountRes.count);
    });

    return reply.status(200).send({
      count: finalCount,
      fallback_key_id: dev.fallback_key_id,
    });
  });

  // 5. POST /v1/chat/devices/query - Query active device keys of up to 50 users
  fastify.post<{
    Body: { user_ids: string[] };
  }>('/v1/chat/devices/query', async (request, reply) => {
    const caller = requireAuth(request);
    const { user_ids } = request.body || {};

    if (!Array.isArray(user_ids) || user_ids.length === 0 || user_ids.length > 50) {
      throw ProblemError.badRequest(
        'user_ids must be an array of 1 to 50 items',
        'INVALID_USER_IDS',
      );
    }

    for (const uid of user_ids) {
      if (!isValidUuid(uid)) {
        throw ProblemError.badRequest(`Invalid user ID: ${uid}`, 'INVALID_USER_ID');
      }
    }

    const uniqueUids = [...new Set(user_ids)];

    // Fetch active profiles
    const profiles = await db
      .selectFrom('auth.public_profiles')
      .select('id')
      .where('id', 'in', uniqueUids)
      .execute();
    const activeProfileSet = new Set(profiles.map((p) => p.id));

    // Fetch block relations between caller and queried users
    const blocks = await sql<{ blocked_id: string; blocker_id: string }>`
      SELECT blocker_id, blocked_id
      FROM social.blocks
      WHERE (blocker_id = ${caller.userId}::uuid AND blocked_id = ANY(${uniqueUids}::uuid[]))
         OR (blocker_id = ANY(${uniqueUids}::uuid[]) AND blocked_id = ${caller.userId}::uuid)
    `.execute(db);

    const blockedSet = new Set<string>();
    for (const b of blocks.rows) {
      if (b.blocker_id === caller.userId) blockedSet.add(b.blocked_id);
      if (b.blocked_id === caller.userId) blockedSet.add(b.blocker_id);
    }

    // Determine eligible users
    const eligibleUids = uniqueUids.filter((uid) => {
      if (!activeProfileSet.has(uid)) return false;
      if (uid !== caller.userId && blockedSet.has(uid)) return false;
      return true;
    });

    const resultUsers: Record<
      string,
      Array<{
        id: string;
        user_id: string;
        curve25519_key: string;
        ed25519_key: string;
        signature: string;
        created_at: string;
      }>
    > = {};

    for (const uid of uniqueUids) {
      resultUsers[uid] = [];
    }

    if (eligibleUids.length > 0) {
      const devices = await db
        .selectFrom('chat.devices')
        .select(['id', 'user_id', 'curve25519_key', 'ed25519_key', 'signature', 'created_at'])
        .where('user_id', 'in', eligibleUids)
        .where('deleted_at', 'is', null)
        .orderBy('created_at', 'asc')
        .execute();

      for (const d of devices) {
        if (resultUsers[d.user_id]) {
          resultUsers[d.user_id].push({
            id: d.id,
            user_id: d.user_id,
            curve25519_key: d.curve25519_key,
            ed25519_key: d.ed25519_key,
            signature: d.signature,
            created_at: new Date(d.created_at).toISOString(),
          });
        }
      }
    }

    const userList = uniqueUids.map((uid) => ({
      user_id: uid,
      devices: resultUsers[uid] || [],
    }));

    return reply.status(200).send({ users: userList });
  });

  // 6. POST /v1/chat/keys/claim - Atomic claim one OTK per target device
  fastify.post<{
    Body: { device_ids: string[] };
  }>('/v1/chat/keys/claim', async (request, reply) => {
    const caller = requireAuth(request);
    const { device_ids } = request.body || {};

    if (!Array.isArray(device_ids) || device_ids.length === 0 || device_ids.length > 200) {
      throw ProblemError.badRequest(
        'device_ids must be an array of 1 to 200 items',
        'INVALID_DEVICE_IDS',
      );
    }

    for (const did of device_ids) {
      if (!isValidUuid(did)) {
        throw ProblemError.badRequest(`Invalid device ID: ${did}`, 'INVALID_DEVICE_ID');
      }
    }

    const uniqueDeviceIds = [...new Set(device_ids)];

    // Fetch eligible devices
    const eligibleDevicesRes = await sql<{
      id: string;
      user_id: string;
      curve25519_key: string;
      ed25519_key: string;
      fallback_key_id: string | null;
      fallback_key: string | null;
      fallback_signature: string | null;
    }>`
      SELECT d.id, d.user_id, d.curve25519_key, d.ed25519_key,
             d.fallback_key_id, d.fallback_key, d.fallback_signature
      FROM chat.devices d
      JOIN auth.public_profiles p ON p.id = d.user_id
      WHERE d.id = ANY(${uniqueDeviceIds}::uuid[])
        AND d.deleted_at IS NULL
        AND (
          d.user_id = ${caller.userId}::uuid
          OR NOT EXISTS (
            SELECT 1 FROM social.blocks b
            WHERE (b.blocker_id = ${caller.userId}::uuid AND b.blocked_id = d.user_id)
               OR (b.blocker_id = d.user_id AND b.blocked_id = ${caller.userId}::uuid)
          )
        )
    `.execute(db);

    const eligibleMap = new Map(eligibleDevicesRes.rows.map((d) => [d.id, d]));
    const claimedKeys: Array<{
      device_id: string;
      user_id: string;
      curve25519_key: string;
      ed25519_key: string;
      key_id: string;
      public_key: string;
      signature: string;
      fallback: boolean;
    }> = [];

    // Atomically claim OTKs per device
    for (const did of uniqueDeviceIds) {
      const dev = eligibleMap.get(did);
      if (!dev) continue;

      const otkRes = await sql<{
        key_id: string;
        public_key: string;
        signature: string;
      }>`
        DELETE FROM chat.one_time_keys
        WHERE (device_id, key_id) = (
          SELECT device_id, key_id
          FROM chat.one_time_keys
          WHERE device_id = ${did}::uuid
          ORDER BY created_at ASC, key_id ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        RETURNING key_id, public_key, signature
      `.execute(db);

      if (otkRes.rows.length > 0) {
        const otk = otkRes.rows[0];
        claimedKeys.push({
          device_id: dev.id,
          user_id: dev.user_id,
          curve25519_key: dev.curve25519_key,
          ed25519_key: dev.ed25519_key,
          key_id: otk.key_id,
          public_key: otk.public_key,
          signature: otk.signature,
          fallback: false,
        });
      } else if (dev.fallback_key_id && dev.fallback_key && dev.fallback_signature) {
        claimedKeys.push({
          device_id: dev.id,
          user_id: dev.user_id,
          curve25519_key: dev.curve25519_key,
          ed25519_key: dev.ed25519_key,
          key_id: dev.fallback_key_id,
          public_key: dev.fallback_key,
          signature: dev.fallback_signature,
          fallback: true,
        });
      }
    }

    return reply.status(200).send({ keys: claimedKeys });
  });
};
