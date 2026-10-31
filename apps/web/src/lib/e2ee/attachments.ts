import { api } from '../api-client';
import { ATTACHMENT_REF_VERSION, MAX_THUMB_BYTES, type AttachmentRef } from './events';

/**
 * SOC-3b encrypted attachments (ADR-049 addendum 2026-10-31). The browser prepares the file (images: WebP, long
 * edge ≤ 1600 px, metadata dropped by re-encoding), encrypts it with a fresh AES-256-GCM key through WebCrypto,
 * uploads only ciphertext, and keeps key, IV and SHA-256 inside the Megolm event. Nothing here is ever logged.
 */

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const IMAGE_MAX_EDGE = 1600;
export const THUMB_EDGE = 64;
const IMAGE_QUALITY = 0.8;
const COMPRESSIBLE_IMAGES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/bmp',
  'image/avif',
]);

export class AttachmentError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'TOO_LARGE'
      | 'UPLOAD_FAILED'
      | 'CANCELLED'
      | 'EXPIRED'
      | 'NOT_FOUND'
      | 'INTEGRITY'
      | 'UNAVAILABLE'
      | 'FAILED',
  ) {
    super(message);
    this.name = 'AttachmentError';
  }
}

// --- base64 -------------------------------------------------------------------------------------------------------

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// --- crypto -------------------------------------------------------------------------------------------------------

export interface EncryptedFile {
  ciphertext: Uint8Array<ArrayBuffer>;
  key: string;
  iv: string;
  sha256: string;
}

export async function encryptFile(plaintext: Uint8Array<ArrayBuffer>): Promise<EncryptedFile> {
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext),
  );
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', ciphertext));
  return { ciphertext, key: toBase64(rawKey), iv: toBase64(iv), sha256: toBase64(digest) };
}

/** Checks the SHA-256 first: a ciphertext that does not match is never decrypted or shown. */
export async function decryptFile(
  ciphertext: Uint8Array<ArrayBuffer>,
  ref: Pick<AttachmentRef, 'key' | 'iv' | 'sha256'>,
): Promise<Uint8Array<ArrayBuffer>> {
  const digest = toBase64(new Uint8Array(await crypto.subtle.digest('SHA-256', ciphertext)));
  if (digest !== ref.sha256) {
    throw new AttachmentError('Tệp không khớp mã kiểm tra, có thể đã bị thay đổi.', 'INTEGRITY');
  }
  const key = await crypto.subtle.importKey('raw', fromBase64(ref.key), 'AES-GCM', false, [
    'decrypt',
  ]);
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(ref.iv) }, key, ciphertext),
    );
  } catch {
    throw new AttachmentError('Không thể giải mã tệp.', 'INTEGRITY');
  }
}

// --- preparing images ---------------------------------------------------------------------------------------------

