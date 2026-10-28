import { api } from '../api-client';

export const MAX_IMAGE_SIZE_BYTES = 20 * 1024 * 1024; // 20 MiB
export const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/avif'];

export type ImagePurpose = 'AVATAR' | 'BANNER' | 'POST';

export interface ImageUploadResult {
  id: string;
  url: string | null;
  thumb_url: string | null;
  width: number | null;
  height: number | null;
  status: 'UPLOADING' | 'PROCESSING' | 'READY' | 'FAILED';
  error: string | null;
}

export interface ValidateImageResult {
  valid: boolean;
  error?: string;
}

/**
 * Validates file size (<= 20 MiB) and image MIME type.
 */
export function validateImageFile(file: File): ValidateImageResult {
  if (file.size > MAX_IMAGE_SIZE_BYTES) {
    return {
      valid: false,
      error: 'Tệp vượt quá kích thước cho phép (tối đa 20 MiB).',
    };
  }

  if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
    return {
      valid: false,
      error: 'Định dạng tệp không được hỗ trợ. Vui lòng chọn ảnh JPEG, PNG, WebP hoặc AVIF.',
    };
  }

  return { valid: true };
}

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Crops and resizes image on canvas, encoding to WebP (fallback to JPEG).
 * Avatar: long edge <= 800px.
 * Banner / others: long edge <= 2048px.
 */
export async function cropAndResizeImage(
  imageSource: HTMLImageElement | ImageBitmap,
  crop: CropRect,
  maxDimension: number,
): Promise<Blob> {
  const canvas = document.createElement('canvas');
  const cropW = Math.max(1, Math.round(crop.width));
  const cropH = Math.max(1, Math.round(crop.height));

  let outW = cropW;
  let outH = cropH;

  const maxEdge = Math.max(outW, outH);
  if (maxEdge > maxDimension) {
    const scale = maxDimension / maxEdge;
    outW = Math.max(1, Math.round(outW * scale));
    outH = Math.max(1, Math.round(outH * scale));
  }

  canvas.width = outW;
  canvas.height = outH;

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Không thể khởi tạo canvas 2D context.');
  }

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  ctx.drawImage(imageSource, crop.x, crop.y, crop.width, crop.height, 0, 0, outW, outH);

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
          return;
        }
        // Fallback to JPEG if WebP encoding is unsupported
        canvas.toBlob(
          (jpegBlob) => {
            if (jpegBlob) {
              resolve(jpegBlob);
            } else {
              reject(new Error('Không thể mã hoá ảnh từ canvas.'));
            }
          },
          'image/jpeg',
          0.85,
        );
      },
      'image/webp',
      0.85,
    );
  });
}

export interface UploadImageOptions {
  blob: Blob;
  purpose: ImagePurpose;
  pollIntervalMs?: number;
  maxWaitMs?: number;
  onProgress?: (status: string) => void;
}

/**
 * Complete upload flow:
 * 1. POST /v1/images (createImageUpload)
 * 2. PUT upload_url with upload_headers and blob
 * 3. POST /v1/images/{id}/complete
 * 4. Poll GET /v1/images/{id} every 1.5s up to 60s
 */
export async function uploadImage({
  blob,
  purpose,
  pollIntervalMs = 1500,
  maxWaitMs = 60000,
  onProgress,
}: UploadImageOptions): Promise<ImageUploadResult> {
  const contentType =
    blob.type === 'image/webp' || blob.type === 'image/jpeg' ? blob.type : 'image/webp';

  onProgress?.('Khởi tạo tải ảnh...');

  const {
    data: initData,
    response: initRes,
    error: initErr,
  } = await api.upload.POST('/v1/images', {
    body: {
      purpose,
      content_type: contentType,
      size_bytes: blob.size,
    },
  });

  if (!initRes.ok || !initData) {
    const msg =
      (initErr as any)?.detail || (initErr as any)?.title || 'Không thể khởi tạo phiên tải ảnh.';
    throw new Error(msg);
  }

  onProgress?.('Đang tải ảnh lên máy chủ lưu trữ...');

  // Direct PUT to presigned upload_url
  const putHeaders: Record<string, string> = {
    'Content-Type': contentType,
    ...(initData.upload_headers || {}),
  };

  const uploadRes = await fetch(initData.upload_url, {
    method: 'PUT',
    headers: putHeaders,
    body: blob,
  });

  if (!uploadRes.ok) {
    throw new Error(`Tải tệp ảnh thất bại (HTTP ${uploadRes.status}).`);
  }

  onProgress?.('Đang xác nhận tải lên...');

  // Complete upload
  const { response: compRes, error: compErr } = await api.upload.POST(
    '/v1/images/{image_id}/complete',
    {
      params: { path: { image_id: initData.image_id } },
    },
  );

  if (!compRes.ok) {
    const msg = (compErr as any)?.detail || (compErr as any)?.title || 'Xác nhận tải ảnh thất bại.';
    throw new Error(msg);
  }

  onProgress?.('Đang xử lý ảnh...');

  // Poll for READY or FAILED status
  const startTime = Date.now();
  while (Date.now() - startTime < maxWaitMs) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));

    const { data: imgData, response: imgRes } = await api.upload.GET('/v1/images/{image_id}', {
      params: { path: { image_id: initData.image_id } },
    });

    if (imgRes.ok && imgData) {
      if (imgData.status === 'READY') {
        onProgress?.('Hoàn thành!');
        return {
          id: imgData.id,
          url: imgData.url,
          thumb_url: imgData.thumb_url,
          width: imgData.width,
          height: imgData.height,
          status: imgData.status,
          error: imgData.error,
        };
      }

      if (imgData.status === 'FAILED') {
        const errorMsg = imgData.error || 'Xử lý ảnh thất bại. Vui lòng thử lại với ảnh khác.';
        throw new Error(errorMsg);
      }
    }
  }

  throw new Error('Quá thời gian xử lý ảnh (vượt quá 60 giây).');
}
