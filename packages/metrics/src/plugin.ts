import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { Counter, Histogram, type Registry } from 'prom-client';
import { createMetricsHandler } from './handler.js';

export const DEFAULT_HTTP_DURATION_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

export interface MetricsPluginOptions {
  registry: Registry;
  /**
   * Endpoint path to mount Prometheus exposition format on.
   * Defaults to '/metrics'. Set to false to disable route mounting.
   */
  endpoint?: string | false;
}

const kStartTime = Symbol('winkey.metrics.startTime');

function isProbeOrMetrics(path: string): boolean {
  return path === '/healthz' || path === '/readyz' || path === '/metrics';
}

const rawMetricsPlugin: FastifyPluginAsync<MetricsPluginOptions> = async (
  fastify: FastifyInstance,
  options: MetricsPluginOptions,
) => {
  const { registry, endpoint = '/metrics' } = options;

  if (!registry) {
    throw new Error('MetricsPlugin requires a Registry instance in options.registry');
  }

  // Retrieve or create http_requests_total counter
  const httpRequestsTotal =
    (registry.getSingleMetric('http_requests_total') as Counter<string>) ??
    new Counter({
      name: 'http_requests_total',
      help: 'HTTP requests by method, route and status.',
      labelNames: ['method', 'route', 'status'],
      registers: [registry],
    });

  // Retrieve or create http_request_duration_seconds histogram
  const httpRequestDurationSeconds =
    (registry.getSingleMetric('http_request_duration_seconds') as Histogram<string>) ??
    new Histogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP request latency.',
      labelNames: ['method', 'route', 'status'],
      buckets: DEFAULT_HTTP_DURATION_BUCKETS,
      registers: [registry],
    });

  // Record start time on incoming request
  fastify.addHook('onRequest', async (request) => {
    (request as unknown as Record<symbol, bigint>)[kStartTime] = process.hrtime.bigint();
  });

  // Observe metrics upon response completion
  fastify.addHook('onResponse', async (request, reply) => {
    const routePattern = request.routeOptions?.url ?? 'unmatched';
    const rawPath = request.url.split('?')[0] ?? '';

    // Skip probe and metrics endpoints to avoid noise and infinite loops
    if (isProbeOrMetrics(routePattern) || isProbeOrMetrics(rawPath)) {
      return;
    }

    const startTime = (request as unknown as Record<symbol, bigint | undefined>)[kStartTime];
    const durationSeconds = startTime
      ? Number(process.hrtime.bigint() - startTime) / 1e9
      : 0;

    const status = String(reply.statusCode);
    const method = request.method;

    httpRequestsTotal.inc({ method, route: routePattern, status });
    httpRequestDurationSeconds.observe({ method, route: routePattern, status }, durationSeconds);
  });

  // Mount GET /metrics route if not disabled
  if (endpoint !== false) {
    fastify.get(endpoint, createMetricsHandler(registry));
  }
};

// Set Fastify skip-override symbol so hooks apply globally across all encapsulated contexts
Object.defineProperty(rawMetricsPlugin, Symbol.for('skip-override'), {
  value: true,
  enumerable: false,
});

export const metricsPlugin = rawMetricsPlugin;