/** Scales (w, h) so the long edge is at most `max`, keeping the ratio. Never upscales. */
export function fitWithin(
  width: number,
  height: number,
  max: number,
): { width: number; height: number } {
  const long = Math.max(width, height);
  if (long <= max) return { width, height };
  const scale = max / long;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export type ImageEncoder = (width: number, height: number, quality: number) => Promise<Blob>;

/**
 * Encodes a thumbnail at decreasing quality and size until it fits in 8 KiB; null when even the smallest does not
 * (the message is then sent without a thumbnail).
 */
export async function encodeThumbnail(
  sourceWidth: number,
  sourceHeight: number,
  encode: ImageEncoder,
): Promise<Uint8Array<ArrayBuffer> | null> {
  for (const edge of [THUMB_EDGE, 48, 32]) {
    const { width, height } = fitWithin(sourceWidth, sourceHeight, edge);
    for (const quality of [0.6, 0.4, 0.25]) {
      const blob = await encode(width, height, quality);
      if (blob.size <= MAX_THUMB_BYTES) return new Uint8Array(await blob.arrayBuffer());
    }
  }
  return null;
}

export interface PreparedFile {
  bytes: Uint8Array<ArrayBuffer>;
  mime: string;
  name: string;
  width?: number;
  height?: number;
  thumb?: string;
}

function webpName(name: string): string {
  const dot = name.lastIndexOf('.');
  return `${dot > 0 ? name.slice(0, dot) : name}.webp`.slice(0, 255);
}

async function drawEncoder(bitmap: ImageBitmap): Promise<ImageEncoder> {
  return async (width, height, quality) => {
    const canvas =
      typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(width, height)
        : Object.assign(document.createElement('canvas'), { width, height });
    const ctx = canvas.getContext('2d') as
      CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!ctx) throw new AttachmentError('Trình duyệt không xử lý được ảnh này.', 'FAILED');
    ctx.drawImage(bitmap, 0, 0, width, height);
    if (canvas instanceof OffscreenCanvas) {
      return canvas.convertToBlob({ type: 'image/webp', quality });
    }
    return new Promise<Blob>((resolve, reject) =>
      (canvas as HTMLCanvasElement).toBlob(
        (b) => (b ? resolve(b) : reject(new AttachmentError('Không nén được ảnh.', 'FAILED'))),
        'image/webp',
        quality,
      ),
    );
  };
}

/**
 * Images (JPEG, PNG, WebP, BMP, AVIF): decoded, scaled to ≤ 1600 px, re-encoded as WebP (which drops EXIF/GPS),
 * plus a thumbnail. GIFs and every other type are kept as they are. Anything over 25 MiB after this is refused.
 */
export async function prepareFile(file: File): Promise<PreparedFile> {
  if (COMPRESSIBLE_IMAGES.has(file.type) && typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(
      () => null,
    );
    if (bitmap) {
      try {
        const size = fitWithin(bitmap.width, bitmap.height, IMAGE_MAX_EDGE);
        const encode = await drawEncoder(bitmap);
        const main = await encode(size.width, size.height, IMAGE_QUALITY);
        const thumb = await encodeThumbnail(size.width, size.height, encode);
        const bytes = new Uint8Array(await main.arrayBuffer());
        if (bytes.length > MAX_ATTACHMENT_BYTES) {
          throw new AttachmentError('Ảnh vẫn lớn hơn 25 MB sau khi nén.', 'TOO_LARGE');
        }
        return {
          bytes,
          mime: 'image/webp',
          name: webpName(file.name || 'anh'),
          width: size.width,
          height: size.height,
          ...(thumb ? { thumb: toBase64(thumb) } : {}),
        };
      } finally {
        bitmap.close();
      }
    }
  }
  if (file.size > MAX_ATTACHMENT_BYTES) {
    throw new AttachmentError(`"${file.name}" lớn hơn 25 MB, không gửi được.`, 'TOO_LARGE');
  }
  return {
    bytes: new Uint8Array(await file.arrayBuffer()),
    mime:
      file.type && /^[\w.+-]+\/[\w.+-]+$/.test(file.type) ? file.type : 'application/octet-stream',
    name: (file.name || 'tep').slice(0, 255),
  };
}

// --- upload and download ------------------------------------------------------------------------------------------

function putWithProgress(
  url: string,
  headers: Record<string, string>,
  body: Uint8Array<ArrayBuffer>,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    for (const [name, value] of Object.entries(headers)) {
      // The browser sets Content-Length itself (a forbidden header); it equals body.length, which was signed.
      if (name.toLowerCase() !== 'content-length') xhr.setRequestHeader(name, value);
    }
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new AttachmentError('Tải tệp lên thất bại.', 'UPLOAD_FAILED'));
    xhr.onerror = () =>
      reject(new AttachmentError('Mất kết nối khi tải tệp lên.', 'UPLOAD_FAILED'));
    xhr.onabort = () => reject(new AttachmentError('Đã huỷ tải lên.', 'CANCELLED'));
    if (signal) {
      if (signal.aborted) return xhr.abort();
      signal.addEventListener('abort', () => xhr.abort(), { once: true });
    }
    xhr.send(body);
  });
}

