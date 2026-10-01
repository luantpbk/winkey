import { Counter, Gauge } from '@winkey/metrics';
import { authRegistry } from '../revocation/revocation.js';

export const authMailSentCounter = new Counter({
  name: 'auth_mail_sent_total',
  help: 'Total number of successfully sent emails by template',
  labelNames: ['template'],
  registers: [authRegistry],
});

export const authMailFailedCounter = new Counter({
  name: 'auth_mail_failed_total',
  help: 'Total number of failed email delivery attempts by template',
  labelNames: ['template'],
  registers: [authRegistry],
});

export const authMailDeadCounter = new Counter({
  name: 'auth_mail_dead_total',
  help: 'Total number of emails abandoned after maximum attempts',
  registers: [authRegistry],
});

export const authMailQueuePendingGauge = new Gauge({
  name: 'auth_mail_queue_pending',
  help: 'Current number of pending emails in auth.mail_queue',
  registers: [authRegistry],
});
