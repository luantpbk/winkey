import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import middleware from '../src/middleware';

// #548: Vietnamese is the product language; English only when the URL asks for it.
function visit(path: string, headers: Record<string, string> = {}) {
  return middleware(new NextRequest(`http://localhost:3000${path}`, { headers }));
}

describe('default locale', () => {
  it.each(['/', '/login', '/notifications'])(
    'an English browser stays in Vietnamese on %s',
    (path) => {
      const res = visit(path, { 'accept-language': 'en-US,en;q=0.9' });
      expect(res.headers.get('location')).toBeNull();
      expect(res.headers.get('x-middleware-rewrite')).toContain(`/vi${path === '/' ? '' : path}`);
    },
  );

  it('a cookie left by an earlier /en visit does not switch the language', () => {
    const res = visit('/login', { cookie: 'NEXT_LOCALE=en', 'accept-language': 'en-US' });
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('x-middleware-rewrite')).toContain('/vi/login');
  });

  it('an explicit /en URL is still English', () => {
    const res = visit('/en/login', { 'accept-language': 'vi-VN' });
    expect(res.headers.get('location')).toBeNull();
    expect(res.status).toBe(200);
    expect(res.headers.get('x-middleware-rewrite')).toContain('/en/login');
  });
});
