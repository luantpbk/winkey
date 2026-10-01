# @winkey/metrics

Prometheus metrics registry and Fastify HTTP request instrumentation for Winkey Node.js services (`auth-svc`, `social-svc`, `realtime-gw`).

## Features

- **Standard Prometheus Registry**: Configured via `createRegistry(service)` with default Node metrics (no prefix) and default `service` label.
- **Fastify Plugin (`metricsPlugin`)**:
  - `http_requests_total{method,route,status}`: Counts HTTP requests by method, route pattern, and status code.
  - `http_request_duration_seconds{method,route,status}`: Latency histogram using same standard buckets as Go services (`libs/go/httpx`).
  - High-cardinality protection: Always uses route pattern (e.g. `/v1/videos/:id`), never raw URLs. Unmatched requests use `"unmatched"`.
  - Excludes probe and metrics endpoints: `/healthz`, `/readyz`, and `/metrics`.
  - Mounts `GET /metrics` in standard Prometheus text exposition format.

## Usage

```typescript
import fastify from 'fastify';
import { createRegistry, metricsPlugin } from '@winkey/metrics';

const app = fastify();
const registry = createRegistry('my-service');

// Register plugin globally
await app.register(metricsPlugin, { registry });

// Define routes
app.get('/v1/items/:id', async (req, reply) => ({ id: req.params.id }));
```
