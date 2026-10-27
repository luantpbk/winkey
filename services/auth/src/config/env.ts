import crypto from 'node:crypto';
import { z } from 'zod';

export const envSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'production', 'test'])
      .default((process.env.NODE_ENV as 'development' | 'production' | 'test') || 'development'),
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

    // Mail transport (ADR-026, task A6)
    MAIL_TRANSPORT: z.enum(['smtp', 'log']).default('log'),
    SMTP_URL: z.string().optional(),
    MAIL_FROM: z.string().default('Winkey <no-reply@winkey.vn>'),

    // Closed-beta registration mode & invite codes (ADR-034, task BETA1)
    REGISTRATION_MODE: z.enum(['open', 'invite']).default('open'),
    INVITE_CODES: z.string().optional(),

    // Refresh token reuse grace period in seconds (ADR-019 addendum, default 30s, max 60s)
    REFRESH_REUSE_GRACE: z
      .preprocess((val) => {
        if (val === undefined || val === '') return 30;
        if (typeof val === 'string' && val.endsWith('s')) {
          return Number(val.slice(0, -1));
        }
        return Number(val);
      }, z.number().int().min(0).max(60))
      .default(30),

    // Sign-up default roles (ADR-046, task ROLE1: only 'viewer' or 'viewer,creator' accepted)
    SIGNUP_ROLES: z.enum(['viewer', 'viewer,creator']).default('viewer'),

    // SOC-1a Account Security (ADR-049)
    TOTP_ENCRYPTION_KEYS: z.string().optional(),
    SESSION_IP_SALT: z.string().optional(),
    STAFF_MFA_REQUIRED: z
      .preprocess((val) => {
        if (val === undefined || val === '') return true;
        if (typeof val === 'string') return val.toLowerCase() === 'true';
        return Boolean(val);
      }, z.boolean())
      .default(true),
    TURNSTILE_SECRET: z.string().optional(),
    PASSWORD_BREACH_CHECK: z
      .preprocess((val) => {
        if (val === undefined || val === '') return false;
        if (typeof val === 'string') return val.toLowerCase() === 'true';
        return Boolean(val);
      }, z.boolean())
      .default(false),
    TRUSTED_COUNTRY_HEADER: z.string().default('CF-IPCountry'),
    WEBAUTHN_RP_ID: z.string().default('winkey.vn'),
    WEBAUTHN_ORIGINS: z.string().default('https://winkey.vn,https://www.winkey.vn'),
    WEBAUTHN_USER_HANDLE_KEY: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    // Validate TOTP_ENCRYPTION_KEYS unless in test mode
    if (data.NODE_ENV !== 'test') {
      if (!data.TOTP_ENCRYPTION_KEYS || data.TOTP_ENCRYPTION_KEYS.trim() === '') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'TOTP_ENCRYPTION_KEYS is required',
          path: ['TOTP_ENCRYPTION_KEYS'],
        });
      } else {
        const pairs = data.TOTP_ENCRYPTION_KEYS.split(',')
          .map((p) => p.trim())
          .filter(Boolean);
        if (pairs.length === 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'TOTP_ENCRYPTION_KEYS must contain at least one key',
            path: ['TOTP_ENCRYPTION_KEYS'],
          });
        } else {
          for (const pair of pairs) {
            const [keyId, b64] = pair.split(':');
            if (!keyId || !b64) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `TOTP_ENCRYPTION_KEYS pair '${pair}' is malformed (expected id:base64)`,
                path: ['TOTP_ENCRYPTION_KEYS'],
              });
              break;
            }
            const buf = Buffer.from(b64, 'base64');
            if (buf.byteLength !== 32) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `TOTP_ENCRYPTION_KEYS key '${keyId}' must decode to exactly 32 bytes (got ${buf.byteLength})`,
                path: ['TOTP_ENCRYPTION_KEYS'],
              });
              break;
            }
          }
        }
      }

      if (!data.SESSION_IP_SALT || Buffer.byteLength(data.SESSION_IP_SALT, 'utf8') < 32) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'SESSION_IP_SALT must be at least 32 bytes',
          path: ['SESSION_IP_SALT'],
        });
      }
    } else {
      // Provide fallback for tests if not set
      if (!data.TOTP_ENCRYPTION_KEYS) {
        data.TOTP_ENCRYPTION_KEYS = `k1:${Buffer.alloc(32, 1).toString('base64')}`;
      }
      if (!data.SESSION_IP_SALT) {
        data.SESSION_IP_SALT = 'test_salt_at_least_32_bytes_long_1234567890';
      }
    }
    if (data.MAIL_TRANSPORT === 'smtp' && !data.SMTP_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'SMTP_URL is required when MAIL_TRANSPORT=smtp',
        path: ['SMTP_URL'],
      });
    }

    if (data.REGISTRATION_MODE === 'invite') {
      if (!data.INVITE_CODES || data.INVITE_CODES.trim() === '') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'INVITE_CODES is required when REGISTRATION_MODE=invite',
          path: ['INVITE_CODES'],
        });
      } else {
        const rawCodes = data.INVITE_CODES.split(',').map((c) => c.trim());
        if (rawCodes.length === 0 || rawCodes.some((c) => c === '')) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'INVITE_CODES must contain non-empty comma-separated codes',
            path: ['INVITE_CODES'],
          });
        } else {
          const inviteRegex = /^[A-Za-z0-9-]{12,64}$/;
          const seen = new Set<string>();
          for (const code of rawCodes) {
            if (!inviteRegex.test(code)) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message:
                  'INVITE_CODES contains code with invalid format (each code must match ^[A-Za-z0-9-]{12,64}$)',
                path: ['INVITE_CODES'],
              });
              break;
            }
            if (seen.has(code)) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'INVITE_CODES contains duplicate codes',
                path: ['INVITE_CODES'],
              });
              break;
            }
            seen.add(code);
          }
        }
      }
    }

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
  .transform((data) => {
    const inviteCodeDigests: Buffer[] = [];
    if (data.REGISTRATION_MODE === 'invite' && data.INVITE_CODES) {
      const rawCodes = data.INVITE_CODES.split(',').map((c) => c.trim());
      for (const code of rawCodes) {
        if (code) {
          inviteCodeDigests.push(crypto.createHash('sha256').update(code).digest());
        }
      }
    }
    const { INVITE_CODES: _omittedCodes, ...rest } = data;
    return {
      ...rest,
      COOKIE_SECRET: data.COOKIE_SECRET ?? 'winkey-dev-cookie-secret-min-32-chars-long!',
      inviteCodeDigests,
    };
  });

export type Env = z.infer<typeof envSchema>;
export type EnvInput = z.input<typeof envSchema>;

let parsedEnv: Env | null = null;

export function resetEnvCache(): void {
  parsedEnv = null;
}

export function getEnv(overrides: Partial<EnvInput> = {}): Env {
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

  if (Object.keys(overrides).length === 0) {
    parsedEnv = result.data;
  }
  return result.data;
}
