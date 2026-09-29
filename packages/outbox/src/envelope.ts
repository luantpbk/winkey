import { v7 as uuidv7 } from 'uuid';
import type { EventEnvelope, EnqueueOptions } from './types.js';

/**
 * Extracts active W3C traceparent from OpenTelemetry context if available.
 */
function extractTraceparent(): string | undefined {
  try {
    // Dynamic check without hard failing if @opentelemetry/api is not installed
    const api = (globalThis as any)[Symbol.for('opentelemetry.js.api.1')];
    if (api?.trace?.getActiveSpan) {
      const span = api.trace.getActiveSpan();
      if (span) {
        const ctx = span.spanContext();
        if (ctx && ctx.traceId && ctx.spanId) {
          const flags = (ctx.traceFlags ?? 1).toString(16).padStart(2, '0');
          return `00-${ctx.traceId}-${ctx.spanId}-${flags}`;
        }
      }
    }
  } catch {
    // Ignore OTel extraction errors
  }
  return undefined;
}

/**
 * Builds an EventEnvelope compliant with contracts/events/envelope.schema.json.
 */
export function buildEnvelope<T = Record<string, unknown>>(
  subject: string,
  data: T,
  options: EnqueueOptions = {},
): EventEnvelope<T> {
  const event_id = options.eventId || uuidv7();
  const producer = options.producer || process.env.SERVICE_NAME || 'winkey-service';
  const version = options.version ?? 1;
  const occurred_at = new Date().toISOString();
  const traceparent = options.traceparent || extractTraceparent();

  const envelope: EventEnvelope<T> = {
    event_id,
    type: subject,
    version,
    occurred_at,
    producer,
    data,
  };

  if (traceparent) {
    envelope.traceparent = traceparent;
  }

  return envelope;
}
