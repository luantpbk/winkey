import type { Redis } from 'ioredis';
import { metrics } from '@opentelemetry/api';
import type { ConnectionManager } from '../websocket/connection-manager.js';

export interface LoggerLike {
  info?: (obj: Record<string, unknown> | string, msg?: string) => void;
  warn: (obj: Record<string, unknown> | string, msg?: string) => void;
  error?: (obj: Record<string, unknown> | string, msg?: string) => void;
  debug?: (obj: Record<string, unknown> | string, msg?: string) => void;
}

export interface RevocationSweeperOptions {
  redis: Redis | null;
  connectionManager: ConnectionManager;
  sweepIntervalMs?: number;
  logger?: LoggerLike;
}

export interface SweepResult {
  checkedUsers: number;
  closedSockets: number;
  error?: boolean;
}

// OpenTelemetry metrics
const meter = metrics.getMeter('realtime-gw');

export const revokedClosesCounter = meter.createCounter('realtime_revoked_closes_total', {
  description: 'Total number of WebSocket connections closed due to user revocation',
});

export const sweepErrorsCounter = meter.createCounter('realtime_revocation_sweep_errors_total', {
  description: 'Total number of revocation sweep errors (e.g. Valkey unavailable)',
});

// In-memory counters for test verification
const inMemoryCounters = new Map<string, number>();

export function recordRevocationMetric(name: string, count = 1): void {
  inMemoryCounters.set(name, (inMemoryCounters.get(name) ?? 0) + count);
}

export function getRevocationMetricCount(name: string): number {
  return inMemoryCounters.get(name) ?? 0;
}

export function resetRevocationMetricsForTest(): void {
  inMemoryCounters.clear();
}

export const CHUNK_SIZE = 500;
export const WARN_THROTTLE_MS = 60_000; // Log warning at most once per minute

export class RevocationSweeper {
  private redis: Redis | null;
  private readonly connectionManager: ConnectionManager;
  private readonly sweepIntervalMs: number;
  private readonly logger?: LoggerLike;

  private timer: NodeJS.Timeout | null = null;
  private isSweeping = false;
  private lastWarnAt = 0;

  constructor(options: RevocationSweeperOptions) {
    this.redis = options.redis;
    this.connectionManager = options.connectionManager;
    this.sweepIntervalMs = options.sweepIntervalMs ?? 30_000;
    this.logger = options.logger;
  }

  setRedis(redis: Redis | null): void {
    this.redis = redis;
  }

  resetLastWarnAtForTest(): void {
    this.lastWarnAt = 0;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.sweep().catch(() => {});
    }, this.sweepIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Executes a single sweep of all distinct authenticated users across active connections.
   * Chunks into batches of 500 IDs, issues ONE MGET per chunk for auth:revoked:user:{id},
   * and closes any socket with authenticatedAt <= cutoff with code 4401 ('session revoked').
   * Fail-open: on Valkey error, skips sweep and increments metric without closing sockets.
   */
  async sweep(): Promise<SweepResult> {
    if (this.isSweeping) {
      return { checkedUsers: 0, closedSockets: 0 };
    }

    this.isSweeping = true;
    try {
      const userIds = this.connectionManager.getDistinctAuthenticatedUserIds();
      if (userIds.length === 0) {
        return { checkedUsers: 0, closedSockets: 0 };
      }

      // Check Redis connection readiness
      if (!this.redis || this.redis.status !== 'ready') {
        this.handleValkeyError(new Error('Valkey connection is not ready'));
        return { checkedUsers: 0, closedSockets: 0, error: true };
      }

      let totalClosed = 0;

      // Process in chunks of 500 user IDs
      for (let i = 0; i < userIds.length; i += CHUNK_SIZE) {
        const chunk = userIds.slice(i, i + CHUNK_SIZE);
        const keys = chunk.map((id) => `auth:revoked:user:${id}`);

        let cutoffs: (string | null)[];
        try {
          cutoffs = await this.redis.mget(keys);
        } catch (err) {
          this.handleValkeyError(err);
          return { checkedUsers: i, closedSockets: totalClosed, error: true };
        }

        for (let j = 0; j < chunk.length; j++) {
          const userId = chunk[j];
          const rawCutoff = cutoffs[j];
          if (rawCutoff !== null && rawCutoff !== undefined) {
            const cutoff = parseInt(rawCutoff, 10);
            if (!Number.isNaN(cutoff)) {
              const closed = this.connectionManager.closeRevokedConnections(
                userId,
                cutoff,
                4401,
                'session revoked',
              );
              if (closed > 0) {
                totalClosed += closed;
                revokedClosesCounter.add(closed);
                recordRevocationMetric('realtime_revoked_closes_total', closed);
              }
            }
          }
        }
      }

      return { checkedUsers: userIds.length, closedSockets: totalClosed };
    } finally {
      this.isSweeping = false;
    }
  }

  private handleValkeyError(err: unknown): void {
    sweepErrorsCounter.add(1);
    recordRevocationMetric('realtime_revocation_sweep_errors_total', 1);

    const now = Date.now();
    if (now - this.lastWarnAt >= WARN_THROTTLE_MS) {
      this.lastWarnAt = now;
      const msg = err instanceof Error ? err.message : String(err);
      this.logger?.warn({ err: msg }, 'Revocation sweep failed (Valkey error)');
    }
  }
}
