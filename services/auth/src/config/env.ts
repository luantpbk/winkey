import { z } from 'zod';

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    HTTP_PORT: z.coerce.number().default(8001),
    DATABASE_URL: z
      .string()
      .default('postgres://auth_svc:auth_svc@localhost:5432/winkey?sslmode=disable'),
    NATS_URL: z.string().default('nats://localhost:4222'),
    VALKEY_URL: z.string().default('redis://localhost:6379'),

    // JWT configuration
    JWT_PRIVATE_KEY: z.string(),
    JWT_KID: z.string().default('winkey-auth-key-1'),
    JWT_PREVIOUS_PUBLIC_KEY: z.string().optional(),
    JWT_ISSUER: z.string().default('https://winkey.vn'),

    // Site origin & media
    PUBLIC_ORIGIN: z.string().default('https://winkey.vn'),
    MEDIA_BASE_URL: z.string().default('https://media.winkey.vn'),

    // Google OAuth
    GOOGLE_CLIENT_ID: z.string().optional().default(''),
    GOOGLE_CLIENT_SECRET: z.string().optional().default(''),
    GOOGLE_REDIRECT_URI: z.string().default('https://winkey.vn/v1/auth/oauth/google/callback'),

    // Internal secret for signing temporary OAuth state cookies
    COOKIE_SECRET: z.string().optional(),

    // Trusted proxy CIDRs for Fastify (e.g. Traefik/k8s pod CIDR 10.42.0.0/16, loopback 127.0.0.1)
    TRUST_PROXY_CIDRS: z.string().default('10.42.0.0/16,127.0.0.1'),
  })
  .superRefine((data, ctx) => {
    if (data.NODE_ENV === 'production') {
      if (!data.COOKIE_SECRET) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'COOKIE_SECRET is required when NODE_ENV=production',
          path: ['COOKIE_SECRET'],
        });
      } else if (data.COOKIE_SECRET === 'winkey-dev-cookie-secret-min-32-chars-long!') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'COOKIE_SECRET cannot use the dev default in production',
          path: ['COOKIE_SECRET'],
        });
      }
    }
  })
  .transform((data) => ({
    ...data,
    COOKIE_SECRET: data.COOKIE_SECRET ?? 'winkey-dev-cookie-secret-min-32-chars-long!',
  }));

export type Env = z.infer<typeof envSchema>;

let parsedEnv: Env | null = null;

export function getEnv(overrides: Partial<Env> = {}): Env {
  if (parsedEnv && Object.keys(overrides).length === 0) {
    return parsedEnv;
  }

  // Provide dummy test RSA key if JWT_PRIVATE_KEY is not set (e.g. during test setup)
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
