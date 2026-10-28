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

const ATTEMPTS_LUA = `
local key = KEYS[1]
local attemptsKey = KEYS[2]
local maxAttempts = tonumber(ARGV[1])

local raw = redis.call('GET', key)
if not raw then
  return {0, ''}
end

local attempt = redis.call('INCR', attemptsKey)
if attempt == 1 then
  local ttl = redis.call('TTL', key)
  if ttl > 0 then
    redis.call('EXPIRE', attemptsKey, ttl)
  end
end

if attempt > maxAttempts then
  redis.call('DEL', key)
  redis.call('DEL', attemptsKey)
  return {-1, ''}
end

return {attempt, raw}
`;

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
  const attemptsKey = `stepup:email:${sessionId}:attempts`;
  if (redis) {
    await redis.set(
      storeKey,
      JSON.stringify({ codeHash }),
      'EX',
      600, // 10 minutes
    );
    await redis.del(attemptsKey);
  } else {
    setInMemory(storeKey, JSON.stringify({ codeHash }), 600);
    delFromMemory(attemptsKey);
  }

  // Queue email with 6-digit code
  await db
    .insertInto('auth.mail_queue')
    .values({
      user_id: userId,
      to_email: email,
      template: 'STEP_UP_CODE',
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
  const attemptsKey = `stepup:email:${sessionId}:attempts`;

  let raw: string | null = null;
  if (redis) {
    const result = (await redis.eval(ATTEMPTS_LUA, 2, storeKey, attemptsKey, 5)) as [
      number,
      string,
    ];
    const [attempt, dataStr] = result;
    if (attempt <= 0 || !dataStr) {
      return false;
    }
    raw = dataStr;
  } else {
    const dataStr = getFromMemory(storeKey);
    if (!dataStr) return false;
    const attempt = parseInt(getFromMemory(attemptsKey) || '0', 10) + 1;
    setInMemory(attemptsKey, String(attempt), 600);
    if (attempt > 5) {
      delFromMemory(storeKey);
      delFromMemory(attemptsKey);
      return false;
    }
    raw = dataStr;
  }

  const data = JSON.parse(raw) as { codeHash: string };
  const inputHash = createHash('sha256').update(inputCode.trim()).digest('hex');
  if (inputHash === data.codeHash) {
    if (redis) {
      await redis.del(storeKey, attemptsKey);
    } else {
      delFromMemory(storeKey);
      delFromMemory(attemptsKey);
    }
    return true;
  }

  return false;
}
