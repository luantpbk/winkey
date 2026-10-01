import { createRegistry, Counter, Histogram } from '@winkey/metrics';

export const socialRegistry = createRegistry('social-svc');

export const notificationsCreatedCounter = new Counter({
  name: 'social_notifications_created_total',
  help: 'Total number of notifications created by kind',
  labelNames: ['kind'],
  registers: [socialRegistry],
});

export const notificationsFanoutDuration = new Histogram({
  name: 'social_notifications_fanout_seconds',
  help: 'Duration of video published notification fanout in seconds',
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [socialRegistry],
});

export const notificationsJanitorDeletedCounter = new Counter({
  name: 'social_notifications_janitor_deleted_total',
  help: 'Total number of notifications deleted by the janitor',
  registers: [socialRegistry],
});
