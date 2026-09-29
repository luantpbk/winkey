import crypto from 'node:crypto';
import type { Redis } from 'ioredis';
import { ProblemError } from '../errors/problem.js';

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

  constructor(redis?: Redis | null) {
    this.redis = redis ?? null;
  }

  private hashTicket(ticket: string): string {
    return crypto.createHash('sha256').update(ticket).digest('hex');
  }

  async issueTicket(user_id: string, roles: string[] = []): Promise<IssuedTicket> {
    if (!this.redis || this.redis.status !== 'ready') {
      throw ProblemError.serviceUnavailable('Valkey is unavailable');
    }

    const rawBytes = crypto.randomBytes(32); // 256 bits
    const ticket = rawBytes.toString('base64url');
    const hash = this.hashTicket(ticket);
    const ttlSeconds = 30;
    const expiresAtMs = Date.now() + ttlSeconds * 1000;
    const expires_at = new Date(expiresAtMs).toISOString();

    const payload: TicketPayload = { user_id, roles };
    const payloadJson = JSON.stringify(payload);

    try {
      await this.redis.set(`rt:ticket:${hash}`, payloadJson, 'EX', ttlSeconds);
      return { ticket, expires_at };
    } catch {
      throw ProblemError.serviceUnavailable('Valkey write failed');
    }
  }

  async redeemTicket(ticket: string): Promise<TicketPayload | null> {
    if (!ticket || ticket.length < 32 || ticket.length > 128) {
      return null;
    }

    if (!this.redis || this.redis.status !== 'ready') {
      throw ProblemError.serviceUnavailable('Valkey is unavailable');
    }

    const hash = this.hashTicket(ticket);

    try {
      // Atomic single-use redemption with GETDEL (Redis / Valkey >= 6.2)
      const raw = await this.redis.getdel(`rt:ticket:${hash}`);
      if (!raw) {
        return null;
      }
      return JSON.parse(raw) as TicketPayload;
    } catch (err) {
      if (err instanceof ProblemError) throw err;
      throw ProblemError.serviceUnavailable('Valkey operation failed');
    }
  }

  async close(): Promise<void> {
    if (this.redis) {
      await this.redis.quit().catch(() => {});
    }
  }
}
