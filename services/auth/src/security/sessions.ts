import type { Kysely } from 'kysely';
import type { Database, SessionRevokeReason } from '../db/types.js';
import type { Redis } from 'ioredis';
import type { FastifyRequest } from 'fastify';
import type { Env } from '../config/env.js';

export interface CreateSessionOptions {
  id: string; // familyId
  userId: string;
  deviceLabel: string | null;
  country: string | null;
  ipHash: Buffer | null;
  amr: string[];
}

export function extractCountry(request: FastifyRequest, env: Env): string | null {
  const headerName = (env.TRUSTED_COUNTRY_HEADER || 'CF-IPCountry').toLowerCase();
  const val = request.headers[headerName];
  if (typeof val === 'string') {
    const trimmed = val.trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(trimmed)) {
      return trimmed;
    }
  }
  return null;
}

export async function createSession(
  db: Kysely<Database>,
  options: CreateSessionOptions,
): Promise<void> {
  await db
    .insertInto('auth.sessions')
    .values({
      id: options.id,
      user_id: options.userId,
      device_label: options.deviceLabel,
      country: options.country,
      ip_hash: options.ipHash,
      amr: options.amr,
      created_at: new Date(),
      last_used_at: new Date(),
      step_up_at: null,
      revoked_at: null,
      revoke_reason: null,
    })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
}

export async function touchSession(
  db: Kysely<Database>,
  redis: Redis | null | undefined,
  sessionId: string,
): Promise<void> {
  if (redis) {
    const key = `sess:touch:${sessionId}`;
    const acquired = await redis.set(key, '1', 'EX', 60, 'NX');
    if (!acquired) {
      return; // Throttled: touched within the last 60s
    }
  }

  await db
    .updateTable('auth.sessions')
    .set({
      last_used_at: new Date(),
    })
    .where('id', '=', sessionId)
    .where('revoked_at', 'is', null)
    .execute();
}

async function runInTransaction<T>(
  db: Kysely<Database>,
  fn: (trx: Kysely<Database>) => Promise<T>,
): Promise<T> {
  if ('isTransaction' in db && (db as any).isTransaction) {
    return fn(db);
  }
  return db.transaction().execute(fn);
}

export async function revokeSession(
  db: Kysely<Database>,
  redis: Redis | null | undefined,
  sessionId: string,
  reason: SessionRevokeReason,
): Promise<boolean> {
  const now = new Date();

  const result = await runInTransaction(db, async (trx) => {
    const updated = await trx
      .updateTable('auth.sessions')
      .set({
        revoked_at: now,
        revoke_reason: reason,
      })
      .where('id', '=', sessionId)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();

    await trx
      .updateTable('auth.refresh_tokens')
      .set({
        revoked_at: now,
      })
      .where('family_id', '=', sessionId)
      .where('revoked_at', 'is', null)
      .execute();

    return (updated.numUpdatedRows ?? 0n) > 0n;
  });

  if (result && redis) {
    // 30 days blacklist in Valkey
    await redis.set(`revoked:sid:${sessionId}`, '1', 'EX', 30 * 86400);
  }

  return result;
}

export async function revokeOtherSessions(
  db: Kysely<Database>,
  redis: Redis | null | undefined,
  userId: string,
  currentSessionId: string,
  reason: SessionRevokeReason,
): Promise<number> {
  const now = new Date();

  const revokedSessionIds = await runInTransaction(db, async (trx) => {
    const rows = await trx
      .selectFrom('auth.sessions')
      .select('id')
      .where('user_id', '=', userId)
      .where('id', '!=', currentSessionId)
      .where('revoked_at', 'is', null)
      .execute();

    if (rows.length === 0) return [];

    await trx
      .updateTable('auth.sessions')
      .set({
        revoked_at: now,
        revoke_reason: reason,
      })
      .where('user_id', '=', userId)
      .where('id', '!=', currentSessionId)
      .where('revoked_at', 'is', null)
      .execute();

    for (const row of rows) {
      await trx
        .updateTable('auth.refresh_tokens')
        .set({
          revoked_at: now,
        })
        .where('family_id', '=', row.id)
        .where('revoked_at', 'is', null)
        .execute();
    }

    return rows.map((r) => r.id);
  });

  if (redis && revokedSessionIds.length > 0) {
    const pipeline = redis.pipeline();
    for (const sid of revokedSessionIds) {
      pipeline.set(`revoked:sid:${sid}`, '1', 'EX', 30 * 86400);
    }
    await pipeline.exec();
  }

  return revokedSessionIds.length;
}

export async function revokeAllSessionsForUser(
  db: Kysely<Database>,
  redis: Redis | null | undefined,
  userId: string,
  reason: SessionRevokeReason,
): Promise<number> {
  const now = new Date();

  const revokedSessionIds = await runInTransaction(db, async (trx) => {
    const rows = await trx
      .selectFrom('auth.sessions')
      .select('id')
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null)
      .execute();

    if (rows.length === 0) return [];

    await trx
      .updateTable('auth.sessions')
      .set({
        revoked_at: now,
        revoke_reason: reason,
      })
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null)
      .execute();

    await trx
      .updateTable('auth.refresh_tokens')
      .set({
        revoked_at: now,
      })
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null)
      .execute();

    return rows.map((r) => r.id);
  });

  if (redis && revokedSessionIds.length > 0) {
    const pipeline = redis.pipeline();
    for (const sid of revokedSessionIds) {
      pipeline.set(`revoked:sid:${sid}`, '1', 'EX', 30 * 86400);
    }
    await pipeline.exec();
  }

  return revokedSessionIds.length;
}

export async function cleanupExpiredSessionsAndEvents(db: Kysely<Database>): Promise<{
  sessionsPurged: number;
  eventsPurged: number;
}> {
  const ninetyDaysAgo = new Date(Date.now() - 90 * 86400 * 1000);
  const oneYearAgo = new Date(Date.now() - 365 * 86400 * 1000);

  const sessRes = await db
    .deleteFrom('auth.sessions')
    .where('revoked_at', 'is not', null)
    .where('revoked_at', '<', ninetyDaysAgo)
    .executeTakeFirst();

  const eventsRes = await db
    .deleteFrom('auth.security_events')
    .where('created_at', '<', oneYearAgo)
    .executeTakeFirst();

  return {
    sessionsPurged: Number(sessRes.numDeletedRows ?? 0n),
    eventsPurged: Number(eventsRes.numDeletedRows ?? 0n),
  };
}
