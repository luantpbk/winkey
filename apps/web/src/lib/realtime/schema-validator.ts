import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import serverSchema from '../../../../../contracts/realtime/server.schema.json';
import type { ServerMessage } from './realtime-types';

const AjvClass = Ajv2020 as unknown as new (
  opts?: Record<string, unknown>,
) => import('ajv').default;

const ajv = new AjvClass({
  strict: false,
  allErrors: true,
});

(addFormats as unknown as (a: unknown) => void)(ajv);

// Compiled once as strictly requested
const serverValidator = ajv.compile<ServerMessage>(serverSchema);

export interface ValidationResult {
  valid: boolean;
  message?: ServerMessage;
  error?: string;
}

export function validateServerFrame(data: unknown): ValidationResult {
  if (!data || typeof data !== 'object') {
    return { valid: false, error: 'Frame is not an object' };
  }

  const valid = serverValidator(data);
  if (!valid) {
    const errorText =
      serverValidator.errors?.map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ') ||
      'Invalid server frame';
    return { valid: false, error: errorText };
  }

  return { valid: true, message: data as ServerMessage };
}
