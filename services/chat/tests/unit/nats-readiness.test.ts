import { describe, it, expect, vi } from 'vitest';
import fastify from 'fastify';
import { healthRoute } from '../../src/routes/health.js';
import { ManagedNatsConnection } from '../../src/realtime/nats-manager.js';
import { buildApp } from '../../src/server.js';
import { createMockDb, createMockStore } from '../fixtures/mock-db.js';
import type { NatsConnection, Status } from 'nats';
import pino from 'pino';

const silentLogger = pino({ level: 'silent' });

describe('NATS Readiness and Recovery (/readyz)', () => {
  it('returns 503 with nats: "disconnected" when NATS is configured but not connected', async () => {
    const app = fastify();
    await app.register(healthRoute, {
      natsConfigured: true,
      natsConnection: null,
      getNatsStatus: () => 'disconnected',
    });

    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.status).toBe('not_ready');
    expect(body.checks.nats).toBe('disconnected');
  });

  it('returns 503 with nats: "disconnected" when natsConfigured is true and no natsConnection or getter is provided', async () => {
    const app = fastify();
    await app.register(healthRoute, {
      natsConfigured: true,
    });

    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.status).toBe('not_ready');
    expect(body.checks.nats).toBe('disconnected');
  });

  it('returns 200 with nats: "skipped" when NATS is not configured', async () => {
    const app = fastify();
    await app.register(healthRoute, {
      natsConfigured: false,
    });

    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ready');
    expect(body.checks.nats).toBe('skipped');
  });

  it('always returns 200 on /healthz even when NATS is disconnected', async () => {
    const app = fastify();
    await app.register(healthRoute, {
      natsConfigured: true,
      getNatsStatus: () => 'disconnected',
    });

    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('transitions /readyz from 503 to 200 after NATS reconnects', async () => {
    let natsState: 'ok' | 'disconnected' | 'skipped' = 'disconnected';

    const app = fastify();
    await app.register(healthRoute, {
      natsConfigured: true,
      getNatsStatus: () => natsState,
    });

    // 1. Initial state: NATS down at boot -> 503
    const res1 = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res1.statusCode).toBe(503);
    expect(res1.json().checks.nats).toBe('disconnected');

    // 2. Reconnected -> 200
    natsState = 'ok';
    const res2 = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res2.statusCode).toBe(200);
    expect(res2.json().checks.nats).toBe('ok');

    // 3. Transient disconnect -> 503
    natsState = 'disconnected';
    const res3 = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res3.statusCode).toBe(503);
    expect(res3.json().checks.nats).toBe('disconnected');
  });

  describe('ManagedNatsConnection lifecycle', () => {
    function createMockAsyncIterator<T>() {
      const items: T[] = [];
      let resolveNext: ((value: IteratorResult<T>) => void) | null = null;
      let isDone = false;

      const push = (item: T) => {
        if (resolveNext) {
          const r = resolveNext;
          resolveNext = null;
          r({ value: item, done: false });
        } else {
          items.push(item);
        }
      };

      const close = () => {
        isDone = true;
        if (resolveNext) {
          const r = resolveNext;
          resolveNext = null;
          r({ value: undefined as unknown as T, done: true });
        }
      };

      const iterator: AsyncIterable<T> = {
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<T>> {
              if (items.length > 0) {
                return { value: items.shift()!, done: false };
              }
              if (isDone) {
                return { value: undefined as unknown as T, done: true };
              }
              return new Promise<IteratorResult<T>>((resolve) => {
                resolveNext = resolve;
              });
            },
          };
        },
      };

      return { push, close, iterator };
    }

    it('passes waitOnFirstConnect: true, reconnect: true, maxReconnectAttempts: -1 to connect', async () => {
      let passedOpts: unknown = null;
      const statusIter = createMockAsyncIterator<Status>();
      let closedResolve!: (err?: void | Error) => void;
      const closedPromise = new Promise<void>((resolve) => {
        closedResolve = () => resolve();
      });

      const mockConn = {
        isClosed: vi.fn(() => false),
        status: () => statusIter.iterator,
        closed: () => closedPromise,
        close: vi.fn(async () => {
          closedResolve();
        }),
        drain: vi.fn(async () => {
          closedResolve();
        }),
      } as unknown as NatsConnection;

      const mockConnect = vi.fn(async (opts: unknown) => {
        passedOpts = opts;
        return mockConn;
      });

      const manager = new ManagedNatsConnection(
        'nats://demo.nats.io:4222',
        silentLogger,
        mockConnect as unknown as typeof import('nats').connect,
      );

      expect(manager.getReadinessState()).toBe('disconnected');
      expect(manager.getConnection()).toBeNull();

      await manager.start();

      expect(mockConnect).toHaveBeenCalledTimes(1);
      expect(passedOpts).toMatchObject({
        servers: 'nats://demo.nats.io:4222',
        name: 'chat-svc',
        waitOnFirstConnect: true,
        reconnect: true,
        maxReconnectAttempts: -1,
      });

      expect(manager.getReadinessState()).toBe('ok');
      expect(manager.getConnection()).toBe(mockConn);

      // Simulate disconnect event
      statusIter.push({ type: 'disconnect', data: 'connection lost' } as unknown as Status);
      // Wait for tick
      await new Promise((r) => setTimeout(r, 10));
      expect(manager.getReadinessState()).toBe('disconnected');
      expect(manager.getConnection()).toBeNull();

      // Simulate reconnect event
      statusIter.push({ type: 'reconnect', data: 'reconnected' } as unknown as Status);
      await new Promise((r) => setTimeout(r, 10));
      expect(manager.getReadinessState()).toBe('ok');
      expect(manager.getConnection()).toBe(mockConn);

      // Cleanup
      statusIter.close();
      await manager.close();
      expect(manager.getReadinessState()).toBe('disconnected');
    });

    it('returns skipped readiness state when natsUrl is omitted', async () => {
      const manager = new ManagedNatsConnection(undefined, silentLogger);
      expect(manager.getReadinessState()).toBe('skipped');
      const conn = await manager.start();
      expect(conn).toBeNull();
      expect(manager.getReadinessState()).toBe('skipped');
      expect(manager.getConnection()).toBeNull();
    });
  });

  describe('Integration via buildApp', () => {
    it('integrates with buildApp and reflects live readiness transitions', async () => {
      let isNatsUp = false;
      const store = createMockStore();
      const mockDb = createMockDb(store);

      const app = await buildApp({
        db: mockDb,
        natsConfigured: true,
        getNatsStatus: () => (isNatsUp ? 'ok' : 'disconnected'),
        loggerInstance: silentLogger,
      });

      // Initially down -> 503
      const res1 = await app.inject({ method: 'GET', url: '/readyz' });
      expect(res1.statusCode).toBe(503);
      expect(res1.json().checks.nats).toBe('disconnected');

      // Now reconnected -> 200
      isNatsUp = true;
      const res2 = await app.inject({ method: 'GET', url: '/readyz' });
      expect(res2.statusCode).toBe(200);
      expect(res2.json().checks.nats).toBe('ok');
      expect(res2.json().status).toBe('ready');

      await app.close();
    });
  });
});
