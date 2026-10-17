import { Counter } from '@winkey/metrics';
import { authRegistry } from './revocation/revocation.js';

export const authRegistrationsCounter = new Counter({
  name: 'auth_registrations_total',
  help: 'Total number of account registrations by method and result',
  labelNames: ['method', 'result'],
  registers: [authRegistry],
});

export const authRefreshCounter = new Counter({
  name: 'auth_refresh_total',
  help: 'Total number of token refresh attempts partitioned by result',
  labelNames: ['result'],
  registers: [authRegistry],
});
