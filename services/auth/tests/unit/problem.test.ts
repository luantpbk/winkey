import { describe, it, expect } from 'vitest';
import { ProblemError } from '../../src/errors/problem.js';

describe('problem (RFC 9457)', () => {
  it('formats standard problem document with code and errors', () => {
    const error = ProblemError.badRequest('Validation failed', [
      { field: 'email', message: 'Invalid email' },
    ]);

    const doc = error.toProblemDocument('/v1/auth/register');
    expect(doc.status).toBe(400);
    expect(doc.title).toBe('Bad Request');
    expect(doc.detail).toBe('Validation failed');
    expect(doc.code).toBe('BAD_REQUEST');
    expect(doc.instance).toBe('/v1/auth/register');
    expect(doc.errors).toEqual([{ field: 'email', message: 'Invalid email' }]);
    expect(doc.type).toContain('https://winkey.vn/problems/');
  });

  it('formats conflict error with custom code', () => {
    const error = ProblemError.conflict('Email is already registered', 'EMAIL_TAKEN');
    const doc = error.toProblemDocument();

    expect(doc.status).toBe(409);
    expect(doc.code).toBe('EMAIL_TAKEN');
    expect(doc.detail).toBe('Email is already registered');
  });

  it('formats tooManyRequests with Retry-After header', () => {
    const error = ProblemError.tooManyRequests(30);
    expect(error.status).toBe(429);
    expect(error.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(error.headers?.['Retry-After']).toBe('30');
  });
});
