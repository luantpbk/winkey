import { describe, it, expect, vi } from 'vitest';
import { OutboxRelay } from '../src/relay.js';

describe('OutboxRelay', () => {
  it('polls pending rows, publishes with Nats-Msg-Id header, and marks published', async () => {
    const publishedRows: any[] = [];
    const mockJetStream = {
      publish: vi.fn().mockImplementation(async (subj, payload, opts) => {
        publishedRows.push({ subj, payload, headers: opts?.headers });
        return { seq: 1 };
      }),
    };
    const mockNats = {
      jetstream: () => mockJetStream,
    };

    const mockRows = [
      {
        id: '1',
        event_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c01',
        subject: 'user.registered',
        payload: { event_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c01', data: { user_id: 'u1' } },
      },
      {
        id: '2',
        event_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c02',
        subject: 'user.registered',
        payload: JSON.stringify({ event_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c02', data: { user_id: 'u2' } }),
      },
    ];

    const clientQueries: string[] = [];
    const mockClient = {
      query: vi.fn().mockImplementation(async (sql, params) => {
        clientQueries.push(sql);
        if (sql.includes('SELECT')) {
          return { rows: mockRows };
        }
        if (sql.includes('UPDATE')) {
          return { rowCount: mockRows.length };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };

    const mockPool = {
      connect: vi.fn().mockResolvedValue(mockClient),
    };

    const relay = new OutboxRelay({
      db: mockPool,
      natsConnection: mockNats,
      schema: 'auth',
      batchSize: 100,
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    });

    const processed = await relay.processBatch();
    expect(processed).toBe(2);
    expect(mockJetStream.publish).toHaveBeenCalledTimes(2);

    // Verify Nats-Msg-Id header
    const firstCallHeaders = mockJetStream.publish.mock.calls[0][2].headers;
    expect(firstCallHeaders.get('Nats-Msg-Id')).toBe('0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c01');

    const secondCallHeaders = mockJetStream.publish.mock.calls[1][2].headers;
    expect(secondCallHeaders.get('Nats-Msg-Id')).toBe('0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c02');

    // Verify markRowsPublished was called with IDs
    const updateCall = mockClient.query.mock.calls.find((call) =>
      typeof call[0] === 'string' && call[0].trim().startsWith('UPDATE')
    );
    expect(updateCall).toBeDefined();
    expect(updateCall[1][0]).toEqual(['1', '2']);
  });

  it('cleans up published rows older than specified days', async () => {
    const mockPool = {
      query: vi.fn().mockResolvedValue({ rowCount: 42 }),
    };

    const relay = new OutboxRelay({
      db: mockPool,
      natsConnection: {} as any,
      schema: 'auth',
      cleanupMaxAgeDays: 7,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });

    const deleted = await relay.cleanupOldPublishedRows();
    expect(deleted).toBe(42);
    expect(mockPool.query).toHaveBeenCalledTimes(1);
    const [sqlQuery, params] = mockPool.query.mock.calls[0];
    expect(sqlQuery).toContain('DELETE FROM "auth"."outbox"');
    expect(params[0]).toBe(7);
  });
});
