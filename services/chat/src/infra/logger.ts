import pino from 'pino';

export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-user-id"]',
  '*.ciphertext',
  '*.curve25519_key',
  '*.ed25519_key',
  '*.public_key',
  '*.fallback_key',
  '*.signature',
  '*.fallback_signature',
  '*.one_time_keys',
  'ciphertext',
  'curve25519_key',
  'ed25519_key',
  'public_key',
  'fallback_key',
  'signature',
  'fallback_signature',
  'one_time_keys',
  'messages[*].ciphertext',
  'keys[*].public_key',
  'keys[*].signature',
];

export function createLogger(options?: pino.LoggerOptions): pino.Logger {
  return pino({
    level: process.env.LOG_LEVEL || 'info',
    redact: {
      paths: REDACT_PATHS,
      censor: '[REDACTED]',
    },
    ...options,
  });
}

export const defaultLogger = createLogger();
