import { describe, it, expect } from 'vitest';
import { TicketStore } from '../../src/tickets/ticket-store.js';

describe('TicketStore', () => {
  it('issues a single-use ticket and redeems it once', async () => {
    const store = new TicketStore();
    const userId = '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c01';
    const roles = ['viewer', 'creator'];

    const issued = await store.issueTicket(userId, roles);

    expect(issued.ticket).toBeDefined();
    expect(issued.ticket.length).toBeGreaterThanOrEqual(32);
    expect(issued.ticket.length).toBeLessThanOrEqual(128);
    expect(issued.expires_at).toBeDefined();

    // 1st redemption succeeds
    const redeemed = await store.redeemTicket(issued.ticket);
    expect(redeemed).toEqual({
      user_id: userId,
      roles,
    });

    // 2nd redemption with same ticket fails (single use)
    const secondRedemption = await store.redeemTicket(issued.ticket);
    expect(secondRedemption).toBeNull();
  });

  it('rejects invalid or unknown ticket strings', async () => {
    const store = new TicketStore();

    expect(await store.redeemTicket('')).toBeNull();
    expect(await store.redeemTicket('short')).toBeNull();
    expect(await store.redeemTicket('a'.repeat(200))).toBeNull();
    expect(await store.redeemTicket('non-existent-ticket-32-chars-long-1234567890')).toBeNull();
  });
});
