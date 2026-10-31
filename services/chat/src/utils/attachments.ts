import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database, AttachmentState } from '../db/types.js';

export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
export const ATTACHMENT_QUOTA_BYTES = 1024 * 1024 * 1024;
export const ATTACHMENTS_PER_MESSAGE = 10;
export const UPLOAD_URL_TTL_SECONDS = 15 * 60;
export const DOWNLOAD_URL_TTL_SECONDS = 5 * 60;
/** An attachment no message references after this long is deleted by the janitor. */
export const UNLINKED_ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1000;

export interface AttachmentRow {
  id: string;
  conversation_id: string;
  size_bytes: string | number;
  state: AttachmentState;
  expires_at: Date | string;
  created_at: Date | string;
}

export interface AttachmentDto {
  id: string;
  conversation_id: string;
  size_bytes: number;
  state: AttachmentState;
  expires_at: string;
  created_at: string;
}

export function toAttachmentDto(row: AttachmentRow): AttachmentDto {
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    size_bytes: Number(row.size_bytes),
    state: row.state,
    expires_at: new Date(row.expires_at).toISOString(),
    created_at: new Date(row.created_at).toISOString(),
  };
}

/**
 * Attachments of a page of messages, in one query (never one per message), grouped by seq. Messages without
 * attachments are absent from the map; SYSTEM and deleted messages never have any (deleting a message deletes
 * its attachment rows).
 */
export async function loadAttachmentsBySeq(
  db: Kysely<Database> | Transaction<Database>,
  conversationId: string,
  seqs: Array<string | number>,
): Promise<Map<string, AttachmentDto[]>> {
  const bySeq = new Map<string, AttachmentDto[]>();
  if (seqs.length === 0) return bySeq;
  const res = await sql<AttachmentRow & { message_seq: string }>`
    SELECT id, conversation_id, size_bytes, state, expires_at, created_at, message_seq
    FROM chat.attachments
    WHERE conversation_id = ${conversationId}::uuid
      AND message_seq = ANY(${seqs.map(String)}::bigint[])
    ORDER BY message_seq, id
  `.execute(db);
  for (const row of res.rows) {
    const key = String(row.message_seq);
    const list = bySeq.get(key) ?? [];
    list.push(toAttachmentDto(row));
    bySeq.set(key, list);
  }
  return bySeq;
}
