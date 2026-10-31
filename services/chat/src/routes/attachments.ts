import type { FastifyPluginAsync } from 'fastify';
import { sql, type Kysely } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import type { Database } from '../db/types.js';
import { ProblemError } from '../errors/problem.js';
import { requireAuth, isValidUuid } from '../utils/auth.js';
import type { RateLimiter } from '../rate-limit/valkey-limiter.js';
import {
  buildCreateAttachmentRateLimitKey,
  buildDownloadAttachmentRateLimitKey,
} from '../rate-limit/valkey-limiter.js';
import { attachmentObjectKey, type AttachmentStorage } from '../storage/attachment-storage.js';
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_QUOTA_BYTES,
  DOWNLOAD_URL_TTL_SECONDS,
  UPLOAD_URL_TTL_SECONDS,
  toAttachmentDto,
} from '../utils/attachments.js';

export interface AttachmentsRouteDependencies {
  db: Kysely<Database>;
  storage: AttachmentStorage | null;
  attachmentTtlMs: number;
  rateLimiter?: RateLimiter;
}

function requireStorage(storage: AttachmentStorage | null): AttachmentStorage {
  if (!storage) {
    throw ProblemError.serviceUnavailable(
      'Attachments are not configured on this server',
      'ATTACHMENTS_UNAVAILABLE',
    );
  }
  return storage;
}

