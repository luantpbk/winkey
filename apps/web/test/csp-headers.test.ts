import { describe, it, expect, afterEach } from 'vitest';
import nextConfig from '../next.config';

describe('Content-Security-Policy headers in next.config.ts (SOC-1a / Turnstile / CSP hardening)', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    (process.env as Record<string, string | undefined>).NODE_ENV = originalNodeEnv;
  });

  async function resolveConfigHeaders(): Promise<
    Array<{ source: string; headers: Array<{ key: string; value: string }> }>
  > {
    const config =
      typeof nextConfig === 'function'
        ? await (nextConfig as any)('phase-production-build', { defaultConfig: {} })
        : nextConfig;
    return await config.headers();
  }

  it('excludes unsafe-eval from script-src in production', async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
    const headers = await resolveConfigHeaders();

    const mainRouteConfig = headers.find((h) => h.source === '/((?!embed).*)');
    expect(mainRouteConfig).toBeDefined();

    const csp = mainRouteConfig?.headers.find((entry) => entry.key === 'Content-Security-Policy');
    expect(csp).toBeDefined();
    expect(csp?.value).not.toContain("'unsafe-eval'");
    expect(csp?.value).toContain("'self'");
    expect(csp?.value).toContain("'unsafe-inline'");
    expect(csp?.value).toContain('https://challenges.cloudflare.com');
  });

  it('includes unsafe-eval in script-src when running in development for dev tooling', async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = 'development';
    const headers = await resolveConfigHeaders();

    const mainRouteConfig = headers.find((h) => h.source === '/((?!embed).*)');
    expect(mainRouteConfig).toBeDefined();

    const csp = mainRouteConfig?.headers.find((entry) => entry.key === 'Content-Security-Policy');
    expect(csp).toBeDefined();
    expect(csp?.value).toContain("'unsafe-eval'");
    expect(csp?.value).toContain('https://challenges.cloudflare.com');
  });

  it('preserves embed route frame-ancestors * header', async () => {
    const headers = await resolveConfigHeaders();

    const embedRouteConfig = headers.find((h) => h.source === '/embed/:path*');
    expect(embedRouteConfig).toBeDefined();

    const csp = embedRouteConfig?.headers.find((entry) => entry.key === 'Content-Security-Policy');
    expect(csp).toBeDefined();
    expect(csp?.value).toBe('frame-ancestors *');
  });
});
