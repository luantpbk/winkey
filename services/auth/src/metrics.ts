import { Counter } from '@winkey/metrics';
import { authRegistry } from './revocation/revocation.js';

export const authRegistrationsCounter = new Counter({
  name: 'auth_registrations_total',
  help: 'Total number of account registrations by method and result',
  labelNames: ['method', 'result'],
  registers: [authRegistry],
});
