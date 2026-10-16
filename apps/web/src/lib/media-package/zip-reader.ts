/**
 * Lazy ZIP and ZIP64 parser for Web File/Blob without loading archives into memory.
 * Exposes media entries as Blob slices (0 RAM overhead) and requires media to be STORED (method 0).
 * Allows DEFLATE (method 8) only for text metadata (manifest.json, .vtt) capped at 5 MiB.
 */

const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_CDFH = 0x02014b50;
const SIG_LFH = 0x04034b50;

const MAX_TEXT_SIZE = 5 * 1024 * 1024; // 5 MiB cap

export function guessMimeType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'mp4':
      return 'video/mp4';
    case 'mov':
      return 'video/quicktime';
    case 'mkv':
      return 'video/x-matroska';
    case 'webm':
      return 'video/webm';
    case 'm4a':
      return 'audio/x-m4a';
    case 'wav':
      return 'audio/wav';
    case 'flac':
      return 'audio/flac';
    case 'aac':
      return 'audio/aac';
    case 'ogg':
      return 'audio/ogg';
    case 'vtt':
      return 'text/vtt';
    case 'json':
      return 'application/json';
    default:
      return 'application/octet-stream';
  }
}

export function isMediaFilename(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase();
  return ['mp4', 'mov', 'mkv', 'webm', 'm4a', 'wav', 'flac', 'aac', 'ogg'].includes(ext || '');
}

async function decompressDeflateRaw(
  compressed: Uint8Array | ArrayBuffer,
  maxAllowedBytes = 5 * 1024 * 1024,
): Promise<Uint8Array> {
  const bodyBytes = compressed instanceof Uint8Array ? compressed : new Uint8Array(compressed);

  const compressedStream = new Response(bodyBytes as BodyInit).body;
  if (!compressedStream) {
    throw new Error('Không thể khởi tạo readable stream từ compressed buffer.');
  }

  if (typeof DecompressionStream === 'undefined') {
    throw new Error('DecompressionStream API không được hỗ trợ trong môi trường này.');
  }

  const ds = new DecompressionStream('deflate-raw');
  const reader = compressedStream.pipeThrough(ds).getReader();

  const chunks: Uint8Array[] = [];
  let totalLength = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      if (value) {
        totalLength += value.byteLength;
        if (totalLength > maxAllowedBytes) {
          await reader.cancel('Exceeded maximum allowed decompressed size.');
          throw new Error(
            `Tập tin giải nén vượt quá giới hạn tối đa ${maxAllowedBytes} bytes (hiện tại: ${totalLength} bytes).`,
          );
        }
        chunks.push(value);
      }
    }
  } catch (err) {
    await reader.cancel().catch(() => {});
    throw err;
  }

  const resultBytes = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    resultBytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return resultBytes;
}

function getUint64(view: DataView, offset: number): number {
  const low = view.getUint32(offset, true);
  const high = view.getUint32(offset + 4, true);
  const val = BigInt(low) + (BigInt(high) << 32n);
  if (val > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(
      'Offset hoặc kích thước tập tin ZIP vượt quá giới hạn an toàn Number.MAX_SAFE_INTEGER',
    );
  }
  return Number(val);
}

async function readBlobSliceAsArrayBuffer(
  blob: Blob | File,
  start: number,
  end: number,
): Promise<ArrayBuffer> {
  const safeStart = Math.max(0, Math.min(start, blob.size));
  const safeEnd = Math.max(safeStart, Math.min(end, blob.size));
  const sliced = blob.slice(safeStart, safeEnd);

  // 1. Try native Blob.prototype.arrayBuffer
  if (typeof sliced.arrayBuffer === 'function') {
    try {
      const buf = await sliced.arrayBuffer();
      if (buf && buf.byteLength === safeEnd - safeStart) {
        return buf;
      }
    } catch {
      // Fallback below
    }
  }

  // 2. JSDOM / Browser FileReader fallback
  if (typeof FileReader !== 'undefined') {
    return await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () =>
        reject(reader.error || new Error('FileReader failed to read blob slice'));
      reader.readAsArrayBuffer(sliced);
    });
  }

  return await new Response(sliced).arrayBuffer();
}

