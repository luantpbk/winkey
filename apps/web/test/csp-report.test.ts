import { describe, it, expect, beforeEach, vi } from 'vitest';
import { POST } from '../src/app/api/csp-report/route';
import {
  stripQueryAndFragment,
  resetRateLimitsForTest,
} from '../src/lib/security/csp-report';

describe('/api/csp-report route handler', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetRateLimitsForTest();
  });

  describe('stripQueryAndFragment', () => {
    it('strips query parameters and fragments from standard URLs', () => {
      expect(stripQueryAndFragment('https://winkey.vn/watch/video-123?token=secret#t=30')).toBe(
        'https://winkey.vn/watch/video-123',
      );
      expect(stripQueryAndFragment('https://evil.com/payload.js?attack=1#frag')).toBe(
        'https://evil.com/payload.js',
      );
    });

    it('strips query and fragment from relative or special URIs', () => {
      expect(stripQueryAndFragment('/api/data?foo=bar#section')).toBe('/api/data');
      expect(stripQueryAndFragment('inline?unused=true#here')).toBe('inline');
      expect(stripQueryAndFragment('blob:https://winkey.vn/guid?query=1#hash')).toBe(
        'blob:https://winkey.vn/guid',
      );
      expect(stripQueryAndFragment('')).toBe('');
      expect(stripQueryAndFragment(null)).toBe('');
    });
  });

  describe('POST handler', () => {
    it('handles legacy application/csp-report payload and logs sanitized JSON line', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const body = {
        'csp-report': {
          'document-uri': 'https://winkey.vn/watch/123?query=token#frag',
          'blocked-uri': 'https://malicious.com/tracker.js?key=123#ref',
          'effective-directive': 'script-src-elem',
          disposition: 'report',
          'status-code': 200,
        },
      };

      const request = new Request('http://localhost:3000/api/csp-report', {
        method: 'POST',
        headers: {
          'content-type': 'application/csp-report',
          'x-forwarded-for': '203.0.113.195, 10.0.0.1',
        },
        body: JSON.stringify(body),
      });

      const response = await POST(request);
      expect(response.status).toBe(204);

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const loggedJson = JSON.parse(warnSpy.mock.calls[0][0]);
      expect(loggedJson).toEqual({
        event: 'csp_violation',
        effective_directive: 'script-src-elem',
        blocked_uri: 'https://malicious.com/tracker.js',
        document_uri: 'https://winkey.vn/watch/123',
        disposition: 'report',
        status_code: 200,
      });

      // Confirm sensitive data (IP, query, cookies) is not in log
      const rawLog = warnSpy.mock.calls[0][0];
      expect(rawLog).not.toContain('203.0.113.195');
      expect(rawLog).not.toContain('token');
      expect(rawLog).not.toContain('frag');
    });

    it('handles modern Reporting API application/reports+json array payload', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const reports = [
        {
          type: 'csp-violation',
          url: 'https://winkey.vn/login?returnTo=/dashboard#anchor',
          body: {
            blockedURL: 'https://cdn.attacker.org/evil.css?param=sensitive#frag',
            documentURL: 'https://winkey.vn/login?returnTo=/dashboard#anchor',
            effectiveDirective: 'style-src-elem',
            disposition: 'report',
            statusCode: 200,
          },
        },
      ];

      const request = new Request('http://localhost:3000/api/csp-report', {
        method: 'POST',
        headers: {
          'content-type': 'application/reports+json',
          'x-forwarded-for': '198.51.100.5',
        },
        body: JSON.stringify(reports),
      });

      const response = await POST(request);
      expect(response.status).toBe(204);

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const loggedJson = JSON.parse(warnSpy.mock.calls[0][0]);
      expect(loggedJson).toEqual({
        event: 'csp_violation',
        effective_directive: 'style-src-elem',
        blocked_uri: 'https://cdn.attacker.org/evil.css',
        document_uri: 'https://winkey.vn/login',
        disposition: 'report',
        status_code: 200,
      });
    });

    it('returns 413 when body exceeds 8 KiB (8192 bytes)', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const largeString = 'a'.repeat(8193);
      const request = new Request('http://localhost:3000/api/csp-report', {
        method: 'POST',
        headers: {
          'content-type': 'application/csp-report',
          'content-length': String(Buffer.byteLength(largeString)),
        },
        body: largeString,
      });

      const response = await POST(request);
      expect(response.status).toBe(413);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('enforces 60 reports/min rate limit per client IP, dropping excess reports while returning 204', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const payload = JSON.stringify({
        'csp-report': {
          'document-uri': 'https://winkey.vn/home',
          'blocked-uri': 'inline',
          'effective-directive': 'script-src',
        },
      });

      const clientIp = '192.0.2.45';

      // Send 60 requests -> all should be logged and return 204
      for (let i = 0; i < 60; i++) {
        const req = new Request('http://localhost:3000/api/csp-report', {
          method: 'POST',
          headers: {
            'content-type': 'application/csp-report',
            'x-forwarded-for': clientIp,
          },
          body: payload,
        });
        const res = await POST(req);
        expect(res.status).toBe(204);
      }
      expect(warnSpy).toHaveBeenCalledTimes(60);

      // 61st request from same IP -> dropped (no log), returns 204
      const req61 = new Request('http://localhost:3000/api/csp-report', {
        method: 'POST',
        headers: {
          'content-type': 'application/csp-report',
          'x-forwarded-for': clientIp,
        },
        body: payload,
      });
      const res61 = await POST(req61);
      expect(res61.status).toBe(204);
      expect(warnSpy).toHaveBeenCalledTimes(60);

      // Different IP is still allowed
      const reqOtherIp = new Request('http://localhost:3000/api/csp-report', {
        method: 'POST',
        headers: {
          'content-type': 'application/csp-report',
          'x-forwarded-for': '192.0.2.99',
        },
        body: payload,
      });
      const resOtherIp = await POST(reqOtherIp);
      expect(resOtherIp.status).toBe(204);
      expect(warnSpy).toHaveBeenCalledTimes(61);
    });
  });
});
