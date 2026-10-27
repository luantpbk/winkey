import validateServerMessage from './generated-server-validator.js';
import type { ServerMessage } from './realtime-types';

export interface ValidationResult {
  valid: boolean;
  message?: ServerMessage;
  error?: string;
}

export function validateServerFrame(data: unknown): ValidationResult {
  if (!data || typeof data !== 'object') {
    return { valid: false, error: 'Frame is not an object' };
  }

  const validator = validateServerMessage as ((data: unknown) => boolean) & {
    errors?: Array<{ instancePath?: string; message?: string }> | null;
  };

  const valid = validator(data);
  if (!valid) {
    const errorText =
      validator.errors?.map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ') ||
      'Invalid server frame';
    return { valid: false, error: errorText };
  }

  return { valid: true, message: data as ServerMessage };
}
