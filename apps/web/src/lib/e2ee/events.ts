/**
 * The plaintext inside a Megolm message (ADR-049 SOC-3 addenda). chat-svc never sees it, so its shape lives here,
 * in one place, and every incoming event is validated before use: anything unknown or malformed is shown as
 * "Tin nhắn không hỗ trợ" instead of being trusted.
 *
 * SOC-3a: `{"type":"text","body":"…"}`.
 * SOC-3b: a text event may carry `attachments` (≤ 10). Each one holds what is needed to fetch and decrypt the file;
 * the file key never leaves the encrypted event.
 */

export const ATTACHMENT_REF_VERSION = 1;
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;
/** A thumbnail is a small WebP inlined in the event (base64, ≤ 8 KiB decoded). */
export const MAX_THUMB_BYTES = 8 * 1024;

export interface AttachmentRef {
  v: typeof ATTACHMENT_REF_VERSION;
  /** chat-svc attachment id (used to download the ciphertext). */
  id: string;
  /** AES-256-GCM key, 32 bytes, base64. */
  key: string;
  /** AES-GCM IV, 12 bytes, base64. */
  iv: string;
  /** SHA-256 of the ciphertext, base64: checked before decrypting. */
  sha256: string;
  mime: string;
  name: string;
  /** Plaintext size in bytes. */
  size: number;
  width?: number;
  height?: number;
  /** WebP thumbnail, base64 (images only). */
  thumb?: string;
}

export interface TextEvent {
  type: 'text';
  body: string;
  attachments?: AttachmentRef[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function isBase64OfLength(value: unknown, bytes: number): value is string {
  return (
    typeof value === 'string' &&
    BASE64.test(value) &&
    Math.floor((value.length * 3) / 4) -
      (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0) ===
      bytes
  );
}

function isPositiveInt(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= max;
}

export function parseAttachmentRef(value: unknown): AttachmentRef | null {
  if (typeof value !== 'object' || value === null) return null;
  const r = value as Record<string, unknown>;
  if (r.v !== ATTACHMENT_REF_VERSION) return null;
  if (typeof r.id !== 'string' || !UUID.test(r.id)) return null;
  if (
    !isBase64OfLength(r.key, 32) ||
    !isBase64OfLength(r.iv, 12) ||
    !isBase64OfLength(r.sha256, 32)
  ) {
    return null;
  }
  if (typeof r.mime !== 'string' || r.mime.length > 255 || !/^[\w.+-]+\/[\w.+-]+$/.test(r.mime))
    return null;
  if (typeof r.name !== 'string' || r.name.length === 0 || r.name.length > 255) return null;
  if (!isPositiveInt(r.size, 25 * 1024 * 1024)) return null;
  if (r.width !== undefined && !isPositiveInt(r.width, 20_000)) return null;
  if (r.height !== undefined && !isPositiveInt(r.height, 20_000)) return null;
  if (
    r.thumb !== undefined &&
    (typeof r.thumb !== 'string' ||
      !BASE64.test(r.thumb) ||
      (r.thumb.length * 3) / 4 > MAX_THUMB_BYTES + 2)
  ) {
    return null;
  }
  return {
    v: ATTACHMENT_REF_VERSION,
    id: r.id,
    key: r.key,
    iv: r.iv,
    sha256: r.sha256,
    mime: r.mime,
    name: r.name,
    size: r.size,
    ...(r.width !== undefined ? { width: r.width as number } : {}),
    ...(r.height !== undefined ? { height: r.height as number } : {}),
    ...(r.thumb !== undefined ? { thumb: r.thumb as string } : {}),
  };
}

/** Parses a decrypted plaintext; null when it is not a well-formed event this client understands. */
export function parseChatEvent(plaintext: string): TextEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const e = parsed as Record<string, unknown>;
  if (e.type !== 'text' || typeof e.body !== 'string' || e.body.length > 4000) return null;
  if (e.attachments === undefined) return { type: 'text', body: e.body };
  if (!Array.isArray(e.attachments) || e.attachments.length > MAX_ATTACHMENTS_PER_MESSAGE)
    return null;
  const attachments = e.attachments.map(parseAttachmentRef);
  if (attachments.some((a) => a === null)) return null;
  return { type: 'text', body: e.body, attachments: attachments as AttachmentRef[] };
}

export function serializeTextEvent(body: string, attachments: AttachmentRef[] = []): string {
  const event: TextEvent = { type: 'text', body: body.slice(0, 4000) };
  if (attachments.length > 0) event.attachments = attachments;
  return JSON.stringify(event);
}
