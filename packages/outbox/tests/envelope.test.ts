import { describe, it, expect } from 'vitest';
import { buildEnvelope } from '../src/envelope.js';
import { validate as isValidUuid, version as uuidVersion } from 'uuid';

describe('buildEnvelope', () => {
  it('builds a valid envelope with UUIDv7 event_id', () => {
    const data = { user_id: '0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c0d', handle: 'alice' };
    const envelope = buildEnvelope('user.registered', data, {
      producer: 'auth-svc',
      version: 1,
    });

    expect(envelope.type).toBe('user.registered');
    expect(envelope.producer).toBe('auth-svc');
    expect(envelope.version).toBe(1);
    expect(envelope.data).toEqual(data);
    expect(isValidUuid(envelope.event_id)).toBe(true);
    expect(uuidVersion(envelope.event_id)).toBe(7);

    // Verify occurred_at is valid ISO 8601 date
    const date = new Date(envelope.occurred_at);
    expect(date.toISOString()).toBe(envelope.occurred_at);
  });

  it('includes custom traceparent when provided', () => {
    const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    const envelope = buildEnvelope('user.registered', {}, { traceparent });
    expect(envelope.traceparent).toBe(traceparent);
  });

  it('respects explicitly provided eventId if given', () => {
    const explicitId = '018f3a2c-7b4d-7a31-9f20-1a2b3c4d5e6f';
    const envelope = buildEnvelope('user.registered', {}, { eventId: explicitId });
    expect(envelope.event_id).toBe(explicitId);
  });
});
