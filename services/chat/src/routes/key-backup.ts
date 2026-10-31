import type { FastifyPluginAsync } from 'fastify';
import { sql, type Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import { ProblemError } from '../errors/problem.js';
import { requireAuth, isValidUuid } from '../utils/auth.js';
import { encodeCursor, decodeCursor } from '../utils/pagination.js';
import type { RateLimiter } from '../rate-limit/valkey-limiter.js';
import {
  buildGetKeyBackupRateLimitKey,
  buildKeyBackupSessionsRateLimitKey,
  buildPutKeyBackupRateLimitKey,
} from '../rate-limit/valkey-limiter.js';

export interface KeyBackupRouteDependencies {
  db: Kysely<Database>;
  rateLimiter?: RateLimiter;
}

const ALGORITHM = 'winkey.backup.v1';
const AUTH_DATA_MAX_BYTES = 4096;
const MAX_SESSIONS = 50_000;
const SESSIONS_PER_REQUEST = 100;

interface BackedUpSession {
  conversation_id: string;
  session_id: string;
  first_message_index: number;
  ciphertext: string;
}

interface SessionsCursor {
  c: string;
  s: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** auth_data is opaque: an object of at most 4 KiB serialised (the DB checks the same with pg_column_size). */
function validateAuthData(value: unknown): Record<string, unknown> {
  if (
    !isPlainObject(value) ||
    Buffer.byteLength(JSON.stringify(value), 'utf8') > AUTH_DATA_MAX_BYTES
  ) {
    throw ProblemError.badRequest(
      'auth_data must be an object of at most 4 KiB',
      'INVALID_AUTH_DATA',
    );
  }
  return value;
}

function validateSession(value: unknown): BackedUpSession {
  if (!isPlainObject(value)) {
    throw ProblemError.badRequest('Each session must be an object', 'INVALID_SESSION');
  }
  const allowed = new Set(['conversation_id', 'session_id', 'first_message_index', 'ciphertext']);
  if (Object.keys(value).some((k) => !allowed.has(k))) {
    throw ProblemError.badRequest('Unknown field in a session', 'INVALID_SESSION');
  }
  const { conversation_id, session_id, first_message_index, ciphertext } = value;
  if (
    !isValidUuid(conversation_id) ||
    typeof session_id !== 'string' ||
    session_id.length < 1 ||
    session_id.length > 64 ||
    typeof first_message_index !== 'number' ||
    !Number.isInteger(first_message_index) ||
    first_message_index < 0 ||
    first_message_index > 2_147_483_647 ||
    typeof ciphertext !== 'string' ||
    ciphertext.length < 1 ||
    ciphertext.length > 10924
  ) {
    throw ProblemError.badRequest('Invalid session', 'INVALID_SESSION');
  }
  return { conversation_id, session_id, first_message_index, ciphertext };
}

function parseVersion(raw: unknown): string {
  const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw : '';
  if (!/^[1-9]\d{0,17}$/.test(text)) {
    throw ProblemError.badRequest('version must be a positive integer', 'INVALID_VERSION');
  }
  return text;
}

function toKeyBackupDto(
  row: {
    version: string;
    algorithm: string;
    auth_data: unknown;
    created_at: Date;
    updated_at: Date;
  },
  sessionCount: number,
) {
  return {
    version: Number(row.version),
    algorithm: row.algorithm,
    auth_data: typeof row.auth_data === 'string' ? JSON.parse(row.auth_data) : row.auth_data,
    session_count: sessionCount,
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
  };
}

export const keyBackupRoute: FastifyPluginAsync<KeyBackupRouteDependencies> = async (
  fastify,
  { db, rateLimiter },
) => {
  const loadVersion = async (userId: string): Promise<string | null> => {
    const row = await db
      .selectFrom('chat.key_backups')
      .select('version')
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return row ? String(row.version) : null;
  };

  // getKeyBackup
  fastify.get('/v1/chat/key-backup', async (request, reply) => {
    const caller = requireAuth(request);
    if (rateLimiter) {
      await rateLimiter.consume({
        key: buildGetKeyBackupRateLimitKey(caller.userId),
        limit: 30,
        windowSeconds: 3600,
      });
    }
    const row = await db
      .selectFrom('chat.key_backups')
      .selectAll()
      .where('user_id', '=', caller.userId)
      .executeTakeFirst();
    if (!row) {
      throw ProblemError.notFound('No key backup', 'BACKUP_NOT_FOUND');
    }
    const count = await db
      .selectFrom('chat.key_backup_sessions')
      .select(sql<string>`count(*)`.as('n'))
      .where('user_id', '=', caller.userId)
      .executeTakeFirstOrThrow();
    return reply.status(200).send(toKeyBackupDto(row, Number(count.n)));
  });

  // putKeyBackup: create version 1, or replace (bump version, new auth_data, drop every session).
  fastify.put<{ Body: { algorithm?: unknown; auth_data?: unknown; replace?: unknown } }>(
    '/v1/chat/key-backup',
    async (request, reply) => {
      const caller = requireAuth(request);
      const body = request.body ?? {};
      if (Object.keys(body).some((k) => !['algorithm', 'auth_data', 'replace'].includes(k))) {
        throw ProblemError.badRequest('Unknown field in request body', 'INVALID_BODY');
      }
      if (body.algorithm !== ALGORITHM) {
        throw ProblemError.badRequest('algorithm must be winkey.backup.v1', 'INVALID_ALGORITHM');
      }
      const authData = validateAuthData(body.auth_data);
      if (body.replace !== undefined && typeof body.replace !== 'boolean') {
        throw ProblemError.badRequest('replace must be a boolean', 'INVALID_BODY');
      }
      const replace = body.replace === true;

      if (rateLimiter) {
        await rateLimiter.consume({
          key: buildPutKeyBackupRateLimitKey(caller.userId),
          limit: 10,
          windowSeconds: 86_400,
        });
      }

      const result = await db.transaction().execute(async (trx) => {
        const existing = await trx
          .selectFrom('chat.key_backups')
          .select('version')
          .where('user_id', '=', caller.userId)
          .forUpdate()
          .executeTakeFirst();

        if (!existing) {
          const inserted = await trx
            .insertInto('chat.key_backups')
            .values({
              user_id: caller.userId,
              version: '1',
              algorithm: ALGORITHM,
              auth_data: JSON.stringify(authData),
            })
            .onConflict((oc) => oc.column('user_id').doNothing())
            .returningAll()
            .executeTakeFirst();
          if (!inserted) {
            // Lost a race with a parallel create.
            throw ProblemError.conflict('A key backup already exists', 'BACKUP_EXISTS');
          }
          return { status: 201, row: inserted };
        }
        if (!replace) {
          throw ProblemError.conflict('A key backup already exists', 'BACKUP_EXISTS');
        }
        await trx
          .deleteFrom('chat.key_backup_sessions')
          .where('user_id', '=', caller.userId)
          .execute();
        const updated = await trx
          .updateTable('chat.key_backups')
          .set({
            version: sql`version + 1`,
            algorithm: ALGORITHM,
            auth_data: JSON.stringify(authData),
            updated_at: new Date(),
          })
          .where('user_id', '=', caller.userId)
          .returningAll()
          .executeTakeFirstOrThrow();
        return { status: 200, row: updated };
      });

      request.log.info(
        { version: Number(result.row.version), replaced: result.status === 200 },
        'Key backup stored',
      );
      return reply.status(result.status).send(toKeyBackupDto(result.row, 0));
    },
  );

  // deleteKeyBackup: sessions cascade. Idempotent.
  fastify.delete('/v1/chat/key-backup', async (request, reply) => {
    const caller = requireAuth(request);
    await db.deleteFrom('chat.key_backups').where('user_id', '=', caller.userId).execute();
    return reply.status(204).send();
  });

  // putKeyBackupSessions: per (conversation, session) the key with the lowest first_message_index wins; a tie
  // replaces (newer upload).
  fastify.put<{ Body: { version?: unknown; sessions?: unknown } }>(
    '/v1/chat/key-backup/sessions',
    async (request, reply) => {
      const caller = requireAuth(request);
      const body = request.body ?? {};
      if (Object.keys(body).some((k) => k !== 'version' && k !== 'sessions')) {
        throw ProblemError.badRequest('Unknown field in request body', 'INVALID_BODY');
      }
      const version = parseVersion(body.version);
      if (
        !Array.isArray(body.sessions) ||
        body.sessions.length < 1 ||
        body.sessions.length > SESSIONS_PER_REQUEST
      ) {
        throw ProblemError.badRequest('sessions must hold 1 to 100 sessions', 'INVALID_SESSIONS');
      }
      const sessions = body.sessions.map(validateSession);
      const keys = new Set(sessions.map((x) => `${x.conversation_id}/${x.session_id}`));
      if (keys.size !== sessions.length) {
        throw ProblemError.badRequest(
          'A session appears twice in one request',
          'DUPLICATE_SESSION',
        );
      }

      if (rateLimiter) {
        await rateLimiter.consume({
          key: buildKeyBackupSessionsRateLimitKey(caller.userId),
          limit: 600,
          windowSeconds: 60,
          cost: sessions.length,
        });
      }

      const stored = await db.transaction().execute(async (trx) => {
        const backup = await trx
          .selectFrom('chat.key_backups')
          .select('version')
          .where('user_id', '=', caller.userId)
          .forUpdate()
          .executeTakeFirst();
        if (!backup) {
          throw ProblemError.notFound('No key backup', 'BACKUP_NOT_FOUND');
        }
        if (String(backup.version) !== version) {
          throw ProblemError.conflict('The backup version changed', 'BACKUP_VERSION_MISMATCH');
        }

        // The 50 000 cap counts rows after this upload: existing rows plus the genuinely new keys.
        const counts = await sql<{ total: string; existing: string }>`
          SELECT (SELECT count(*) FROM chat.key_backup_sessions WHERE user_id = ${caller.userId}::uuid) AS total,
                 (SELECT count(*) FROM chat.key_backup_sessions s
                  JOIN unnest(${sessions.map((x) => x.conversation_id)}::uuid[],
                              ${sessions.map((x) => x.session_id)}::text[]) AS n(conversation_id, session_id)
                    ON s.conversation_id = n.conversation_id AND s.session_id = n.session_id
                  WHERE s.user_id = ${caller.userId}::uuid) AS existing
        `.execute(trx);
        const row = counts.rows[0]!;
        if (Number(row.total) + sessions.length - Number(row.existing) > MAX_SESSIONS) {
          throw ProblemError.conflict(
            'The backup holds the maximum of 50 000 sessions',
            'BACKUP_FULL',
          );
        }

        const res = await sql`
          INSERT INTO chat.key_backup_sessions
            (user_id, conversation_id, session_id, first_message_index, ciphertext, updated_at)
          SELECT ${caller.userId}::uuid, n.conversation_id, n.session_id, n.first_message_index, n.ciphertext, now()
          FROM unnest(${sessions.map((x) => x.conversation_id)}::uuid[],
                      ${sessions.map((x) => x.session_id)}::text[],
                      ${sessions.map((x) => x.first_message_index)}::integer[],
                      ${sessions.map((x) => x.ciphertext)}::text[])
               AS n(conversation_id, session_id, first_message_index, ciphertext)
          ON CONFLICT (user_id, conversation_id, session_id) DO UPDATE
            SET first_message_index = EXCLUDED.first_message_index,
                ciphertext = EXCLUDED.ciphertext,
                updated_at = now()
            WHERE EXCLUDED.first_message_index <= chat.key_backup_sessions.first_message_index
        `.execute(trx);
        return Number(res.numAffectedRows ?? 0n);
      });

      return reply.status(200).send({ stored, kept: sessions.length - stored });
    },
  );

  // listKeyBackupSessions: keyset on (conversation_id, session_id), optional conversation filter.
  fastify.get<{
    Querystring: { version?: string; conversation_id?: string; cursor?: string; limit?: string };
  }>('/v1/chat/key-backup/sessions', async (request, reply) => {
    const caller = requireAuth(request);
    const version = parseVersion(request.query.version);
    const { conversation_id, cursor } = request.query;
    if (conversation_id !== undefined && !isValidUuid(conversation_id)) {
      throw ProblemError.badRequest('Invalid conversation_id', 'INVALID_CONVERSATION_ID');
    }
    let limit = 200;
    if (request.query.limit !== undefined) {
      limit = Number(request.query.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
        throw ProblemError.badRequest('limit must be an integer from 1 to 500', 'INVALID_LIMIT');
      }
    }
    let after: SessionsCursor | null = null;
    if (cursor) {
      after = decodeCursor<SessionsCursor>(cursor);
      if (!after || !isValidUuid(after.c) || typeof after.s !== 'string') {
        throw ProblemError.badRequest('Invalid pagination cursor', 'INVALID_CURSOR');
      }
    }

    const current = await loadVersion(caller.userId);
    if (current === null) {
      throw ProblemError.notFound('No key backup', 'BACKUP_NOT_FOUND');
    }
    if (current !== version) {
      throw ProblemError.conflict('The backup version changed', 'BACKUP_VERSION_MISMATCH');
    }

    let query = db
      .selectFrom('chat.key_backup_sessions')
      .select(['conversation_id', 'session_id', 'first_message_index', 'ciphertext'])
      .where('user_id', '=', caller.userId);
    if (conversation_id) query = query.where('conversation_id', '=', conversation_id);
    if (after) {
      const a = after;
      query = query.where((eb) =>
        eb.or([
          eb('conversation_id', '>', a.c),
          eb.and([eb('conversation_id', '=', a.c), eb('session_id', '>', a.s)]),
        ]),
      );
    }
    const rows = await query
      .orderBy('conversation_id')
      .orderBy('session_id')
      .limit(limit + 1)
      .execute();

    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return reply.status(200).send({
      items: page,
      next_cursor:
        rows.length > limit && last
          ? encodeCursor<SessionsCursor>({ c: last.conversation_id, s: last.session_id })
          : null,
    });
  });
};
