import { createRegistry, Counter } from '@winkey/metrics';

export const realtimeRegistry = createRegistry('realtime-gw');

export const revokedClosesCounter = new Counter({
  name: 'realtime_revoked_closes_total',
  help: 'Total number of WebSocket connections closed due to user revocation',
  registers: [realtimeRegistry],
});

export const sweepErrorsCounter = new Counter({
  name: 'realtime_revocation_sweep_errors_total',
  help: 'Total number of revocation sweep errors (e.g. Valkey unavailable)',
  registers: [realtimeRegistry],
});

export const notificationHintsCounter = new Counter({
  name: 'realtime_notification_hints_total',
  help: 'Total number of notification hints sent by kind',
  labelNames: ['kind'],
  registers: [realtimeRegistry],
});

export const invalidServerFramesCounter = new Counter({
  name: 'realtime_invalid_server_frames_total',
  help: 'Total number of outgoing server frames dropped due to schema validation failure',
  registers: [realtimeRegistry],
});
