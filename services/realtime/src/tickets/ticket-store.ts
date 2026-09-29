import crypto from 'node:crypto';
import { Redis } from 'ioredis';

export interface TicketPayload {
  user_id: string;
  roles: string[];
}

export interface IssuedTicket {
  ticket: string;
  expires_at: string;
}

export class TicketStore {
  private readonly redis: Redis | null;
  private readonly memoryStore = new Map<string, { payload: TicketPayload; expiresAt: number }>();

  constructor(valkeyUrl?: string, customRedis?: Redis | null) {
    if (customRedis) {
      this.redis = customRedis;
    } else if (valkeyUrl) {
      try {
        this.redis = new Redis(valkeyUrl, {
          lazyConnect: true,
          maxRetriesPerRequest: 1,
          enableOfflineQueue: false,
        });
      } catch {
        this.redis = null;
      }
    } else {
      this.redis = null;
    }
  }

  private hashTicket(ticket: string): string {
    return crypto.createHash('sha256').update(ticket).digest('hex');
  }

  async issueTicket(user_id: string, roles: string[] = []): Promise<IssuedTicket> {
    const rawBytes = crypto.randomBytes(32); // 256 bits
    const ticket = rawBytes.toString('base64url');
    const hash = this.hashTicket(ticket);
    const ttlSeconds = 30;
    const expiresAtMs = Date.now() + ttlSeconds * 1000;
    const expires_at = new Date(expiresAtMs).toISOString();

    const payload: TicketPayload = { user_id, roles };
    const payloadJson = JSON.stringify(payload);

    if (this.redis && this.redis.status === 'ready') {
      try {
        await this.redis.set(`rt:ticket:${hash}`, payloadJson, 'EX', ttlSeconds);
        return { ticket, expires_at };
      } catch {
        // Fallback to memory store if Redis write fails
      }
    }

    this.memoryStore.set(hash, {
      payload,
      expiresAt: expiresAtMs,
    });

    return { ticket, expires_at };
  }

  async redeemTicket(ticket: string): Promise<TicketPayload | null> {
    if (!ticket || ticket.length < 32 || ticket.length > 128) {
      return null;
    }

    const hash = this.hashTicket(ticket);

    if (this.redis && this.redis.status === 'ready') {
      try {
        // Atomic single-use redemption with GETDEL (Redis / Valkey >= 6.2)
        const raw = await this.redis.getdel(`rt:ticket:${hash}`);
        if (!raw) {
          return null;
        }
        return JSON.parse(raw) as TicketPayload;
      } catch {
        // Fallback to memory store if Redis call fails
      }
    }

    const entry = this.memoryStore.get(hash);
    if (!entry) {
      return null;
    }

    this.memoryStore.delete(hash);

    if (Date.now() > entry.expiresAt) {
      return null;
    }

    return entry.payload;
  }

  async close(): Promise<void> {
    if (this.redis) {
      await this.redis.quit().catch(() => {});
    }
  }
}