export const attachmentsRoute: FastifyPluginAsync<AttachmentsRouteDependencies> = async (
  fastify,
  { db, storage, attachmentTtlMs, rateLimiter },
) => {
  // createAttachment: reserve a PENDING row and presign one PUT of exactly size_bytes.
  fastify.post<{
    Params: { conversation_id: string };
    Body: { sender_device_id?: unknown; size_bytes?: unknown };
  }>('/v1/chat/conversations/:conversation_id/attachments', async (request, reply) => {
    const caller = requireAuth(request);
    const { conversation_id } = request.params;
    if (!isValidUuid(conversation_id)) {
      throw ProblemError.badRequest('Invalid conversation ID', 'INVALID_CONVERSATION_ID');
    }
    const body = request.body ?? {};
    const keys = Object.keys(body);
    if (keys.some((k) => k !== 'sender_device_id' && k !== 'size_bytes')) {
      throw ProblemError.badRequest('Unknown field in request body', 'INVALID_BODY');
    }
    const { sender_device_id, size_bytes } = body;
    if (!isValidUuid(sender_device_id)) {
      throw ProblemError.badRequest('Invalid sender_device_id', 'INVALID_DEVICE_ID');
    }
    if (
      typeof size_bytes !== 'number' ||
      !Number.isInteger(size_bytes) ||
      size_bytes < 1 ||
      size_bytes > ATTACHMENT_MAX_BYTES
    ) {
      throw ProblemError.badRequest(
        'size_bytes must be an integer from 1 to 26214400',
        'INVALID_SIZE',
      );
    }
    const s3 = requireStorage(storage);

    if (rateLimiter) {
      await rateLimiter.consume({
        key: buildCreateAttachmentRateLimitKey(caller.userId),
        limit: 100,
        windowSeconds: 3600,
      });
    }

    const id = uuidv7();
    const inserted = await db.transaction().execute(async (trx) => {
      const member = await trx
        .selectFrom('chat.members')
        .select(['state'])
        .where('conversation_id', '=', conversation_id)
        .where('user_id', '=', caller.userId)
        .executeTakeFirst();
      if (!member || member.state === 'LEFT') {
        throw ProblemError.notFound('Conversation not found', 'CONVERSATION_NOT_FOUND');
      }
      if (member.state === 'REQUESTED') {
        throw ProblemError.forbidden('Accept the request before sending files', 'REQUEST_PENDING');
      }

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

      // Quota of live bytes per user, serialised per user so two parallel reservations cannot both pass.
      await sql`SELECT pg_advisory_xact_lock(hashtext(${'chat.attachment_quota:' + caller.userId}))`.execute(
        trx,
      );
      const used = await sql<{ total: string | null }>`
        SELECT sum(size_bytes)::text AS total
        FROM chat.attachments
        WHERE uploader_id = ${caller.userId}::uuid AND expires_at > now()
      `.execute(trx);
      if (Number(used.rows[0]?.total ?? 0) + size_bytes > ATTACHMENT_QUOTA_BYTES) {
        throw ProblemError.conflict(
          'Attachment storage quota (1 GiB) exceeded',
          'ATTACHMENT_QUOTA',
        );
      }

      const now = new Date();
      return trx
        .insertInto('chat.attachments')
        .values({
          id,
          conversation_id,
          uploader_id: caller.userId,
          uploader_device_id: sender_device_id,
          size_bytes: String(size_bytes),
          expires_at: new Date(now.getTime() + attachmentTtlMs),
        })
        .returning(['id', 'conversation_id', 'size_bytes', 'state', 'expires_at', 'created_at'])
        .executeTakeFirstOrThrow();
    });

    const upload = await s3.presignPut(
      attachmentObjectKey(conversation_id, id),
      size_bytes,
      UPLOAD_URL_TTL_SECONDS,
    );
    request.log.info({ attachment_id: id, size_bytes }, 'Attachment reserved');

    return reply.status(201).send({
      attachment: toAttachmentDto(inserted),
      upload_url: upload.url,
      upload_headers: upload.headers,
      upload_expires_at: new Date(Date.now() + UPLOAD_URL_TTL_SECONDS * 1000).toISOString(),
    });
  });

  // completeAttachment: the uploader confirms; HEAD checks the exact size. Idempotent.
  fastify.post<{ Params: { conversation_id: string; attachment_id: string } }>(
    '/v1/chat/conversations/:conversation_id/attachments/:attachment_id/complete',
    async (request, reply) => {
      const caller = requireAuth(request);
      const { conversation_id, attachment_id } = request.params;
      if (!isValidUuid(conversation_id) || !isValidUuid(attachment_id)) {
        throw ProblemError.notFound('Attachment not found', 'ATTACHMENT_NOT_FOUND');
      }
      const s3 = requireStorage(storage);

      const row = await db
        .selectFrom('chat.attachments')
        .selectAll()
        .where('id', '=', attachment_id)
        .where('conversation_id', '=', conversation_id)
        .executeTakeFirst();
      if (!row) {
        throw ProblemError.notFound('Attachment not found', 'ATTACHMENT_NOT_FOUND');
      }
      if (row.uploader_id !== caller.userId) {
        throw ProblemError.forbidden(
          'Only the uploader can complete an attachment',
          'NOT_UPLOADER',
        );
      }
      if (row.state === 'UPLOADED') {
        return reply.status(200).send(toAttachmentDto(row));
      }

      const key = attachmentObjectKey(conversation_id, attachment_id);
      const actual = await s3.headSize(key);
      if (actual === null) {
        throw ProblemError.conflict('The upload has not finished', 'UPLOAD_INCOMPLETE');
      }
      if (actual !== Number(row.size_bytes)) {
        await s3.deleteObject(key).catch((err: unknown) => {
          request.log.warn(
            { err, attachment_id },
            'Could not delete a wrong-size attachment object',
          );
        });
        request.log.info(
          { attachment_id, expected: Number(row.size_bytes), actual },
          'Attachment upload had the wrong size',
        );
        throw ProblemError.conflict('The uploaded object has the wrong size', 'UPLOAD_INCOMPLETE');
      }

      const updated = await db
        .updateTable('chat.attachments')
        .set({ state: 'UPLOADED', uploaded_at: new Date() })
        .where('id', '=', attachment_id)
        .where('state', '=', 'PENDING')
        .returningAll()
        .executeTakeFirst();
      // A concurrent completion already set UPLOADED: return the stored row.
      const result =
        updated ??
        (await db
          .selectFrom('chat.attachments')
          .selectAll()
          .where('id', '=', attachment_id)
          .executeTakeFirstOrThrow());
      return reply.status(200).send(toAttachmentDto(result));
    },
  );

  // downloadAttachment: the uploader, or a member whose readable range includes the referencing message.
  fastify.post<{ Params: { conversation_id: string; attachment_id: string } }>(
    '/v1/chat/conversations/:conversation_id/attachments/:attachment_id/download',
    async (request, reply) => {
      const caller = requireAuth(request);
      const { conversation_id, attachment_id } = request.params;
      if (!isValidUuid(conversation_id) || !isValidUuid(attachment_id)) {
        throw ProblemError.notFound('Attachment not found', 'ATTACHMENT_NOT_FOUND');
      }
      const s3 = requireStorage(storage);

      if (rateLimiter) {
        await rateLimiter.consume({
          key: buildDownloadAttachmentRateLimitKey(caller.userId),
          limit: 600,
          windowSeconds: 60,
        });
      }

      const res = await sql<{
        size_bytes: string;
        state: string;
        expires_at: Date;
        uploader_id: string;
        message_seq: string | null;
        message_deleted: boolean | null;
        joined_seq: string | null;
        readable_to: string | null;
      }>`
        SELECT a.size_bytes, a.state, a.expires_at, a.uploader_id, a.message_seq,
               (m.deleted_at IS NOT NULL) AS message_deleted,
               mem.joined_seq, COALESCE(mem.left_seq, c.last_seq) AS readable_to
        FROM chat.attachments a
        JOIN chat.conversations c ON c.id = a.conversation_id
        LEFT JOIN chat.messages m ON m.conversation_id = a.conversation_id AND m.seq = a.message_seq
        LEFT JOIN chat.members mem ON mem.conversation_id = a.conversation_id AND mem.user_id = ${caller.userId}::uuid
        WHERE a.id = ${attachment_id}::uuid AND a.conversation_id = ${conversation_id}::uuid
      `.execute(db);
      const row = res.rows[0];

      const isUploader = row?.uploader_id === caller.userId;
      const memberCanRead =
        !!row &&
        row.message_seq !== null &&
        row.joined_seq !== null &&
        row.readable_to !== null &&
        BigInt(row.message_seq) >= BigInt(row.joined_seq) &&
        BigInt(row.message_seq) <= BigInt(row.readable_to);
      if (
        !row ||
        row.message_deleted ||
        row.state !== 'UPLOADED' ||
        !(isUploader || memberCanRead)
      ) {
        throw ProblemError.notFound('Attachment not found', 'ATTACHMENT_NOT_FOUND');
      }
      if (new Date(row.expires_at).getTime() <= Date.now()) {
        throw ProblemError.gone('The attachment expired', 'ATTACHMENT_EXPIRED');
      }

      const url = await s3.presignGet(
        attachmentObjectKey(conversation_id, attachment_id),
        DOWNLOAD_URL_TTL_SECONDS,
      );
      return reply.status(200).send({
        url,
        expires_at: new Date(Date.now() + DOWNLOAD_URL_TTL_SECONDS * 1000).toISOString(),
        size_bytes: Number(row.size_bytes),
      });
    },
  );
};
