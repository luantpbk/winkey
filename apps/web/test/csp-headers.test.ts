import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import nextConfig from '../next.config';
import middleware from '../src/middleware';

describe('Content-Security-Policy headers in next.config.ts & middleware (CSP1 Phase 2 Enforce)', () => {
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
    return (await config.headers?.()) || [];
  }

  describe('next.config.ts (Phase 2: old unsafe-inline CSP headers removed)', () => {
    it('has removed old CSP headers so middleware exclusively enforces CSP', async () => {
      const headers = await resolveConfigHeaders();
      const hasCspHeader = headers.some((h) =>
        h.headers.some((entry) => entry.key.toLowerCase() === 'content-security-policy'),
      );
      expect(hasCspHeader).toBe(false);
    });
  });

  describe('Phase 2 Enforce header from middleware', () => {
    it('sends Content-Security-Policy (enforce mode, not Report-Only) with nonce and strict directives on HTML responses', () => {
      const req = new NextRequest('http://localhost:3000/');
      const res = middleware(req);

      expect(res.headers.get('Content-Security-Policy-Report-Only')).toBeNull();

      const csp = res.headers.get('Content-Security-Policy');
      expect(csp).toBeDefined();
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("'strict-dynamic'");
      expect(csp).toContain("'wasm-unsafe-eval'");
      expect(csp).toContain('report-uri /api/csp-report');
      expect(csp).toMatch(/'nonce-[A-Za-z0-9+/=]+'/);
    });

    it('sends Content-Security-Policy with frame-ancestors * on embed responses without Report-Only', () => {
      const req = new NextRequest('http://localhost:3000/embed/video-123');
      const res = middleware(req);

      expect(res.headers.get('Content-Security-Policy-Report-Only')).toBeNull();

      const csp = res.headers.get('Content-Security-Policy');
      expect(csp).toBeDefined();
      expect(csp).toContain('frame-ancestors *');
      expect(csp).toContain('report-uri /api/csp-report');
      expect(csp).toMatch(/'nonce-[A-Za-z0-9+/=]+'/);
    });

    it('sends upgrade-insecure-requests only when HTTPS (via x-forwarded-proto or https scheme)', () => {
      // Plain HTTP
      const httpReq = new NextRequest('http://localhost:3000/');
      const httpRes = middleware(httpReq);
      expect(httpRes.headers.get('Content-Security-Policy')).not.toContain(
        'upgrade-insecure-requests',
      );

      // HTTPS via x-forwarded-proto
      const protoReq = new NextRequest('http://localhost:3000/', {
        headers: { 'x-forwarded-proto': 'https' },
      });
      const protoRes = middleware(protoReq);
      expect(protoRes.headers.get('Content-Security-Policy')).toContain(
        'upgrade-insecure-requests',
      );

      // HTTPS scheme
      const httpsReq = new NextRequest('https://winkey.vn/');
      const httpsRes = middleware(httpsReq);
      expect(httpsRes.headers.get('Content-Security-Policy')).toContain(
        'upgrade-insecure-requests',
      );
    });
  });
});
