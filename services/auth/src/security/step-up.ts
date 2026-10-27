import { createHash, randomInt } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import type { Redis } from 'ioredis';
import { ProblemError } from '../errors/problem.js';

export const STEP_UP_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

const memoryStore = new Map<string, { value: string; expiresAt: number }>();

function getFromMemory(key: string): string | null {
  const item = memoryStore.get(key);
  if (!item) return null;
  if (Date.now() > item.expiresAt) {
    memoryStore.delete(key);
    return null;
  }
  return item.value;
}

function setInMemory(key: string, value: string, ttlSeconds: number): void {
  memoryStore.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
}

function delFromMemory(key: string): void {
  memoryStore.delete(key);
}

export async function assertStepUp(db: Kysely<Database>, sessionId: string): Promise<Date> {
  const session = await db
    .selectFrom('auth.sessions')
    .select(['id', 'step_up_at', 'revoked_at'])
    .where('id', '=', sessionId)
    .executeTakeFirst();

  if (!session || session.revoked_at || !session.step_up_at) {
    throw ProblemError.forbidden('Step-up authentication required', 'STEP_UP_REQUIRED');
  }

  const stepUpTime = new Date(session.step_up_at).getTime();
  const elapsed = Date.now() - stepUpTime;

  if (elapsed < 0 || elapsed > STEP_UP_WINDOW_MS) {
    throw ProblemError.forbidden('Step-up authentication required', 'STEP_UP_REQUIRED');
  }

  return new Date(stepUpTime + STEP_UP_WINDOW_MS);
}

export async function sendStepUpEmailCode(
  db: Kysely<Database>,
  redis: Redis | null | undefined,
  sessionId: string,
  userId: string,
  email: string,
): Promise<void> {
  const rateKey = `stepup:email:rate:${sessionId}`;
  if (redis) {
    const count = await redis.incr(rateKey);
    if (count === 1) {
      await redis.expire(rateKey, 600); // 10 minutes
    }
    if (count > 3) {
      throw ProblemError.tooManyRequests(600, 'Too many step-up email code requests');
    }
  } else {
    const count = parseInt(getFromMemory(rateKey) || '0', 10) + 1;
    if (count > 3) {
      throw ProblemError.tooManyRequests(600, 'Too many step-up email code requests');
    }
    setInMemory(rateKey, String(count), 600);
  }

  const code = randomInt(100000, 1000000).toString();
  const codeHash = createHash('sha256').update(code).digest('hex');

  const storeKey = `stepup:email:${sessionId}`;
  if (redis) {
    await redis.set(
      storeKey,
      JSON.stringify({ codeHash, attempts: 0 }),
      'EX',
      600, // 10 minutes
    );
  } else {
    setInMemory(storeKey, JSON.stringify({ codeHash, attempts: 0 }), 600);
  }

  // Queue email with 6-digit code
  await db
    .insertInto('auth.mail_queue')
    .values({
      user_id: userId,
      to_email: email,
      template: 'VERIFY_EMAIL',
      locale: 'vi',
      params: JSON.stringify({
        code,
        purpose: 'step_up',
      }),
      attempts: 0,
      next_attempt_at: new Date(),
      created_at: new Date(),
      sent_at: null,
      dead_at: null,
      last_error: null,
    })
    .execute();
}

export async function verifyStepUpEmailCode(
  redis: Redis | null | undefined,
  sessionId: string,
  inputCode: string,
): Promise<boolean> {
  const storeKey = `stepup:email:${sessionId}`;
  const dataStr = redis ? await redis.get(storeKey) : getFromMemory(storeKey);
  if (!dataStr) {
    return false;
  }

  const data = JSON.parse(dataStr) as { codeHash: string; attempts: number };
  if (data.attempts >= 5) {
    if (redis) await redis.del(storeKey);
    else delFromMemory(storeKey);
    return false;
  }

  const inputHash = createHash('sha256').update(inputCode.trim()).digest('hex');
  if (inputHash === data.codeHash) {
    if (redis) await redis.del(storeKey);
    else delFromMemory(storeKey);
    return true;
  }

  data.attempts += 1;
  if (data.attempts >= 5) {
    if (redis) await redis.del(storeKey);
    else delFromMemory(storeKey);
  } else {
    if (redis) {
      const ttl = await redis.ttl(storeKey);
      if (ttl > 0) {
        await redis.set(storeKey, JSON.stringify(data), 'EX', ttl);
      }
    } else {
      setInMemory(storeKey, JSON.stringify(data), 600);
    }
  }

  return false;
}
