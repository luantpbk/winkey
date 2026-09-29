import { describe, it, expect } from 'vitest';
import { ProblemError } from '../../src/errors/problem.js';

describe('ProblemError & RFC 9457 Document', () => {
  it('creates badRequest with code and errors', () => {
    const err = ProblemError.badRequest(
      'Invalid body',
      [{ field: 'body', message: 'Too long' }],
      'INVALID_BODY',
    );
    expect(err.status).toBe(400);
    expect(err.code).toBe('INVALID_BODY');
    const doc = err.toProblemDocument('/v1/test');
    expect(doc.status).toBe(400);
    expect(doc.title).toBe('Bad Request');
    expect(doc.detail).toBe('Invalid body');
    expect(doc.code).toBe('INVALID_BODY');
    expect(doc.instance).toBe('/v1/test');
    expect(doc.errors).toHaveLength(1);
    expect(doc.errors![0].field).toBe('body');
  });

  it('creates tooManyRequests with Retry-After header', () => {
    const err = ProblemError.tooManyRequests(30, 'Slow down');
    expect(err.status).toBe(429);
    expect(err.headers?.['Retry-After']).toBe('30');
    const doc = err.toProblemDocument();
    expect(doc.status).toBe(429);
    expect(doc.code).toBe('RATE_LIMIT_EXCEEDED');
  });

  it('creates notFound and conflict errors', () => {
    const notFound = ProblemError.notFound('Resource missing', 'RESOURCE_NOT_FOUND');
    expect(notFound.status).toBe(404);
    expect(notFound.code).toBe('RESOURCE_NOT_FOUND');

    const conflict = ProblemError.conflict('Already exists', 'ALREADY_EXISTS');
    expect(conflict.status).toBe(409);
    expect(conflict.code).toBe('ALREADY_EXISTS');
  });
});
