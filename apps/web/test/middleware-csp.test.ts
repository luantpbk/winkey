import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import middleware, { config } from '../src/middleware';

describe('Middleware CSP & Redirects (CSP1)', () => {
  it('generates different nonces for distinct requests', () => {
    const req1 = new NextRequest('http://localhost:3000/');
    const res1 = middleware(req1);
    const csp1 = res1.headers.get('Content-Security-Policy-Report-Only');

    const req2 = new NextRequest('http://localhost:3000/');
    const res2 = middleware(req2);
    const csp2 = res2.headers.get('Content-Security-Policy-Report-Only');

    expect(csp1).toBeDefined();
    expect(csp2).toBeDefined();
    expect(csp1).not.toBe(csp2);

    const nonce1Match = csp1?.match(/'nonce-([^']+)'/);
    const nonce2Match = csp2?.match(/'nonce-([^']+)'/);
    expect(nonce1Match).not.toBeNull();
    expect(nonce2Match).not.toBeNull();
    expect(nonce1Match![1]).not.toBe(nonce2Match![1]);
  });

  it('sets identical nonce on request x-nonce and response Content-Security-Policy-Report-Only', () => {
    const req = new NextRequest('http://localhost:3000/kham-pha');
    const res = middleware(req);

    const cspReportOnly = res.headers.get('Content-Security-Policy-Report-Only');
    expect(cspReportOnly).toBeDefined();

    const nonceMatch = cspReportOnly?.match(/'nonce-([^']+)'/);
    expect(nonceMatch).not.toBeNull();
    const nonceInCsp = nonceMatch![1];

    // In Next.js middleware, modified request headers passed downstream are encoded in x-middleware-request-x-nonce
    const forwardedNonce = res.headers.get('x-middleware-request-x-nonce');
    expect(forwardedNonce).toBe(nonceInCsp);
  });

  it('/embed/:id receives embed policy (frame-ancestors *) and no locale redirect', () => {
    const req = new NextRequest('http://localhost:3000/embed/video-abc-123');
    const res = middleware(req);

    // Must not be a redirect
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();

    const csp = res.headers.get('Content-Security-Policy-Report-Only');
    expect(csp).toBeDefined();
    expect(csp).toContain('frame-ancestors *');
    expect(csp).not.toContain("frame-ancestors 'self'");

    const forwardedNonce = res.headers.get('x-middleware-request-x-nonce');
    expect(forwardedNonce).toBeTruthy();
  });

  describe('Existing redirect preservation', () => {
    it('redirects /phim and /<locale>/phim to / and /<locale>', () => {
      const req1 = new NextRequest('http://localhost:3000/phim');
      const res1 = middleware(req1);
      expect(res1.status).toBe(308);
      expect(res1.headers.get('location')).toBe('http://localhost:3000/');

      const req2 = new NextRequest('http://localhost:3000/en/phim');
      const res2 = middleware(req2);
      expect(res2.status).toBe(308);
      expect(res2.headers.get('location')).toBe('http://localhost:3000/en');
    });

    it('redirects /?tab=<x> to /kham-pha?tab=<x>', () => {
      const req1 = new NextRequest('http://localhost:3000/?tab=trending');
      const res1 = middleware(req1);
      expect(res1.status).toBe(308);
      expect(res1.headers.get('location')).toBe('http://localhost:3000/kham-pha?tab=trending');

      const req2 = new NextRequest('http://localhost:3000/en?tab=latest');
      const res2 = middleware(req2);
      expect(res2.status).toBe(308);
      expect(res2.headers.get('location')).toBe('http://localhost:3000/en/kham-pha?tab=latest');
    });

    it('redirects /<locale>/embed/... to /embed/...', () => {
      const reqVi = new NextRequest('http://localhost:3000/vi/embed/video-uuid');
      const resVi = middleware(reqVi);
      expect(resVi.status).toBe(308);
      expect(resVi.headers.get('location')).toBe('http://localhost:3000/embed/video-uuid');

      const reqEn = new NextRequest('http://localhost:3000/en/embed/video-uuid');
      const resEn = middleware(reqEn);
      expect(resEn.status).toBe(308);
      expect(resEn.headers.get('location')).toBe('http://localhost:3000/embed/video-uuid');
    });

    it('redirects /@handle and /<locale>/@handle to /c/handle', () => {
      const req1 = new NextRequest('http://localhost:3000/@filmmaker');
      const res1 = middleware(req1);
      expect(res1.status).toBe(308);
      expect(res1.headers.get('location')).toBe('http://localhost:3000/c/filmmaker');

      const req2 = new NextRequest('http://localhost:3000/en/@filmmaker');
      const res2 = middleware(req2);
      expect(res2.status).toBe(308);
      expect(res2.headers.get('location')).toBe('http://localhost:3000/en/c/filmmaker');
    });
  });

  describe('Config matcher pattern', () => {
    it('is configured with runtime: nodejs', () => {
      expect(config.runtime).toBe('nodejs');
    });

    it('matches HTML routes and embed, while excluding static, v1, healthz, readyz, and api/csp-report', () => {
      const matcherPattern = new RegExp('^' + config.matcher[0] + '$');

      // Routes that SHOULD match middleware:
      expect(matcherPattern.test('/')).toBe(true);
      expect(matcherPattern.test('/vi')).toBe(true);
      expect(matcherPattern.test('/watch/123')).toBe(true);
      expect(matcherPattern.test('/embed/123')).toBe(true);
      expect(matcherPattern.test('/bang-tin')).toBe(true);
      expect(matcherPattern.test('/studio')).toBe(true);

      // Routes that SHOULD NOT match:
      expect(matcherPattern.test('/_next/static/chunks/main.js')).toBe(false);
      expect(matcherPattern.test('/_next/image')).toBe(false);
      expect(matcherPattern.test('/v1/videos/123')).toBe(false);
      expect(matcherPattern.test('/healthz')).toBe(false);
      expect(matcherPattern.test('/readyz')).toBe(false);
      expect(matcherPattern.test('/api/csp-report')).toBe(false);
      expect(matcherPattern.test('/favicon.ico')).toBe(false);
      expect(matcherPattern.test('/mockServiceWorker.js')).toBe(false);
    });
  });
});
