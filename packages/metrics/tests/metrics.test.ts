import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import {
  createRegistry,
  metricsPlugin,
  DEFAULT_HTTP_DURATION_BUCKETS,
  type Registry,
  type Counter,
  type Histogram,
} from '../src/index.js';

describe('@winkey/metrics', () => {
  let app: FastifyInstance | null = null;
  let registry: Registry;

  beforeEach(() => {
    registry = createRegistry('test-svc');
  });

  afterEach(async () => {
    if (app) {
      await app.close();
      app = null;
    }
    registry.clear();
  });

  it('createRegistry sets default label "service" and collects default Node metrics', async () => {
    const metricsStr = await registry.metrics();
    expect(metricsStr).toContain('service="test-svc"');
    expect(metricsStr).toContain('process_cpu_user_seconds_total');
    expect(metricsStr).toContain('nodejs_heap_size_total_bytes');
  });

  it('records route pattern and status, skipping raw URLs for high cardinality protection', async () => {
    app = fastify({ logger: false });
    await app.register(metricsPlugin, { registry });

    app.get('/v1/videos/:id', async (req) => {
      const { id } = req.params as { id: string };
      return { id };
    });

    const res1 = await app.inject({
      method: 'GET',
      url: '/v1/videos/video-uuid-1',
    });
    expect(res1.statusCode).toBe(200);

    const res2 = await app.inject({
      method: 'GET',
      url: '/v1/videos/video-uuid-2',
    });
    expect(res2.statusCode).toBe(200);

    const metricsStr = await registry.metrics();
    // Route pattern must be present
    expect(metricsStr).toContain('route="/v1/videos/:id"');
    // Raw UUIDs must NEVER appear in metric labels
    expect(metricsStr).not.toContain('video-uuid-1');
    expect(metricsStr).not.toContain('video-uuid-2');

    const counter = registry.getSingleMetric('http_requests_total') as Counter<string>;
    const counterData = await counter.get();
    const videoRouteItem = counterData.values.find(
      (v) => v.labels.route === '/v1/videos/:id' && v.labels.status === '200',
    );
    expect(videoRouteItem).toBeDefined();
    expect(videoRouteItem?.value).toBe(2);

    const histogram = registry.getSingleMetric('http_request_duration_seconds') as Histogram<string>;
    const histData = await histogram.get();
    const histItem = histData.values.find(
      (v) => v.labels.route === '/v1/videos/:id' && v.labels.status === '200',
    );
    expect(histItem).toBeDefined();
  });

  it('skips probe routes (/healthz, /readyz) and /metrics endpoint', async () => {
    app = fastify({ logger: false });
    await app.register(metricsPlugin, { registry });

    app.get('/healthz', async () => ({ status: 'ok' }));
    app.get('/readyz', async () => ({ status: 'ok' }));

    await app.inject({ method: 'GET', url: '/healthz' });
    await app.inject({ method: 'GET', url: '/readyz' });
    await app.inject({ method: 'GET', url: '/metrics' });

    const counter = registry.getSingleMetric('http_requests_total') as Counter<string>;
    const counterData = await counter.get();

    const healthzMatch = counterData.values.find((v) => v.labels.route === '/healthz');
    const readyzMatch = counterData.values.find((v) => v.labels.route === '/readyz');
    const metricsMatch = counterData.values.find((v) => v.labels.route === '/metrics');

    expect(healthzMatch).toBeUndefined();
    expect(readyzMatch).toBeUndefined();
    expect(metricsMatch).toBeUndefined();
  });

  it('records route as "unmatched" for 404 requests', async () => {
    app = fastify({ logger: false });
    await app.register(metricsPlugin, { registry });

    const res = await app.inject({
      method: 'GET',
      url: '/non-existent-route-xyz',
    });
    expect(res.statusCode).toBe(404);

    const counter = registry.getSingleMetric('http_requests_total') as Counter<string>;
    const counterData = await counter.get();
    const unmatchedItem = counterData.values.find(
      (v) => v.labels.route === 'unmatched' && v.labels.status === '404',
    );
    expect(unmatchedItem).toBeDefined();
    expect(unmatchedItem?.value).toBe(1);
  });

  it('serves Prometheus exposition format at GET /metrics with correct headers', async () => {
    app = fastify({ logger: false });
    await app.register(metricsPlugin, { registry });

    app.get('/api/test', async () => ({ hello: 'world' }));
    await app.inject({ method: 'GET', url: '/api/test' });

    const res = await app.inject({
      method: 'GET',
      url: '/metrics',
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe(registry.contentType);
    expect(res.payload).toContain('# HELP http_requests_total');
    expect(res.payload).toContain('# TYPE http_requests_total counter');
    expect(res.payload).toContain('http_requests_total{');
    expect(res.payload).toContain('route="/api/test"');
    expect(res.payload).toContain('status="200"');
    expect(res.payload).toContain('service="test-svc"');
  });

  it('uses standard HTTP latency duration buckets matching libs/go/httpx', () => {
    expect(DEFAULT_HTTP_DURATION_BUCKETS).toEqual([
      0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
    ]);
  });
});
