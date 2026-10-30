import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'kysely';
import type { Database } from '../db/types.js';
import type { Kysely } from 'kysely';
import { ProblemError } from '../errors/problem.js';
import { requireAuth, isValidUuid } from '../utils/auth.js';
import type { RateLimiter } from '../rate-limit/valkey-limiter.js';
import { buildToDeviceRateLimitKey } from '../rate-limit/valkey-limiter.js';
import type { RealtimeHintDispatcher } from '../realtime/hints.js';

export interface ToDeviceRouteDependencies {
  db: Kysely<Database>;
  hints: RealtimeHintDispatcher;
  rateLimiter?: RateLimiter;
}

export const toDeviceRoute: FastifyPluginAsync<ToDeviceRouteDependencies> = async (
  fastify,
  { db, hints, rateLimiter },
) => {
  // 1. POST /v1/chat/to-device - Send Olm-encrypted messages to specific devices
  fastify.post<{
    Body: {
      sender_device_id: string;
      messages: Array<{
        device_id: string;
        ciphertext: string;
      }>;
    };
  }>('/v1/chat/to-device', async (request, reply) => {
    const caller = requireAuth(request);
    const { sender_device_id, messages } = request.body || {};

    if (!isValidUuid(sender_device_id)) {
      throw ProblemError.badRequest('Invalid sender_device_id', 'INVALID_DEVICE_ID');
    }

    if (!Array.isArray(messages) || messages.length === 0 || messages.length > 200) {
      throw ProblemError.badRequest(
        'messages must be an array of 1 to 200 items',
        'INVALID_MESSAGES',
      );
    }

    // Rate limiting: 2000 to-device messages / min per user
    if (rateLimiter) {
      await rateLimiter.consume({
        key: buildToDeviceRateLimitKey(caller.userId),
        limit: 2000,
        windowSeconds: 60,
        cost: messages.length,
      });
    }

    // Verify sender device ownership and active state
    const senderDev = await db
      .selectFrom('chat.devices')
      .select('id')
      .where('id', '=', sender_device_id)
      .where('user_id', '=', caller.userId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();

    if (!senderDev) {
      throw ProblemError.forbidden(
        'Sender device is not one of your active devices',
        'DEVICE_NOT_YOURS',
      );
    }

    // Validate ciphertext sizes (max 21848 chars, 16 KiB decoded)
    for (const m of messages) {
      if (!isValidUuid(m.device_id)) {
        throw ProblemError.badRequest(
          `Invalid recipient device_id: ${m.device_id}`,
          'INVALID_DEVICE_ID',
        );
      }
      if (
        !m.ciphertext ||
        typeof m.ciphertext !== 'string' ||
        m.ciphertext.length === 0 ||
        m.ciphertext.length > 21848
      ) {
        throw ProblemError.badRequest(
          'Ciphertext must be between 1 and 21848 characters',
          'INVALID_CIPHERTEXT',
        );
      }
    }

    const targetDeviceIds = [...new Set(messages.map((m) => m.device_id))];

    // Batch query valid recipient devices
    const validDevicesRes = await sql<{ id: string; user_id: string }>`
      SELECT d.id, d.user_id
      FROM chat.devices d
      WHERE d.id = ANY(${targetDeviceIds}::uuid[])
        AND d.deleted_at IS NULL
        AND (
          d.user_id = ${caller.userId}::uuid
          OR (
            NOT EXISTS (
              SELECT 1 FROM social.blocks b
              WHERE (b.blocker_id = ${caller.userId}::uuid AND b.blocked_id = d.user_id)
                 OR (b.blocker_id = d.user_id AND b.blocked_id = ${caller.userId}::uuid)
            )
            AND EXISTS (
              SELECT 1
              FROM chat.members m1
              JOIN chat.members m2 ON m2.conversation_id = m1.conversation_id
              WHERE m1.user_id = ${caller.userId}::uuid
                AND m1.state IN ('ACTIVE', 'REQUESTED')
                AND m2.user_id = d.user_id
                AND m2.state IN ('ACTIVE', 'REQUESTED')
            )
          )
        )
    `.execute(db);

    const allowedMap = new Map(validDevicesRes.rows.map((r) => [r.id, r.user_id]));
    const acceptedMessages: Array<{
      recipient_device_id: string;
      sender_id: string;
      sender_device_id: string;
      ciphertext: string;
    }> = [];
    const skippedDeviceIds: string[] = [];

    for (const m of messages) {
      if (allowedMap.has(m.device_id)) {
        acceptedMessages.push({
          recipient_device_id: m.device_id,
          sender_id: caller.userId,
          sender_device_id,
          ciphertext: m.ciphertext,
        });
      } else {
        skippedDeviceIds.push(m.device_id);
      }
    }

    if (acceptedMessages.length > 0) {
      await db.insertInto('chat.to_device').values(acceptedMessages).execute();

      // Emit realtime hint TO_DEVICE to distinct recipient users
      const recipientUsers = new Set<string>();
      for (const m of acceptedMessages) {
        const uid = allowedMap.get(m.recipient_device_id);
        if (uid) recipientUsers.add(uid);
      }
      hints.publishHints(recipientUsers, { kind: 'TO_DEVICE' });
    }

    return reply.status(202).send({
      accepted: acceptedMessages.length,
      skipped_device_ids: [...new Set(skippedDeviceIds)],
    });
  });

  // 2. GET /v1/chat/devices/:device_id/to-device - Pending messages for own device
  fastify.get<{
    Params: { device_id: string };
    Querystring: { after?: string; limit?: string };
  }>('/v1/chat/devices/:device_id/to-device', async (request, reply) => {
    const caller = requireAuth(request);
    const { device_id } = request.params;

    if (!isValidUuid(device_id)) {
      throw ProblemError.badRequest('Invalid device ID format', 'INVALID_DEVICE_ID');
    }

    const { after, limit: rawLimit } = request.query;
    let limit = 100;
    if (rawLimit !== undefined) {
      const parsed = parseInt(rawLimit, 10);
      if (isNaN(parsed) || parsed < 1 || parsed > 100) {
        throw ProblemError.badRequest(
          'limit must be an integer between 1 and 100',
          'INVALID_LIMIT',
        );
      }
      limit = parsed;
    }

    if (after !== undefined && !/^[0-9]{1,19}$/.test(after)) {
      throw ProblemError.badRequest('after must be a numeric ID string', 'INVALID_AFTER');
    }

    const dev = await db
      .selectFrom('chat.devices')
      .select(['id', 'last_seen_at'])
      .where('id', '=', device_id)
      .where('user_id', '=', caller.userId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();

    if (!dev) {
      throw ProblemError.notFound('Device not found', 'DEVICE_NOT_FOUND');
    }

    // Update last_seen_at throttled to at most once per minute
    await sql`
      UPDATE chat.devices
      SET last_seen_at = now()
      WHERE id = ${device_id}::uuid
        AND (last_seen_at IS NULL OR last_seen_at < now() - interval '1 minute')
    `.execute(db);

    const query = after
      ? sql<{
          id: string;
          sender_id: string;
          sender_device_id: string;
          ciphertext: string;
          created_at: Date;
        }>`
          SELECT id, sender_id, sender_device_id, ciphertext, created_at
          FROM chat.to_device
          WHERE recipient_device_id = ${device_id}::uuid
            AND id > ${after}::bigint
          ORDER BY id ASC
          LIMIT ${limit + 1}
        `
      : sql<{
          id: string;
          sender_id: string;
          sender_device_id: string;
          ciphertext: string;
          created_at: Date;
        }>`
          SELECT id, sender_id, sender_device_id, ciphertext, created_at
          FROM chat.to_device
          WHERE recipient_device_id = ${device_id}::uuid
          ORDER BY id ASC
          LIMIT ${limit + 1}
        `;

    const rowsRes = await query.execute(db);
    const rows = rowsRes.rows;
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;

    const items = pageRows.map((r) => ({
      id: String(r.id),
      sender_id: r.sender_id,
      sender_device_id: r.sender_device_id,
      ciphertext: r.ciphertext,
      created_at: new Date(r.created_at).toISOString(),
    }));

    return reply.status(200).send({
      items,
      has_more: hasMore,
    });
  });

  // 3. POST /v1/chat/devices/:device_id/to-device/ack - Acknowledge and delete messages
  fastify.post<{
    Params: { device_id: string };
    Body: { up_to: string };
  }>('/v1/chat/devices/:device_id/to-device/ack', async (request, reply) => {
    const caller = requireAuth(request);
    const { device_id } = request.params;

    if (!isValidUuid(device_id)) {
      throw ProblemError.badRequest('Invalid device ID format', 'INVALID_DEVICE_ID');
    }

    const { up_to } = request.body || {};
    if (!up_to || typeof up_to !== 'string' || !/^[0-9]{1,19}$/.test(up_to)) {
      throw ProblemError.badRequest('up_to must be a numeric ID string', 'INVALID_UP_TO');
    }

    const dev = await db
      .selectFrom('chat.devices')
      .select('id')
      .where('id', '=', device_id)
      .where('user_id', '=', caller.userId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();

    if (!dev) {
      throw ProblemError.notFound('Device not found', 'DEVICE_NOT_FOUND');
    }

    await sql`
      DELETE FROM chat.to_device
      WHERE recipient_device_id = ${device_id}::uuid
        AND id <= ${up_to}::bigint
    `.execute(db);

    return reply.status(204).send();
  });
};
