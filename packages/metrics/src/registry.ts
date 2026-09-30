import {
  Registry,
  collectDefaultMetrics,
  Counter,
  Histogram,
  Gauge,
  Summary,
  type Metric,
} from 'prom-client';

/**
 * Creates a new Prometheus Registry configured with standard Winkey settings:
 * - default label `service: "<service>"` applied to all metrics
 * - standard Node.js default metrics collected without prefix
 */
export function createRegistry(service: string): Registry {
  const registry = new Registry();
  registry.setDefaultLabels({ service });
  collectDefaultMetrics({ register: registry, prefix: '' });
  return registry;
}

export {
  Registry,
  collectDefaultMetrics,
  Counter,
  Histogram,
  Gauge,
  Summary,
  type Metric,
};
