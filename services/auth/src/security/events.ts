import { v7 as uuidv7 } from 'uuid';
import type { Database, SecurityEventKind } from '../db/types.js';
import type { Kysely, Transaction } from 'kysely';

export interface RecordSecurityEventOptions {
  userId: string;
  kind: SecurityEventKind;
  sessionId?: string | null;
  deviceLabel?: string | null;
  country?: string | null;
  details?: Record<string, unknown>;
}

export async function recordSecurityEvent(
  dbOrTrx: Kysely<Database> | Transaction<Database>,
  options: RecordSecurityEventOptions,
): Promise<string> {
  const id = uuidv7();
  await dbOrTrx
    .insertInto('auth.security_events')
    .values({
      id,
      user_id: options.userId,
      kind: options.kind,
      session_id: options.sessionId ?? null,
      device_label: options.deviceLabel ?? null,
      country: options.country ?? null,
      details: options.details ? JSON.stringify(options.details) : '{}',
      created_at: new Date(),
    })
    .execute();

  return id;
}
