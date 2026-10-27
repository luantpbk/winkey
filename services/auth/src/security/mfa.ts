import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';

export interface MfaChallengeData {
  userId: string;
  firstFactor: 'pwd' | 'google';
}

export interface PendingTotpSetupData {
  userId: string;
  encryptedSecret: string;
  keyId: string;
}

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

export function generateMfaToken(): string {
  return randomBytes(32).toString('base64url');
}

export async function createMfaChallenge(
  redis: Redis | null | undefined,
  userId: string,
  firstFactor: 'pwd' | 'google',
): Promise<string> {
  const mfaToken = generateMfaToken();
  const key = `mfa:chal:${mfaToken}`;
  const attemptsKey = `mfa:chal:${mfaToken}:attempts`;
  const data: MfaChallengeData = {
    userId,
    firstFactor,
  };
  if (redis) {
    await redis.set(key, JSON.stringify(data), 'EX', 300); // 5 minutes
    await redis.del(attemptsKey);
  } else {
    setInMemory(key, JSON.stringify(data), 300);
    delFromMemory(attemptsKey);
  }
  return mfaToken;
}

export async function consumeMfaChallenge(
  redis: Redis | null | undefined,
  mfaToken: string,
): Promise<{ valid: boolean; data?: MfaChallengeData; exhausted?: boolean }> {
  const key = `mfa:chal:${mfaToken}`;
  const attemptsKey = `mfa:chal:${mfaToken}:attempts`;

  if (redis) {
    const result = (await redis.eval(ATTEMPTS_LUA, 2, key, attemptsKey, 5)) as [number, string];
    const [attempt, raw] = result;
    if (attempt === 0 || !raw) {
      return { valid: false };
    }
    if (attempt === -1) {
      return { valid: false, exhausted: true };
    }
    const data = JSON.parse(raw) as MfaChallengeData;
    return { valid: true, data };
  } else {
    const raw = getFromMemory(key);
    if (!raw) return { valid: false };
    const attempt = parseInt(getFromMemory(attemptsKey) || '0', 10) + 1;
    setInMemory(attemptsKey, String(attempt), 300);
    if (attempt > 5) {
      delFromMemory(key);
      delFromMemory(attemptsKey);
      return { valid: false, exhausted: true };
    }
    const data = JSON.parse(raw) as MfaChallengeData;
    return { valid: true, data };
  }
}

export async function deleteMfaChallenge(
  redis: Redis | null | undefined,
  mfaToken: string,
): Promise<void> {
  const key = `mfa:chal:${mfaToken}`;
  const attemptsKey = `mfa:chal:${mfaToken}:attempts`;
  if (redis) {
    await redis.del(key, attemptsKey);
  } else {
    delFromMemory(key);
    delFromMemory(attemptsKey);
  }
}

export async function storePendingTotpSetup(
  redis: Redis | null | undefined,
  setupId: string,
  userId: string,
  encryptedSecret: Buffer,
  keyId: string,
): Promise<void> {
  const key = `totp:setup:${setupId}`;
  const attemptsKey = `totp:setup:${setupId}:attempts`;
  const data: PendingTotpSetupData = {
    userId,
    encryptedSecret: encryptedSecret.toString('base64'),
    keyId,
  };
  if (redis) {
    await redis.set(key, JSON.stringify(data), 'EX', 600); // 10 minutes
    await redis.del(attemptsKey);
  } else {
    setInMemory(key, JSON.stringify(data), 600);
    delFromMemory(attemptsKey);
  }
}

export async function consumePendingTotpSetup(
  redis: Redis | null | undefined,
  setupId: string,
): Promise<{ valid: boolean; data?: PendingTotpSetupData; exhausted?: boolean }> {
  const key = `totp:setup:${setupId}`;
  const attemptsKey = `totp:setup:${setupId}:attempts`;

  if (redis) {
    const result = (await redis.eval(ATTEMPTS_LUA, 2, key, attemptsKey, 5)) as [number, string];
    const [attempt, raw] = result;
    if (attempt === 0 || !raw) {
      return { valid: false };
    }
    if (attempt === -1) {
      return { valid: false, exhausted: true };
    }
    const data = JSON.parse(raw) as PendingTotpSetupData;
    return { valid: true, data };
  } else {
    const raw = getFromMemory(key);
    if (!raw) return { valid: false };
    const attempt = parseInt(getFromMemory(attemptsKey) || '0', 10) + 1;
    setInMemory(attemptsKey, String(attempt), 600);
    if (attempt > 5) {
      delFromMemory(key);
      delFromMemory(attemptsKey);
      return { valid: false, exhausted: true };
    }
    const data = JSON.parse(raw) as PendingTotpSetupData;
    return { valid: true, data };
  }
}

export async function deletePendingTotpSetup(
  redis: Redis | null | undefined,
  setupId: string,
): Promise<void> {
  const key = `totp:setup:${setupId}`;
  const attemptsKey = `totp:setup:${setupId}:attempts`;
  if (redis) {
    await redis.del(key, attemptsKey);
  } else {
    delFromMemory(key);
    delFromMemory(attemptsKey);
  }
}

// Failed login counter for Captcha trigger (>= 3 failed attempts in 15 minutes)
export async function recordFailedLoginAttempt(
  redis: Redis | null | undefined,
  clientIp: string,
  email: string,
): Promise<void> {
  const ipKey = `fail:login:ip:${clientIp}`;
  const emailKey = `fail:login:email:${email.toLowerCase().trim()}`;
  if (redis) {
    const p = redis.pipeline();
    p.incr(ipKey);
    p.expire(ipKey, 900); // 15 minutes
    p.incr(emailKey);
    p.expire(emailKey, 900);
    await p.exec();
  } else {
    const currentIp = parseInt(getFromMemory(ipKey) || '0', 10) + 1;
    const currentEmail = parseInt(getFromMemory(emailKey) || '0', 10) + 1;
    setInMemory(ipKey, String(currentIp), 900);
    setInMemory(emailKey, String(currentEmail), 900);
  }
}

export async function getFailedLoginAttempts(
  redis: Redis | null | undefined,
  clientIp: string,
  email: string,
): Promise<number> {
  const ipKey = `fail:login:ip:${clientIp}`;
  const emailKey = `fail:login:email:${email.toLowerCase().trim()}`;
  if (redis) {
    const [ipCountStr, emailCountStr] = await Promise.all([redis.get(ipKey), redis.get(emailKey)]);
    const ipCount = parseInt(ipCountStr || '0', 10);
    const emailCount = parseInt(emailCountStr || '0', 10);
    return Math.max(ipCount, emailCount);
  } else {
    const ipCount = parseInt(getFromMemory(ipKey) || '0', 10);
    const emailCount = parseInt(getFromMemory(emailKey) || '0', 10);
    return Math.max(ipCount, emailCount);
  }
}

export async function clearFailedLoginAttempts(
  redis: Redis | null | undefined,
  clientIp: string,
  email: string,
): Promise<void> {
  const ipKey = `fail:login:ip:${clientIp}`;
  const emailKey = `fail:login:email:${email.toLowerCase().trim()}`;
  if (redis) {
    await redis.del(ipKey, emailKey);
  } else {
    delFromMemory(ipKey);
    delFromMemory(emailKey);
  }
}
