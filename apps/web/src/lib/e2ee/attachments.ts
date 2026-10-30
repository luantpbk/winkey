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

/** downloadAttachment → fetch → SHA-256 check → decrypt. The caller wraps the bytes in a blob: URL and revokes it. */
export async function downloadAttachment(
  conversationId: string,
  ref: AttachmentRef,
): Promise<Blob> {
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
  return new Blob([plaintext], { type: ref.mime });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`;
}
