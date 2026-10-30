import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import nextConfig from '../next.config';
import middleware from '../src/middleware';

describe('Content-Security-Policy headers in next.config.ts & middleware (CSP1 Phase 1 Report-Only)', () => {
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

  describe('Legacy headers in next.config.ts (kept unchanged in Phase 1)', () => {
    it('excludes unsafe-eval from script-src in production while including wasm-unsafe-eval', async () => {
      (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
      const headers = await resolveConfigHeaders();

      const mainRouteConfig = headers.find((h) => h.source === '/((?!embed).*)');
      expect(mainRouteConfig).toBeDefined();

      const csp = mainRouteConfig?.headers.find((entry) => entry.key === 'Content-Security-Policy');
      expect(csp).toBeDefined();
      expect(csp?.value).not.toContain("'unsafe-eval'");
      expect(csp?.value).toContain("'wasm-unsafe-eval'");
      expect(csp?.value).toContain("'self'");
      expect(csp?.value).toContain("'unsafe-inline'");
      expect(csp?.value).toContain('https://challenges.cloudflare.com');
    });

    it('includes unsafe-eval and wasm-unsafe-eval in script-src when running in development for dev tooling', async () => {
      (process.env as Record<string, string | undefined>).NODE_ENV = 'development';
      const headers = await resolveConfigHeaders();

      const mainRouteConfig = headers.find((h) => h.source === '/((?!embed).*)');
      expect(mainRouteConfig).toBeDefined();

      const csp = mainRouteConfig?.headers.find((entry) => entry.key === 'Content-Security-Policy');
      expect(csp).toBeDefined();
      expect(csp?.value).toContain("'unsafe-eval'");
      expect(csp?.value).toContain("'wasm-unsafe-eval'");
      expect(csp?.value).toContain('https://challenges.cloudflare.com');
    });

    it('includes wasm-unsafe-eval across both production and development for WebAssembly E2EE', async () => {
      for (const env of ['production', 'development']) {
        (process.env as Record<string, string | undefined>).NODE_ENV = env;
        const headers = await resolveConfigHeaders();
        const csp = headers
          .find((h) => h.source === '/((?!embed).*)')
          ?.headers.find((entry) => entry.key === 'Content-Security-Policy');

        expect(csp?.value).toContain("'wasm-unsafe-eval'");
        if (env === 'production') {
          expect(csp?.value).not.toContain("'unsafe-eval'");
        }
      }
    });

    it('preserves embed route frame-ancestors * header', async () => {
      const headers = await resolveConfigHeaders();

      const embedRouteConfig = headers.find((h) => h.source === '/embed/:path*');
      expect(embedRouteConfig).toBeDefined();

      const csp = embedRouteConfig?.headers.find(
        (entry) => entry.key === 'Content-Security-Policy',
      );
      expect(csp).toBeDefined();
      expect(csp?.value).toBe('frame-ancestors *');
    });
  });

  describe('Phase 1 Report-Only header from middleware', () => {
    it('sends Content-Security-Policy-Report-Only with nonce and strict directives on HTML responses', () => {
      const req = new NextRequest('http://localhost:3000/');
      const res = middleware(req);

      const reportOnlyHeader = res.headers.get('Content-Security-Policy-Report-Only');
      expect(reportOnlyHeader).toBeDefined();
      expect(reportOnlyHeader).toContain("default-src 'self'");
      expect(reportOnlyHeader).toContain("'strict-dynamic'");
      expect(reportOnlyHeader).toContain('report-uri /api/csp-report');
      expect(reportOnlyHeader).toMatch(/'nonce-[A-Za-z0-9+/=]+'/);
    });

    it('sends Content-Security-Policy-Report-Only with frame-ancestors * on embed responses', () => {
      const req = new NextRequest('http://localhost:3000/embed/video-123');
      const res = middleware(req);

      const reportOnlyHeader = res.headers.get('Content-Security-Policy-Report-Only');
      expect(reportOnlyHeader).toBeDefined();
      expect(reportOnlyHeader).toContain('frame-ancestors *');
      expect(reportOnlyHeader).toContain('report-uri /api/csp-report');
      expect(reportOnlyHeader).toMatch(/'nonce-[A-Za-z0-9+/=]+'/);
    });
  });
});