function problemToError(status: number, code?: string): AttachmentError {
  if (status === 503) return new AttachmentError('Máy chủ chưa hỗ trợ gửi tệp.', 'UNAVAILABLE');
  if (status === 410 || code === 'ATTACHMENT_EXPIRED')
    return new AttachmentError('Tệp đã hết hạn', 'EXPIRED');
  if (status === 404) return new AttachmentError('Không tìm thấy tệp.', 'NOT_FOUND');
  if (code === 'ATTACHMENT_QUOTA') {
    return new AttachmentError(
      'Bạn đã dùng hết 1 GB dung lượng tệp. Hãy xoá bớt tin có tệp.',
      'TOO_LARGE',
    );
  }
  if (status === 429)
    return new AttachmentError('Bạn gửi tệp quá nhanh, thử lại sau.', 'UPLOAD_FAILED');
  return new AttachmentError('Không gửi được tệp.', 'UPLOAD_FAILED');
}

/** Prepare → encrypt → createAttachment → PUT → completeAttachment. Returns the ref to put in the Megolm event. */
export async function uploadAttachment(params: {
  conversationId: string;
  deviceId: string;
  prepared: PreparedFile;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}): Promise<AttachmentRef> {
  const { conversationId, deviceId, prepared, onProgress = () => {}, signal } = params;
  const enc = await encryptFile(prepared.bytes);
  if (enc.ciphertext.length > MAX_ATTACHMENT_BYTES) {
    throw new AttachmentError(`"${prepared.name}" lớn hơn 25 MB, không gửi được.`, 'TOO_LARGE');
  }

  const created = await api.chat.POST('/v1/chat/conversations/{conversation_id}/attachments', {
    params: { path: { conversation_id: conversationId } },
    body: { sender_device_id: deviceId, size_bytes: enc.ciphertext.length },
    signal,
  });
  if (!created.data) throw problemToError(created.response.status, created.error?.code);
  const attachmentId = created.data.attachment.id;

  await putWithProgress(
    created.data.upload_url,
    created.data.upload_headers,
    enc.ciphertext,
    onProgress,
    signal,
  );

  const done = await api.chat.POST(
    '/v1/chat/conversations/{conversation_id}/attachments/{attachment_id}/complete',
    { params: { path: { conversation_id: conversationId, attachment_id: attachmentId } }, signal },
  );
  if (!done.data) throw problemToError(done.response.status, done.error?.code);

  return {
    v: ATTACHMENT_REF_VERSION,
    id: attachmentId,
    key: enc.key,
    iv: enc.iv,
    sha256: enc.sha256,
    mime: prepared.mime,
    name: prepared.name,
    size: prepared.bytes.length,
    ...(prepared.width ? { width: prepared.width } : {}),
    ...(prepared.height ? { height: prepared.height } : {}),
    ...(prepared.thumb ? { thumb: prepared.thumb } : {}),
  };
}

// --- what may be rendered inline -----------------------------------------------------------------------------------
// `ref.mime` and `ref.name` come from the other user. Only these raster images and videos are rendered, and only when
// the decrypted bytes really are that format; everything else (SVG and HTML included) is a download of opaque bytes.

export type InlineImageType =
  'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' | 'image/avif';
export type InlineVideoType = 'video/mp4' | 'video/webm';
export type InlineType = InlineImageType | InlineVideoType;

const INLINE_IMAGE_TYPES: readonly string[] = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
];
const INLINE_VIDEO_TYPES: readonly string[] = ['video/mp4', 'video/webm'];

