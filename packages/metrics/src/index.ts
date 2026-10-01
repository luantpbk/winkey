export {
  createRegistry,
  Registry,
  collectDefaultMetrics,
  Counter,
  Histogram,
  Gauge,
  Summary,
  type Metric,
} from './registry.js';

export {
  metricsPlugin,
  DEFAULT_HTTP_DURATION_BUCKETS,
  type MetricsPluginOptions,
} from './plugin.js';

export { createMetricsHandler } from './handler.js';