export async function readZipEntries(file: File | Blob): Promise<Map<string, File>> {
  if (file.size < 22) {
    throw new Error('Tập tin không phải định dạng ZIP hợp lệ (kích thước quá nhỏ).');
  }

  // 1. Locate End of Central Directory (EOCD)
  const tailSize = Math.min(file.size, 65557);
  const tailOffset = file.size - tailSize;
  const tailBuf = await readBlobSliceAsArrayBuffer(file, tailOffset, file.size);
  const tailView = new DataView(tailBuf);

  let eocdRelPos = -1;
  for (let i = tailBuf.byteLength - 22; i >= 0; i--) {
    if (tailView.getUint32(i, true) === SIG_EOCD) {
      eocdRelPos = i;
      break;
    }
  }

  if (eocdRelPos === -1) {
    throw new Error('Tập tin không phải định dạng ZIP hợp lệ (không tìm thấy EOCD).');
  }

  let totalEntries = tailView.getUint16(eocdRelPos + 10, true);
  let cdSize = tailView.getUint32(eocdRelPos + 12, true);
  let cdOffset = tailView.getUint32(eocdRelPos + 16, true);

  // 2. Check for ZIP64 EOCD Locator
  const hasZip64Sentinel =
    totalEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff;
  const locatorRelPos = eocdRelPos - 20;

  if (locatorRelPos >= 0 && tailView.getUint32(locatorRelPos, true) === SIG_ZIP64_LOCATOR) {
    const zip64EocdOffset = getUint64(tailView, locatorRelPos + 8);
    const zip64EocdBuf = await readBlobSliceAsArrayBuffer(
      file,
      zip64EocdOffset,
      zip64EocdOffset + 56,
    );
    const zip64View = new DataView(zip64EocdBuf);

    if (zip64View.getUint32(0, true) !== SIG_ZIP64_EOCD) {
      if (hasZip64Sentinel) {
        throw new Error('ZIP64 EOCD Record không hợp lệ.');
      }
    } else {
      totalEntries = getUint64(zip64View, 32);
      cdSize = getUint64(zip64View, 40);
      cdOffset = getUint64(zip64View, 48);
    }
  } else if (hasZip64Sentinel) {
    throw new Error('Không tìm thấy ZIP64 EOCD Locator.');
  }

  // 3. Read Central Directory
  if (cdOffset + cdSize > file.size) {
    throw new Error('Central Directory offset vượt quá kích thước tập tin.');
  }

  const cdBuf = await readBlobSliceAsArrayBuffer(file, cdOffset, cdOffset + cdSize);
  const cdBytes = new Uint8Array(cdBuf);
  const cdView = new DataView(cdBuf);
  const decoder = new TextDecoder('utf-8');

  const fileMap = new Map<string, File>();
  let cur = 0;

  for (let e = 0; e < totalEntries && cur + 46 <= cdBytes.length; e++) {
    const sig = cdView.getUint32(cur, true);
    if (sig !== SIG_CDFH) break;

    const method = cdView.getUint16(cur + 10, true);
    let compSize = cdView.getUint32(cur + 20, true);
    let uncompSize = cdView.getUint32(cur + 24, true);
    const fileNameLen = cdView.getUint16(cur + 28, true);
    const extraLen = cdView.getUint16(cur + 30, true);
    const commentLen = cdView.getUint16(cur + 32, true);
    let localHeaderOffset = cdView.getUint32(cur + 42, true);

    const fileNameBytes = cdBytes.subarray(cur + 46, cur + 46 + fileNameLen);
    const filePath = decoder.decode(fileNameBytes).replace(/\\/g, '/');

    // Parse ZIP64 Extended Information Extra Field (0x0001) if present
    let extraCur = cur + 46 + fileNameLen;
    const extraEnd = extraCur + extraLen;
    while (extraCur + 4 <= extraEnd) {
      const headerId = cdView.getUint16(extraCur, true);
      const dataSize = cdView.getUint16(extraCur + 2, true);
      extraCur += 4;
      if (headerId === 0x0001) {
        let p = extraCur;
        if (uncompSize === 0xffffffff && p + 8 <= extraEnd) {
          uncompSize = getUint64(cdView, p);
          p += 8;
        }
        if (compSize === 0xffffffff && p + 8 <= extraEnd) {
          compSize = getUint64(cdView, p);
          p += 8;
        }
        if (localHeaderOffset === 0xffffffff && p + 8 <= extraEnd) {
          localHeaderOffset = getUint64(cdView, p);
          p += 8;
        }
      }
      extraCur += dataSize;
    }

    cur += 46 + fileNameLen + extraLen + commentLen;

    // Skip directories and metadata
    if (filePath.endsWith('/') || filePath.startsWith('__MACOSX/')) {
      continue;
    }

    const isMedia = isMediaFilename(filePath);
    if (isMedia && method !== 0) {
      throw new Error(
        `Tập tin media "${filePath}" phải được lưu trữ không nén (STORED / method 0). Vui lòng tạo file zip không nén (zip without compression / 'zip -0').`,
      );
    }

    // Read Local File Header (30 bytes) to get accurate fileNameLen + extraLen
    const lfhBuf = await readBlobSliceAsArrayBuffer(
      file,
      localHeaderOffset,
      localHeaderOffset + 30,
    );
    const lfhView = new DataView(lfhBuf);
    if (lfhView.getUint32(0, true) !== SIG_LFH) {
      throw new Error(`Local file header không hợp lệ cho tập tin: ${filePath}`);
    }
    const lfhFileNameLen = lfhView.getUint16(26, true);
    const lfhExtraLen = lfhView.getUint16(28, true);
    const dataStart = localHeaderOffset + 30 + lfhFileNameLen + lfhExtraLen;

    const mime = guessMimeType(filePath);
    const fileName = filePath.split('/').pop() || filePath;

    if (isMedia) {
      // Expose as Blob slice wrapped in File: ZERO memory overhead
      const mediaSlice = file.slice(dataStart, dataStart + uncompSize, mime);
      const virtualFile = new File([mediaSlice], fileName, { type: mime });
      fileMap.set(filePath, virtualFile);
    } else {
      // Non-media (manifest.json, .vtt)
      if (uncompSize > MAX_TEXT_SIZE) {
        throw new Error(`Tập tin văn bản "${filePath}" vượt quá giới hạn tối đa 5 MiB.`);
      }

      if (method === 0) {
        const textBuf = await readBlobSliceAsArrayBuffer(file, dataStart, dataStart + uncompSize);
        const virtualFile = new File([new Uint8Array(textBuf)], fileName, { type: mime });
        fileMap.set(filePath, virtualFile);
      } else if (method === 8) {
        const compBuf = await readBlobSliceAsArrayBuffer(file, dataStart, dataStart + compSize);
        const decompressed = await decompressDeflateRaw(new Uint8Array(compBuf));
        const virtualFile = new File([decompressed as BlobPart], fileName, { type: mime });
        fileMap.set(filePath, virtualFile);
      } else {
        throw new Error(`Phương thức nén ${method} không được hỗ trợ cho ${filePath}.`);
      }
    }
  }

  return fileMap;
}
