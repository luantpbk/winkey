import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  buildCsp,
  generateNonce,
  isValidOrigin,
  validateOrigin,
  resetWarnedOriginsForTest,
} from '../src/lib/security/csp';

describe('CSP Policy Builder (buildCsp / CSP1)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.restoreAllMocks();
    resetWarnedOriginsForTest();
    process.env = { ...originalEnv };
    delete process.env.CSP_MEDIA_ORIGIN;
    delete process.env.CSP_UPLOAD_ORIGIN;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('generates a 16-byte base64 nonce', () => {
    const nonce1 = generateNonce();
    const nonce2 = generateNonce();

    expect(nonce1).toBeTypeOf('string');
    expect(nonce2).toBeTypeOf('string');
    expect(nonce1).not.toBe(nonce2);

    const buffer = Buffer.from(nonce1, 'base64');
    expect(buffer.length).toBe(16);
  });

  it('validates origins correctly according to new URL(x).origin === x', () => {
    expect(isValidOrigin('https://media.winkey.vn')).toBe(true);
    expect(isValidOrigin('http://localhost:9000')).toBe(true);
    expect(isValidOrigin('https://s3.ap-southeast-1.amazonaws.com')).toBe(true);

    // Invalid origins:
    expect(isValidOrigin('https://media.winkey.vn/')).toBe(false); // trailing slash
    expect(isValidOrigin('https://media.winkey.vn/path')).toBe(false); // path
    expect(isValidOrigin('*')).toBe(false); // wildcard
    expect(isValidOrigin("'self'")).toBe(false);
    expect(isValidOrigin('not-a-url')).toBe(false);
    expect(isValidOrigin('')).toBe(false);
    expect(isValidOrigin(null)).toBe(false);
    expect(isValidOrigin(undefined)).toBe(false);
  });

  it('logs a warning once when an origin is invalid and drops it', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const first = validateOrigin('invalid-origin', 'CSP_MEDIA_ORIGIN');
    expect(first).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[csp] ignoring invalid origin for CSP_MEDIA_ORIGIN: "invalid-origin"'),
    );

    // Second validation of identical invalid origin does not log again
    const second = validateOrigin('invalid-origin', 'CSP_MEDIA_ORIGIN');
    expect(second).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('production: has no unsafe-inline or unsafe-eval in script-src, and nonce appears exactly once', () => {
    const nonce = 'dGVzdG5vbmNlMTIzNDU2Nw==';
    const policy = buildCsp({ nonce, isDev: false });

    // Nonce appears exactly once in the entire policy
    const nonceMatches = policy.match(/nonce-dGVzdG5vbmNlMTIzNDU2Nw==/g);
    expect(nonceMatches).not.toBeNull();
    expect(nonceMatches?.length).toBe(1);

    const scriptSrcMatch = policy.match(/script-src ([^;]+)/);
    expect(scriptSrcMatch).not.toBeNull();
    const scriptSrc = scriptSrcMatch![1];

    expect(scriptSrc).toContain("'self'");
    expect(scriptSrc).toContain("'strict-dynamic'");
    expect(scriptSrc).toContain(`'nonce-${nonce}'`);
    expect(scriptSrc).toContain('https://challenges.cloudflare.com');
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
  });

  it('development: adds unsafe-eval to script-src for HMR', () => {
    const nonce = 'devnonce1234567890==';
    const policy = buildCsp({ nonce, isDev: true });

    const scriptSrcMatch = policy.match(/script-src ([^;]+)/);
    expect(scriptSrcMatch).not.toBeNull();
    const scriptSrc = scriptSrcMatch![1];

    expect(scriptSrc).toContain("'unsafe-eval'");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).toContain(`'nonce-${nonce}'`);
  });

  it('embed: true emits frame-ancestors *, non-embed emits frame-ancestors \'self\'', () => {
    const nonce = 'embednonce12345678==';
    const embedPolicy = buildCsp({ nonce, embed: true });
    expect(embedPolicy).toContain('frame-ancestors *');
    expect(embedPolicy).not.toContain("frame-ancestors 'self'");

    const standardPolicy = buildCsp({ nonce, embed: false });
    expect(standardPolicy).toContain("frame-ancestors 'self'");
    expect(standardPolicy).not.toContain('frame-ancestors *');
  });

  it('never emits * outside frame-ancestors even if passed as mediaOrigin or uploadOrigin', () => {
    const nonce = 'safenonce123456789==';
    const policy = buildCsp({
      nonce,
      embed: false,
      mediaOrigin: '*',
      uploadOrigin: '*',
    });

    expect(policy).not.toContain('*');
    expect(policy).toContain("frame-ancestors 'self'");
  });

  it('includes valid mediaOrigin and uploadOrigin in img-src, media-src, connect-src', () => {
    const nonce = 'originnonse1234567==';
    const mediaOrigin = 'https://media.winkey.vn';
    const uploadOrigin = 'https://upload.winkey.vn';

    const policy = buildCsp({
      nonce,
      mediaOrigin,
      uploadOrigin,
    });

    expect(policy).toContain(`img-src 'self' data: blob: ${mediaOrigin}`);
    expect(policy).toContain(`media-src 'self' blob: ${mediaOrigin}`);
    expect(policy).toContain(`connect-src 'self' ${mediaOrigin} ${uploadOrigin} https://challenges.cloudflare.com`);
  });

  it('deduplicates connect-src when mediaOrigin and uploadOrigin are identical', () => {
    const nonce = 'originnonse1234567==';
    const sharedOrigin = 'https://cdn.winkey.vn';

    const policy = buildCsp({
      nonce,
      mediaOrigin: sharedOrigin,
      uploadOrigin: sharedOrigin,
    });

    const connectSrcMatch = policy.match(/connect-src ([^;]+)/);
    expect(connectSrcMatch).not.toBeNull();
    const connectSrc = connectSrcMatch![1];

    const occurrences = connectSrc.split(' ').filter((o) => o === sharedOrigin).length;
    expect(occurrences).toBe(1);
  });

  it('contains all required ADR-049 directives', () => {
    const nonce = 'allrulesnonce12345==';
    const policy = buildCsp({ nonce, isDev: false });

    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("style-src 'self' 'unsafe-inline'");
    expect(policy).toContain("worker-src 'self' blob:");
    expect(policy).toContain('frame-src https://challenges.cloudflare.com');
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("base-uri 'self'");
    expect(policy).toContain("form-action 'self'");
    expect(policy).toContain('upgrade-insecure-requests');
    expect(policy).toContain('report-uri /api/csp-report');
  });
});
