import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HTTP_PORT: z.coerce.number().default(8003),
  DATABASE_URL: z
    .string()
    .default('postgres://chat_svc:chat_svc@localhost:5432/winkey?sslmode=disable'),
  NATS_URL: z.string().default('nats://localhost:4222'),
  VALKEY_URL: z.string().default('redis://localhost:6379'),
  MEDIA_BASE_URL: z.string().default('https://media.winkey.vn'),
  TRUST_PROXY_CIDRS: z.string().default('10.42.0.0/16,127.0.0.1'),
  TO_DEVICE_PURGE_INTERVAL: z.string().default('1h'),
  // SOC-3b attachments (bucket `winkey-chat`). Without the endpoint, bucket and keys the service still starts and the
  // attachment endpoints answer 503. CHAT_S3_PUBLIC_ENDPOINT is the origin browsers use; URLs are presigned with it.
  CHAT_S3_ENDPOINT: z.string().optional(),
  CHAT_S3_PUBLIC_ENDPOINT: z.string().optional(),
  CHAT_S3_REGION: z.string().default('auto'),
  CHAT_S3_BUCKET: z.string().default('winkey-chat'),
  CHAT_S3_ACCESS_KEY_ID: z.string().optional(),
  CHAT_S3_SECRET_ACCESS_KEY: z.string().optional(),
  CHAT_ATTACHMENT_TTL: z
    .string()
    .regex(/^\d+(ms|s|m|h|d)$/, 'a duration such as 30d')
    .default('30d'),
  ATTACHMENT_JANITOR_INTERVAL: z.string().default('1h'),
  // SOC-4a TURN (coturn use-auth-secret). Without both, getTurnCredentials answers 503.
  TURN_SECRET: z.string().optional(),
  TURN_URLS: z.string().optional(),
  TURN_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(600),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(processEnv: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(processEnv);
  if (!result.success) {
    const errors = result.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ');
    throw new Error(`Failed to validate environment variables: ${errors}`);
  }
  return result.data;
}
