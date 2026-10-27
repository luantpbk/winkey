import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';

export interface MfaChallengeData {
  userId: string;
  firstFactor: 'pwd' | 'google';
  attempts: number;
}

export interface PendingTotpSetupData {
  userId: string;
  secret: string;
  attempts: number;
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
  const data: MfaChallengeData = {
    userId,
    firstFactor,
    attempts: 0,
  };
  if (redis) {
    await redis.set(key, JSON.stringify(data), 'EX', 300); // 5 minutes
  } else {
    setInMemory(key, JSON.stringify(data), 300);
  }
  return mfaToken;
}

export async function consumeMfaChallenge(
  redis: Redis | null | undefined,
  mfaToken: string,
): Promise<{ valid: boolean; data?: MfaChallengeData; exhausted?: boolean }> {
  const key = `mfa:chal:${mfaToken}`;
  const raw = redis ? await redis.get(key) : getFromMemory(key);
  if (!raw) {
    return { valid: false };
  }

  const data = JSON.parse(raw) as MfaChallengeData;
  if (data.attempts >= 5) {
    if (redis) await redis.del(key);
    else delFromMemory(key);
    return { valid: false, exhausted: true };
  }

  data.attempts += 1;
  if (data.attempts >= 5) {
    if (redis) await redis.del(key);
    else delFromMemory(key);
  } else {
    if (redis) {
      const ttl = await redis.ttl(key);
      if (ttl > 0) {
        await redis.set(key, JSON.stringify(data), 'EX', ttl);
      }
    } else {
      setInMemory(key, JSON.stringify(data), 300);
    }
  }

  return { valid: true, data };
}

export async function deleteMfaChallenge(
  redis: Redis | null | undefined,
  mfaToken: string,
): Promise<void> {
  const key = `mfa:chal:${mfaToken}`;
  if (redis) {
    await redis.del(key);
  } else {
    delFromMemory(key);
  }
}

export async function storePendingTotpSetup(
  redis: Redis | null | undefined,
  setupId: string,
  userId: string,
  secret: string,
): Promise<void> {
  const key = `totp:setup:${setupId}`;
  const data: PendingTotpSetupData = {
    userId,
    secret,
    attempts: 0,
  };
  if (redis) {
    await redis.set(key, JSON.stringify(data), 'EX', 600); // 10 minutes
  } else {
    setInMemory(key, JSON.stringify(data), 600);
  }
}

export async function consumePendingTotpSetup(
  redis: Redis | null | undefined,
  setupId: string,
): Promise<{ valid: boolean; data?: PendingTotpSetupData; exhausted?: boolean }> {
  const key = `totp:setup:${setupId}`;
  const raw = redis ? await redis.get(key) : getFromMemory(key);
  if (!raw) {
    return { valid: false };
  }

  const data = JSON.parse(raw) as PendingTotpSetupData;
  if (data.attempts >= 5) {
    if (redis) await redis.del(key);
    else delFromMemory(key);
    return { valid: false, exhausted: true };
  }

  data.attempts += 1;
  if (data.attempts >= 5) {
    if (redis) await redis.del(key);
    else delFromMemory(key);
  } else {
    if (redis) {
      const ttl = await redis.ttl(key);
      if (ttl > 0) {
        await redis.set(key, JSON.stringify(data), 'EX', ttl);
      }
    } else {
      setInMemory(key, JSON.stringify(data), 600);
    }
  }

  return { valid: true, data };
}

export async function deletePendingTotpSetup(
  redis: Redis | null | undefined,
  setupId: string,
): Promise<void> {
  const key = `totp:setup:${setupId}`;
  if (redis) {
    await redis.del(key);
  } else {
    delFromMemory(key);
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
