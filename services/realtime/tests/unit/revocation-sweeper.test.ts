import type { WebSocket } from 'ws';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Redis } from 'ioredis';
import { RevocationSweeper, realtimeRegistry } from '../../src/revocation/revocation-sweeper.js';
import type { Counter } from '@winkey/metrics';
import { ConnectionManager } from '../../src/websocket/connection-manager.js';
import { VideoClient } from '../../src/video/video-client.js';

async function getMetricCount(name: string): Promise<number> {
  const metric = await (realtimeRegistry.getSingleMetric(name) as Counter<string>)?.get();
  return metric?.values[0]?.value ?? 0;
}

function createMockSocket() {
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
  return {
    readyState: 1, // OPEN
    close: vi.fn(),
    send: vi.fn(),
    ping: vi.fn(),
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(cb);
    }),
    emit: (event: string, ...args: unknown[]) => {
      listeners[event]?.forEach((cb) => cb(...args));
    },
  };
}

describe('RevocationSweeper Unit Tests', () => {
  let mockRedis: {
    status: string;
    mget: ReturnType<typeof vi.fn>;
  };
  let connectionManager: ConnectionManager;
  let sweeper: RevocationSweeper;
  let mockLogger: {
    warn: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    realtimeRegistry.resetMetrics();

    mockRedis = {
      status: 'ready',
      mget: vi.fn().mockResolvedValue([]),
    };

    mockLogger = {
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    };

    const mockVideoClient = {
      canViewVideo: vi.fn().mockResolvedValue(true),
    } as unknown as VideoClient;

    connectionManager = new ConnectionManager({
      videoClient: mockVideoClient,
      logger: mockLogger,
    });

    sweeper = new RevocationSweeper({
      redis: mockRedis as unknown as Redis,
      connectionManager,
      sweepIntervalMs: 30000,
      logger: mockLogger,
    });
  });

  it('does nothing when there are no connected users', async () => {
    const result = await sweeper.sweep();
    expect(result).toEqual({ checkedUsers: 0, closedSockets: 0 });
    expect(mockRedis.mget).not.toHaveBeenCalled();
  });

  it('ignores anonymous connections and does not query Valkey', async () => {
    const ws = createMockSocket();
    connectionManager.handleNewConnection(ws as unknown as WebSocket, { userId: null, roles: [] });

    const result = await sweeper.sweep();
    expect(result).toEqual({ checkedUsers: 0, closedSockets: 0 });
    expect(mockRedis.mget).not.toHaveBeenCalled();
    expect(ws.close).not.toHaveBeenCalled();
  });

  it('keeps socket open when user has no cutoff key in Valkey (null)', async () => {
    const ws = createMockSocket();
    connectionManager.handleNewConnection(ws as unknown as WebSocket, {
      userId: 'user-1',
      roles: ['user'],
      authenticatedAt: 1000,
    });

    mockRedis.mget.mockResolvedValueOnce([null]);

    const result = await sweeper.sweep();
    expect(result).toEqual({ checkedUsers: 1, closedSockets: 0 });
    expect(mockRedis.mget).toHaveBeenCalledWith(['auth:revoked:user:user-1']);
    expect(ws.close).not.toHaveBeenCalled();
  });

  it('keeps socket open when cutoff is strictly before authenticatedAt (cutoff < authenticatedAt)', async () => {
    const ws = createMockSocket();
    connectionManager.handleNewConnection(ws as unknown as WebSocket, {
      userId: 'user-1',
      roles: ['user'],
      authenticatedAt: 1000,
    });

    // Revocation happened at 990, but user authenticated with fresh ticket at 1000
    mockRedis.mget.mockResolvedValueOnce(['990']);

    const result = await sweeper.sweep();
    expect(result).toEqual({ checkedUsers: 1, closedSockets: 0 });
    expect(ws.close).not.toHaveBeenCalled();
  });

  it('closes socket with 4401 when cutoff equals authenticatedAt (cutoff == authenticatedAt)', async () => {
    const ws = createMockSocket();
    connectionManager.handleNewConnection(ws as unknown as WebSocket, {
      userId: 'user-1',
      roles: ['user'],
      authenticatedAt: 1000,
    });

    mockRedis.mget.mockResolvedValueOnce(['1000']);

    const result = await sweeper.sweep();
    expect(result).toEqual({ checkedUsers: 1, closedSockets: 1 });
    expect(ws.close).toHaveBeenCalledWith(4401, 'session revoked');
    expect(await getMetricCount('realtime_revoked_closes_total')).toBe(1);
    expect(connectionManager.getDistinctAuthenticatedUserIds()).not.toContain('user-1');
  });

  it('closes socket with 4401 when cutoff is strictly after authenticatedAt (cutoff > authenticatedAt)', async () => {
    const ws = createMockSocket();
    connectionManager.handleNewConnection(ws as unknown as WebSocket, {
      userId: 'user-2',
      roles: ['user'],
      authenticatedAt: 1000,
    });

    // Revocation happened at 1005 (e.g. admin suspended user)
    mockRedis.mget.mockResolvedValueOnce(['1005']);

    const result = await sweeper.sweep();
    expect(result).toEqual({ checkedUsers: 1, closedSockets: 1 });
    expect(ws.close).toHaveBeenCalledWith(4401, 'session revoked');
    expect(await getMetricCount('realtime_revoked_closes_total')).toBe(1);
  });

  it('handles multiple sockets per user correctly based on each socket authenticatedAt', async () => {
    const ws1 = createMockSocket();
    const ws2 = createMockSocket();

    connectionManager.handleNewConnection(ws1 as unknown as WebSocket, {
      userId: 'user-multi',
      roles: ['user'],
      authenticatedAt: 1000,
    });
    connectionManager.handleNewConnection(ws2 as unknown as WebSocket, {
      userId: 'user-multi',
      roles: ['user'],
      authenticatedAt: 2000,
    });

    // Cutoff is 1500: ws1 (1000 <= 1500) must close, ws2 (2000 <= 1500 is false) must stay open
    mockRedis.mget.mockResolvedValueOnce(['1500']);

    const result = await sweeper.sweep();
    expect(result).toEqual({ checkedUsers: 1, closedSockets: 1 });
    expect(ws1.close).toHaveBeenCalledWith(4401, 'session revoked');
    expect(ws2.close).not.toHaveBeenCalled();
    expect(await getMetricCount('realtime_revoked_closes_total')).toBe(1);

    // user-multi still has ws2 connected
    expect(connectionManager.getDistinctAuthenticatedUserIds()).toContain('user-multi');
  });

  it('allows a fresh ticket after cutoff to connect normally and survive subsequent sweeps', async () => {
    const wsOld = createMockSocket();
    connectionManager.handleNewConnection(wsOld as unknown as WebSocket, {
      userId: 'user-role-change',
      roles: ['user'],
      authenticatedAt: 1000,
    });

    // User roles changed at 1050
    mockRedis.mget.mockResolvedValueOnce(['1050']);
    await sweeper.sweep();
    expect(wsOld.close).toHaveBeenCalledWith(4401, 'session revoked');

    // User gets new roles, obtains fresh ticket and connects at 1100
    const wsNew = createMockSocket();
    connectionManager.handleNewConnection(wsNew as unknown as WebSocket, {
      userId: 'user-role-change',
      roles: ['moderator'],
      authenticatedAt: 1100,
    });

    // Cutoff in Valkey is still 1050
    mockRedis.mget.mockResolvedValueOnce(['1050']);
    const result2 = await sweeper.sweep();
    expect(result2).toEqual({ checkedUsers: 1, closedSockets: 0 });
    expect(wsNew.close).not.toHaveBeenCalled();
  });

  it('chunks MGET in batches of 500 when there are more than 500 users', async () => {
    const totalUsers = 1050;
    for (let i = 1; i <= totalUsers; i++) {
      const ws = createMockSocket();
      connectionManager.handleNewConnection(ws as unknown as WebSocket, {
        userId: `user-${i}`,
        roles: ['user'],
        authenticatedAt: 1000,
      });
    }

    mockRedis.mget.mockImplementation(async (keys: string[]) => {
      return keys.map(() => null);
    });

    const result = await sweeper.sweep();
    expect(result).toEqual({ checkedUsers: totalUsers, closedSockets: 0 });

    // 1050 users with CHUNK_SIZE = 500 -> 3 calls (500, 500, 50)
    expect(mockRedis.mget).toHaveBeenCalledTimes(3);
    expect(mockRedis.mget.mock.calls[0][0].length).toBe(500);
    expect(mockRedis.mget.mock.calls[1][0].length).toBe(500);
    expect(mockRedis.mget.mock.calls[2][0].length).toBe(50);
  });

  it('fails open when Valkey MGET throws, increments error metric and logs warning', async () => {
    const ws = createMockSocket();
    connectionManager.handleNewConnection(ws as unknown as WebSocket, {
      userId: 'user-err',
      roles: ['user'],
      authenticatedAt: 1000,
    });

    mockRedis.mget.mockRejectedValueOnce(new Error('Connection timed out'));

    const result = await sweeper.sweep();
    expect(result).toEqual({ checkedUsers: 0, closedSockets: 0, error: true });
    expect(ws.close).not.toHaveBeenCalled();
    expect(await getMetricCount('realtime_revocation_sweep_errors_total')).toBe(1);
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'Connection timed out' }),
      expect.stringContaining('Revocation sweep failed'),
    );
  });

  it('fails open when Valkey status is not ready', async () => {
    const ws = createMockSocket();
    connectionManager.handleNewConnection(ws as unknown as WebSocket, {
      userId: 'user-down',
      roles: ['user'],
      authenticatedAt: 1000,
    });

    mockRedis.status = 'reconnecting';

    const result = await sweeper.sweep();
    expect(result).toEqual({ checkedUsers: 0, closedSockets: 0, error: true });
    expect(ws.close).not.toHaveBeenCalled();
    expect(mockRedis.mget).not.toHaveBeenCalled();
    expect(await getMetricCount('realtime_revocation_sweep_errors_total')).toBe(1);
  });

  it('throttles warning log to at most once per minute on repeated Valkey errors', async () => {
    const ws = createMockSocket();
    connectionManager.handleNewConnection(ws as unknown as WebSocket, {
      userId: 'user-throttle',
      roles: ['user'],
      authenticatedAt: 1000,
    });

    mockRedis.mget.mockRejectedValue(new Error('Redis down'));

    // Sweep 1 -> logs warning
    await sweeper.sweep();
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);

    // Sweep 2 immediately -> should NOT log warning again
    await sweeper.sweep();
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);

    // Advance time past 60s
    vi.setSystemTime(Date.now() + 61_000);

    // Sweep 3 after 61s -> logs warning again
    await sweeper.sweep();
    expect(mockLogger.warn).toHaveBeenCalledTimes(2);

    expect(await getMetricCount('realtime_revocation_sweep_errors_total')).toBe(3);
    vi.useRealTimers();
  });
});
