import { describe, it, expect, vi } from 'vitest';
import { enqueue } from '../src/enqueue.js';
import { Kysely, PostgresDialect } from 'kysely';

describe('enqueue', () => {
  it('throws an error for unsafe or invalid schema names not matching ^[a-z_][a-z0-9_]*$', async () => {
    const mockTx = { query: vi.fn() };
    const invalidSchemas = [
      'auth; DROP TABLE users;',
      '123auth', // starts with digit
      'Auth', // uppercase
      'AUTH', // uppercase
      'auth-svc', // hyphen
      'auth.svc', // dot
      '',
    ];

    for (const schema of invalidSchemas) {
      await expect(enqueue(mockTx, schema, 'user.registered', {})).rejects.toThrow(
        'Invalid schema identifier',
      );
    }
  });

  it('inserts into outbox table using pg client query', async () => {
    const mockTx = {
      query: vi.fn().mockResolvedValue({ rowCount: 1 }),
    };

    const envelope = await enqueue(
      mockTx,
      'auth',
      'user.registered',
      { user_id: '123' },
      {
        producer: 'auth-svc',
      },
    );

    expect(mockTx.query).toHaveBeenCalledTimes(1);
    const [query, params] = mockTx.query.mock.calls[0];
    expect(query).toContain('INSERT INTO "auth"."outbox"');
    expect(params[0]).toBe(envelope.event_id);
    expect(params[1]).toBe('user.registered');
    expect(JSON.parse(params[2])).toEqual(envelope);
  });

  it('inserts into outbox table using Kysely executor', async () => {
    const mockClient = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    };
    const mockPool = {
      connect: vi.fn().mockResolvedValue(mockClient),
    };
    const db = new Kysely<any>({
      dialect: new PostgresDialect({
        pool: mockPool as any,
      }),
    });

    const envelope = await enqueue(db, 'auth', 'user.registered', { user_id: '123' });

    expect(mockClient.query).toHaveBeenCalledTimes(1);
    const [sqlQuery, params] = mockClient.query.mock.calls[0];
    expect(sqlQuery).toContain('INSERT INTO "auth"."outbox"');
    expect(params[0]).toBe(envelope.event_id);
    expect(params[1]).toBe('user.registered');
  });

  it('rejects unsupported transaction objects', async () => {
    await expect(enqueue({} as any, 'auth', 'user.registered', {})).rejects.toThrow(TypeError);
  });
});
