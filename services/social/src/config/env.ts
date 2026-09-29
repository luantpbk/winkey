import { z } from 'zod';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HTTP_PORT: z.coerce.number().default(8002),
  DATABASE_URL: z
    .string()
    .default('postgres://social_svc:social_svc@localhost:5432/winkey?sslmode=disable'),
  NATS_URL: z.string().default('nats://localhost:4222'),
  VALKEY_URL: z.string().default('redis://localhost:6379'),
  MEDIA_BASE_URL: z.string().default('https://media.winkey.vn'),
  TRUST_PROXY_CIDRS: z.string().default('10.42.0.0/16,127.0.0.1'),
});

export type Env = z.infer<typeof envSchema>;

let parsedEnv: Env | null = null;

export function getEnv(overrides: Partial<Env> = {}): Env {
  if (parsedEnv && Object.keys(overrides).length === 0) {
    return parsedEnv;
  }

  const envSource = {
    ...process.env,
    ...overrides,
  };

  const result = envSchema.safeParse(envSource);
  if (!result.success) {
    console.error('Invalid environment configuration:', result.error.format());
    throw new Error('Environment configuration validation failed');
  }

  parsedEnv = result.data;
  return parsedEnv;
}
