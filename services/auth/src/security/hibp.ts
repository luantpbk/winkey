import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';

export async function isPasswordBreached(
  password: string,
  redis?: Redis | null,
  enabled = true,
): Promise<boolean> {
  if (!enabled) return false;

  const sha1 = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);
  const cacheKey = `hibp:range:${prefix}`;

  try {
    let body: string | null = null;
    if (redis) {
      body = await redis.get(cacheKey);
    }

    if (!body) {
      const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
        headers: {
          'Add-Padding': 'true',
          'User-Agent': 'Winkey-Auth-Breach-Check',
        },
        signal: AbortSignal.timeout(1500),
      });

      if (!res.ok) {
        return false; // Fail open
      }

      body = await res.text();
      if (redis) {
        await redis.set(cacheKey, body, 'EX', 86400); // 24h
      }
    }

    const lines = body.split(/\r?\n/);
    for (const line of lines) {
      const [hashSuffix, countStr] = line.split(':');
      if (hashSuffix && hashSuffix.trim().toUpperCase() === suffix) {
        const count = parseInt(countStr || '0', 10);
        if (count > 0) {
          return true;
        }
      }
    }

    return false;
  } catch {
    // Fail open on network errors or timeouts
    return false;
  }
}