/** How a ref is shown before it is downloaded, from the claimed type only (the bytes are checked after decryption). */
export function attachmentKind(mime: string): 'image' | 'video' | 'file' {
  const base = mime.split(';')[0]!.trim().toLowerCase();
  if (INLINE_IMAGE_TYPES.includes(base)) return 'image';
  if (INLINE_VIDEO_TYPES.includes(base)) return 'video';
  return 'file';
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

/** The real format of decrypted bytes, by magic bytes, if it is one we render inline. */
export function sniffInlineType(bytes: Uint8Array): InlineType | null {
  const b = bytes;
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (
    b.length >= 8 &&
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v)
  ) {
    return 'image/png';
  }
  if (b.length >= 6 && (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a'))
    return 'image/gif';
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP')
    return 'image/webp';
  if (b.length >= 12 && ascii(b, 4, 8) === 'ftyp') {
    // ISO BMFF: the major brand, then compatible brands, up to the end of the ftyp box.
    const boxSize = Math.min(
      ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0,
      b.length,
      256,
    );
    const brands: string[] = [ascii(b, 8, 12)];
    for (let i = 16; i + 4 <= boxSize; i += 4) brands.push(ascii(b, i, i + 4));
    if (brands.some((x) => x === 'avif' || x === 'avis')) return 'image/avif';
    const mp4 = [
      'isom',
      'iso2',
      'iso4',
      'iso5',
      'iso6',
      'mp41',
      'mp42',
      'avc1',
      'dash',
      'M4V ',
      'MSNV',
    ];
    if (brands.some((x) => mp4.includes(x))) return 'video/mp4';
    return null;
  }
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
    // EBML: WebM says so in its DocType near the start (Matroska files say "matroska" and are not rendered).
    return ascii(b, 0, Math.min(b.length, 64)).includes('webm') ? 'video/webm' : null;
  }
  return null;
}

/** A file name safe for `a.download`: no path, no control or bidi characters, at most 120 characters. */
export function safeFileName(name: string): string {
  const cleaned = name
    .replace(/[\\/]/g, '_')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, '')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .trim();
  if (!cleaned) return 'tep-dinh-kem';
  if (cleaned.length <= 120) return cleaned;
  const dot = cleaned.lastIndexOf('.');
  const ext = dot > 0 && cleaned.length - dot <= 10 ? cleaned.slice(dot) : '';
  return cleaned.slice(0, 120 - ext.length) + ext;
}

export interface DecryptedAttachment {
  blob: Blob;
  /** The type the bytes really are, when it is allowed inline for this ref; otherwise null and `blob` is opaque. */
  inlineType: InlineType | null;
}

/**
 * downloadAttachment → fetch → SHA-256 check → decrypt. The Blob is typed from the decrypted bytes, never from the
 * sender's claimed type: an allowlisted image or video of the claimed kind, else `application/octet-stream`. The caller
 * wraps it in a blob: URL and revokes it.
 */
export async function downloadAttachment(
  conversationId: string,
  ref: AttachmentRef,
): Promise<DecryptedAttachment> {
  const res = await api.chat.POST(
    '/v1/chat/conversations/{conversation_id}/attachments/{attachment_id}/download',
    { params: { path: { conversation_id: conversationId, attachment_id: ref.id } } },
  );
  if (!res.data) throw problemToError(res.response.status, res.error?.code);
  const file = await fetch(res.data.url, {
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
  }).catch(() => null);
  if (!file || !file.ok) {
    throw new AttachmentError('Không tải được tệp.', file?.status === 404 ? 'NOT_FOUND' : 'FAILED');
  }
  const plaintext = await decryptFile(new Uint8Array(await file.arrayBuffer()), ref);
  const kind = attachmentKind(ref.mime);
  const sniffed = kind === 'file' ? null : sniffInlineType(plaintext);
  const inlineType =
    sniffed && (kind === 'image' ? INLINE_IMAGE_TYPES : INLINE_VIDEO_TYPES).includes(sniffed)
      ? sniffed
      : null;
  return {
    blob: new Blob([plaintext], { type: inlineType ?? 'application/octet-stream' }),
    inlineType,
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`;
}
