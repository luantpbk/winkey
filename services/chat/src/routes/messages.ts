import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import type { Database } from '../db/types.js';
import type { Kysely } from 'kysely';
import { ProblemError } from '../errors/problem.js';
import { requireAuth, isValidUuid } from '../utils/auth.js';
import type { RateLimiter } from '../rate-limit/valkey-limiter.js';
import { buildMessageRateLimitKey } from '../rate-limit/valkey-limiter.js';
import type { RealtimeHintDispatcher } from '../realtime/hints.js';
import { attachmentObjectKey, type AttachmentStorage } from '../storage/attachment-storage.js';
import {
  ATTACHMENTS_PER_MESSAGE,
  loadAttachmentsBySeq,
  type AttachmentDto,
} from '../utils/attachments.js';

export interface MessagesRouteDependencies {
  db: Kysely<Database>;
  hints: RealtimeHintDispatcher;
  rateLimiter?: RateLimiter;
  storage?: AttachmentStorage | null;
}

export const messagesRoute: FastifyPluginAsync<MessagesRouteDependencies> = async (
  fastify,
  { db, hints, rateLimiter, storage = null },
) => {
  // 1. POST /v1/chat/conversations/:conversation_id/messages - Send Megolm message
  fastify.post<{
    Params: { conversation_id: string };
    Body: {
      client_msg_id: string;
      sender_device_id: string;
      megolm_session_id: string;
      ciphertext: string;
      attachment_ids?: unknown;
    };
  }>('/v1/chat/conversations/:conversation_id/messages', async (request, reply) => {
    const caller = requireAuth(request);
    const { conversation_id } = request.params;

    if (!isValidUuid(conversation_id)) {
      throw ProblemError.badRequest('Invalid conversation ID', 'INVALID_CONVERSATION_ID');
    }

    const { client_msg_id, sender_device_id, megolm_session_id, ciphertext, attachment_ids } =
      request.body || {};

    if (!isValidUuid(client_msg_id)) {
      throw ProblemError.badRequest('Invalid client_msg_id', 'INVALID_CLIENT_MSG_ID');
    }
    if (!isValidUuid(sender_device_id)) {
      throw ProblemError.badRequest('Invalid sender_device_id', 'INVALID_DEVICE_ID');
    }
    if (
      !megolm_session_id ||
      typeof megolm_session_id !== 'string' ||
      megolm_session_id.length > 64
    ) {
      throw ProblemError.badRequest(
        'megolm_session_id must be 1 to 64 characters',
        'INVALID_MEGOLM_SESSION',
      );
    }
    if (
      !ciphertext ||
      typeof ciphertext !== 'string' ||
      ciphertext.length === 0 ||
      ciphertext.length > 87384
    ) {
      throw ProblemError.badRequest(
        'ciphertext must be between 1 and 87384 characters',
        'INVALID_CIPHERTEXT',
      );
    }

    let attachmentIds: string[] = [];
    if (attachment_ids !== undefined) {
      if (
        !Array.isArray(attachment_ids) ||
        attachment_ids.length > ATTACHMENTS_PER_MESSAGE ||
        !attachment_ids.every((id) => isValidUuid(id)) ||
        new Set(attachment_ids).size !== attachment_ids.length
      ) {
        throw ProblemError.badRequest(
          'attachment_ids must hold at most 10 distinct attachment ids',
          'INVALID_ATTACHMENT_IDS',
        );
      }
      attachmentIds = attachment_ids as string[];
    }

    // Rate limit: 60 messages / min per user
    if (rateLimiter) {
      await rateLimiter.consume({
        key: buildMessageRateLimitKey(caller.userId),
        limit: 60,
        windowSeconds: 60,
      });
    }

    let isDuplicate = false;
    let messageResult: {
      conversation_id: string;
      seq: string;
      id: string;
      kind: 'ENCRYPTED' | 'SYSTEM';
      sender_id: string | null;
      sender_device_id: string | null;
      megolm_session_id: string | null;
      ciphertext: string | null;
      system_body: unknown;
      deleted_at: Date | null;
      created_at: Date;
    };
    let memberIdsToNotify: string[] = [];

    await db.transaction().execute(async (trx) => {
      // 1. Lock conversation row
      const conv = await trx
        .selectFrom('chat.conversations')
        .selectAll()
        .where('id', '=', conversation_id)
        .forUpdate()
        .executeTakeFirst();

      if (!conv) {
        throw ProblemError.notFound('Conversation not found', 'CONVERSATION_NOT_FOUND');
      }

      // 2. Check early idempotency
      const existingMsg = await trx
        .selectFrom('chat.messages')
        .selectAll()
        .where('sender_id', '=', caller.userId)
        .where('client_msg_id', '=', client_msg_id)
        .executeTakeFirst();

      if (existingMsg) {
        if (existingMsg.conversation_id !== conversation_id) {
          throw ProblemError.conflict(
            'client_msg_id already used in another conversation',
            'CLIENT_MSG_ID_CONFLICT',
          );
        }
        isDuplicate = true;
        messageResult = {
          conversation_id: existingMsg.conversation_id,
          seq: existingMsg.seq,
          id: existingMsg.id,
          kind: existingMsg.kind,
          sender_id: existingMsg.sender_id,
          sender_device_id: existingMsg.sender_device_id,
          megolm_session_id: existingMsg.megolm_session_id,
          ciphertext: existingMsg.ciphertext,
          system_body: existingMsg.system_body,
          deleted_at: existingMsg.deleted_at ? new Date(existingMsg.deleted_at) : null,
          created_at: new Date(existingMsg.created_at),
        };
        return;
      }

      // 3. Verify sender membership
      const members = await trx
        .selectFrom('chat.members')
        .selectAll()
        .where('conversation_id', '=', conversation_id)
        .execute();

      const callerMem = members.find((m) => m.user_id === caller.userId);
      if (!callerMem || callerMem.state === 'LEFT') {
        throw ProblemError.notFound('Conversation not found', 'CONVERSATION_NOT_FOUND');
      }

      if (callerMem.state === 'REQUESTED') {
        throw ProblemError.forbidden(
          'Cannot send messages while request is pending',
          'REQUEST_PENDING',
        );
      }

      // 4. Verify sender device ownership & active state
      const device = await trx
        .selectFrom('chat.devices')
        .select('id')
        .where('id', '=', sender_device_id)
        .where('user_id', '=', caller.userId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();

      if (!device) {
        throw ProblemError.forbidden(
          'Sender device is not one of your active devices',
          'DEVICE_NOT_YOURS',
        );
      }

      // 5. DIRECT conversation checks (peer not left, no blocks)
      if (conv.kind === 'DIRECT') {
        const peer = members.find((m) => m.user_id !== caller.userId);
        if (!peer || peer.state === 'LEFT') {
          throw ProblemError.conflict(
            'The other member has left the direct conversation',
            'CONVERSATION_CLOSED',
          );
        }

        const blockCheck = await sql`
          SELECT 1 FROM social.blocks
          WHERE (blocker_id = ${caller.userId}::uuid AND blocked_id = ${peer.user_id}::uuid)
             OR (blocker_id = ${peer.user_id}::uuid AND blocked_id = ${caller.userId}::uuid)
          LIMIT 1
        `.execute(trx);

        if (blockCheck.rows.length > 0) {
          throw ProblemError.forbidden('Cannot message blocked user', 'INTERACTION_BLOCKED');
        }
      }

      // 6. Assign next seq and insert message
      const nextSeq = (BigInt(conv.last_seq) + 1n).toString();
      const now = new Date();

      await trx
        .updateTable('chat.conversations')
        .set({ last_seq: nextSeq, last_message_at: now })
        .where('id', '=', conversation_id)
        .execute();

      // Auto-bump sender's last_read_seq
      await trx
        .updateTable('chat.members')
        .set({ last_read_seq: nextSeq, updated_at: now })
        .where('conversation_id', '=', conversation_id)
        .where('user_id', '=', caller.userId)
        .execute();

      try {
        const inserted = await trx
          .insertInto('chat.messages')
          .values({
            conversation_id,
            seq: nextSeq,
            id: uuidv7(),
            kind: 'ENCRYPTED',
            sender_id: caller.userId,
            sender_device_id,
            client_msg_id,
            megolm_session_id,
            ciphertext,
            system_body: null,
            created_at: now,
          })
          .returningAll()
          .executeTakeFirstOrThrow();

        messageResult = {
          conversation_id: inserted.conversation_id,
          seq: inserted.seq,
          id: inserted.id,
          kind: inserted.kind,
          sender_id: inserted.sender_id,
          sender_device_id: inserted.sender_device_id,
          megolm_session_id: inserted.megolm_session_id,
          ciphertext: inserted.ciphertext,
          system_body: inserted.system_body,
          deleted_at: inserted.deleted_at ? new Date(inserted.deleted_at) : null,
          created_at: new Date(inserted.created_at),
        };
      } catch (err: unknown) {
        const pgErr = err as { code?: string; constraint?: string };
        // The conversation row is locked FOR UPDATE at step 1 and checked at step 2,
        // so same-conversation retries are already handled early. Any 23505 unique violation
        // here is a cross-conversation client_msg_id collision. The transaction has been
        // aborted by Postgres, so we must never query trx again (avoiding 25P02).
        if (
          pgErr.code === '23505' &&
          (!pgErr.constraint || pgErr.constraint === 'messages_idempotency')
        ) {
          throw ProblemError.conflict(
            'client_msg_id already used in another conversation',
            'CLIENT_MSG_ID_CONFLICT',
          );
        }
        throw err;
      }

      // SOC-3b: link the attachments in the transaction that assigns seq. Any id that is not the caller's own,
      // UPLOADED, unexpired and unlinked attachment in this conversation rolls the whole send back.
      if (attachmentIds.length > 0) {
        const linked = await sql<{ id: string }>`
          UPDATE chat.attachments SET message_seq = ${nextSeq}::bigint
          WHERE id = ANY(${attachmentIds}::uuid[])
            AND conversation_id = ${conversation_id}::uuid
            AND uploader_id = ${caller.userId}::uuid
            AND state = 'UPLOADED'
            AND message_seq IS NULL
            AND expires_at > now()
          RETURNING id
        `.execute(trx);
        if (linked.rows.length !== attachmentIds.length) {
          throw ProblemError.conflict(
            'An attachment is missing, expired, not yours or already sent',
            'ATTACHMENT_UNAVAILABLE',
          );
        }
      }

      memberIdsToNotify = members
        .filter((m) => m.state === 'ACTIVE' || m.state === 'REQUESTED')
        .map((m) => m.user_id);
    });

    if (!isDuplicate) {
      for (const uid of memberIdsToNotify) {
        hints.publishHint(uid, {
          kind: 'MESSAGE',
          conversation_id,
          seq: Number(messageResult!.seq),
        });
      }
    }

    const attachments = messageResult!.deleted_at
      ? []
      : ((await loadAttachmentsBySeq(db, conversation_id, [messageResult!.seq])).get(
          String(messageResult!.seq),
        ) ?? []);

    const statusCode = isDuplicate ? 200 : 201;
    return reply.status(statusCode).send({
      conversation_id: messageResult!.conversation_id,
      seq: Number(messageResult!.seq),
      id: messageResult!.id,
      kind: messageResult!.kind,
      sender_id: messageResult!.sender_id,
      sender_device_id: messageResult!.sender_device_id,
      megolm_session_id: messageResult!.megolm_session_id,
      ciphertext: messageResult!.ciphertext,
      system: null,
      deleted: messageResult!.deleted_at !== null,
      attachments,
      created_at: messageResult!.created_at.toISOString(),
    });
  });

  // 2. GET /v1/chat/conversations/:conversation_id/messages - List messages in seq order
  fastify.get<{
    Params: { conversation_id: string };
    Querystring: { after_seq?: string; before_seq?: string; limit?: string };
  }>('/v1/chat/conversations/:conversation_id/messages', async (request, reply) => {
    const caller = requireAuth(request);
    const { conversation_id } = request.params;

    if (!isValidUuid(conversation_id)) {
      throw ProblemError.badRequest('Invalid conversation ID', 'INVALID_CONVERSATION_ID');
    }

    const { after_seq, before_seq, limit: rawLimit } = request.query;

    if (after_seq !== undefined && before_seq !== undefined) {
      throw ProblemError.badRequest(
        'Cannot specify both after_seq and before_seq',
        'INVALID_QUERY',
      );
    }

    let limit = 50;
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

    const conv = await db
      .selectFrom('chat.conversations')
      .select('last_seq')
      .where('id', '=', conversation_id)
      .executeTakeFirst();

    if (!conv) {
      throw ProblemError.notFound('Conversation not found', 'CONVERSATION_NOT_FOUND');
    }

    const callerMem = await db
      .selectFrom('chat.members')
      .selectAll()
      .where('conversation_id', '=', conversation_id)
      .where('user_id', '=', caller.userId)
      .executeTakeFirst();

    if (!callerMem) {
      throw ProblemError.notFound('Conversation not found', 'CONVERSATION_NOT_FOUND');
    }

    const minSeq = BigInt(callerMem.joined_seq);
    const maxSeq = callerMem.left_seq ? BigInt(callerMem.left_seq) : BigInt(conv.last_seq);

    let rows: Array<{
      conversation_id: string;
      seq: string;
      id: string;
      kind: 'ENCRYPTED' | 'SYSTEM';
      sender_id: string | null;
      sender_device_id: string | null;
      megolm_session_id: string | null;
      ciphertext: string | null;
      system_body: unknown;
      deleted_at: Date | null;
      created_at: Date;
    }> = [];
    let hasMore = false;

    if (after_seq !== undefined) {
      const afterVal = BigInt(after_seq);
      const res = await sql<{
        conversation_id: string;
        seq: string;
        id: string;
        kind: 'ENCRYPTED' | 'SYSTEM';
        sender_id: string | null;
        sender_device_id: string | null;
        megolm_session_id: string | null;
        ciphertext: string | null;
        system_body: unknown;
        deleted_at: Date | null;
        created_at: Date;
      }>`
        SELECT conversation_id, seq, id, kind, sender_id, sender_device_id,
               megolm_session_id, ciphertext, system_body, deleted_at, created_at
        FROM chat.messages
        WHERE conversation_id = ${conversation_id}::uuid
          AND seq > ${afterVal}::bigint
          AND seq >= ${minSeq}::bigint
          AND seq <= ${maxSeq}::bigint
        ORDER BY seq ASC
        LIMIT ${limit + 1}
      `.execute(db);

      hasMore = res.rows.length > limit;
      rows = hasMore ? res.rows.slice(0, limit) : res.rows;
    } else if (before_seq !== undefined) {
      const beforeVal = BigInt(before_seq);
      const res = await sql<{
        conversation_id: string;
        seq: string;
        id: string;
        kind: 'ENCRYPTED' | 'SYSTEM';
        sender_id: string | null;
        sender_device_id: string | null;
        megolm_session_id: string | null;
        ciphertext: string | null;
        system_body: unknown;
        deleted_at: Date | null;
        created_at: Date;
      }>`
        SELECT conversation_id, seq, id, kind, sender_id, sender_device_id,
               megolm_session_id, ciphertext, system_body, deleted_at, created_at
        FROM chat.messages
        WHERE conversation_id = ${conversation_id}::uuid
          AND seq < ${beforeVal}::bigint
          AND seq >= ${minSeq}::bigint
          AND seq <= ${maxSeq}::bigint
        ORDER BY seq DESC
        LIMIT ${limit + 1}
      `.execute(db);

      hasMore = res.rows.length > limit;
      const sliced = hasMore ? res.rows.slice(0, limit) : res.rows;
      rows = sliced.reverse();
    } else {
      // Newest page
      const res = await sql<{
        conversation_id: string;
        seq: string;
        id: string;
        kind: 'ENCRYPTED' | 'SYSTEM';
        sender_id: string | null;
        sender_device_id: string | null;
        megolm_session_id: string | null;
        ciphertext: string | null;
        system_body: unknown;
        deleted_at: Date | null;
        created_at: Date;
      }>`
        SELECT conversation_id, seq, id, kind, sender_id, sender_device_id,
               megolm_session_id, ciphertext, system_body, deleted_at, created_at
        FROM chat.messages
        WHERE conversation_id = ${conversation_id}::uuid
          AND seq >= ${minSeq}::bigint
          AND seq <= ${maxSeq}::bigint
        ORDER BY seq DESC
        LIMIT ${limit + 1}
      `.execute(db);

      hasMore = res.rows.length > limit;
      const sliced = hasMore ? res.rows.slice(0, limit) : res.rows;
      rows = sliced.reverse();
    }

    const attachmentsBySeq = await loadAttachmentsBySeq(
      db,
      conversation_id,
      rows.filter((r) => r.kind === 'ENCRYPTED' && r.deleted_at === null).map((r) => r.seq),
    );
    const noAttachments: AttachmentDto[] = [];

    const items = rows.map((r) => {
      let system: unknown = null;
      if (r.kind === 'SYSTEM' && r.system_body) {
        system = typeof r.system_body === 'string' ? JSON.parse(r.system_body) : r.system_body;
      }

      const isDeleted = r.deleted_at !== null;
      return {
        conversation_id: r.conversation_id,
        seq: Number(r.seq),
        id: r.id,
        kind: r.kind,
        sender_id: r.sender_id,
        sender_device_id: r.sender_device_id,
        megolm_session_id: isDeleted ? null : r.megolm_session_id,
        ciphertext: isDeleted ? null : r.ciphertext,
        system,
        deleted: isDeleted,
        attachments: isDeleted
          ? noAttachments
          : (attachmentsBySeq.get(String(r.seq)) ?? noAttachments),
        created_at: new Date(r.created_at).toISOString(),
      };
    });

    return reply.status(200).send({
      items,
      has_more: hasMore,
    });
  });

  // 3. DELETE /v1/chat/conversations/:conversation_id/messages/:seq - Tombstone message
  fastify.delete<{
    Params: { conversation_id: string; seq: string };
  }>('/v1/chat/conversations/:conversation_id/messages/:seq', async (request, reply) => {
    const caller = requireAuth(request);
    const { conversation_id, seq } = request.params;

    if (!isValidUuid(conversation_id)) {
      throw ProblemError.badRequest('Invalid conversation ID', 'INVALID_CONVERSATION_ID');
    }

    const seqBigInt = BigInt(seq);
    let memberIdsToNotify: string[] = [];
    let deletedAttachmentIds: string[] = [];

    await db.transaction().execute(async (trx) => {
      const msg = await trx
        .selectFrom('chat.messages')
        .selectAll()
        .where('conversation_id', '=', conversation_id)
        .where('seq', '=', seqBigInt.toString())
        .executeTakeFirst();

      if (!msg) {
        throw ProblemError.notFound('Message not found', 'MESSAGE_NOT_FOUND');
      }

      if (msg.kind === 'SYSTEM' || msg.sender_id !== caller.userId) {
        throw ProblemError.forbidden('Cannot delete this message', 'NOT_ALLOWED');
      }

      if (msg.deleted_at !== null) {
        // Idempotent
        return;
      }

      await trx
        .updateTable('chat.messages')
        .set({
          ciphertext: null,
          deleted_at: new Date(),
        })
        .where('conversation_id', '=', conversation_id)
        .where('seq', '=', seqBigInt.toString())
        .execute();

      // SOC-3b: a deleted message takes its attachments with it. They expire now (download → 404 already, since
      // the message is deleted); objects and rows go after the commit, and whatever fails stays expired for the
      // janitor.
      const expired = await sql<{ id: string }>`
        UPDATE chat.attachments SET expires_at = greatest(now(), created_at + interval '1 millisecond')
        WHERE conversation_id = ${conversation_id}::uuid AND message_seq = ${seqBigInt.toString()}::bigint
        RETURNING id
      `.execute(trx);
      deletedAttachmentIds = expired.rows.map((r) => r.id);

      const members = await trx
        .selectFrom('chat.members')
        .select('user_id')
        .where('conversation_id', '=', conversation_id)
        .where('state', 'in', ['ACTIVE', 'REQUESTED'])
        .execute();

      memberIdsToNotify = members.map((m) => m.user_id);
    });

    if (deletedAttachmentIds.length > 0 && storage) {
      const keyToId = new Map(
        deletedAttachmentIds.map((id) => [attachmentObjectKey(conversation_id, id), id] as const),
      );
      const failedKeys = new Set(await storage.deleteObjects([...keyToId.keys()]));
      const deletedIds = [...keyToId].filter(([key]) => !failedKeys.has(key)).map(([, id]) => id);
      if (deletedIds.length > 0) {
        await db.deleteFrom('chat.attachments').where('id', 'in', deletedIds).execute();
      }
      if (failedKeys.size > 0) {
        request.log.warn(
          { count: failedKeys.size },
          'Could not delete attachment objects of a deleted message; the janitor retries',
        );
      }
    }

    const conv = await db
      .selectFrom('chat.conversations')
      .select('last_seq')
      .where('id', '=', conversation_id)
      .executeTakeFirst();

    const lastSeqNum = conv ? Number(conv.last_seq) : Number(seq);
    for (const uid of memberIdsToNotify) {
      hints.publishHint(uid, {
        kind: 'MESSAGE',
        conversation_id,
        seq: lastSeqNum,
      });
    }

    return reply.status(204).send();
  });
};
