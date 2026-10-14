/**
 * Pure TypeScript ZIP parser with zero external dependencies,
 * leveraging native DecompressionStream('deflate-raw') in modern browsers and Node.js.
 */

export interface ZipEntry {
  path: string;
  data: Uint8Array;
}

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

async function decompressDeflateRaw(compressed: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  // Pass copy of slice buffer to ensure clean buffer boundaries
  writer.write(compressed as BufferSource);
  writer.close();
  const arrayBuffer = await new Response(ds.readable).arrayBuffer();
  return new Uint8Array(arrayBuffer);
}

/**
 * Extracts all files from a ZIP archive buffer.
 */
export async function unzipEntries(buffer: ArrayBuffer | Uint8Array): Promise<ZipEntry[]> {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // 1. Locate End of Central Directory (EOCD) signature 0x06054b50
  // Minimum EOCD is 22 bytes, max comment is 65535 bytes
  let eocdOffset = -1;
  const maxSearch = Math.min(bytes.length, 65557);
  for (let i = bytes.length - 22; i >= bytes.length - maxSearch; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }

  if (eocdOffset === -1) {
    throw new Error('Tập tin không phải định dạng ZIP hợp lệ (không tìm thấy EOCD).');
  }

  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const centralDirOffset = view.getUint32(eocdOffset + 16, true);

  const entries: ZipEntry[] = [];
  let curCentral = centralDirOffset;

  const decoder = new TextDecoder('utf-8');

  for (let e = 0; e < totalEntries; e++) {
    if (curCentral + 46 > bytes.length) break;
    const sig = view.getUint32(curCentral, true);
    if (sig !== 0x02014b50) break; // Not central directory header

    const method = view.getUint16(curCentral + 10, true);
    const compressedSize = view.getUint32(curCentral + 20, true);
    const uncompressedSize = view.getUint32(curCentral + 24, true);
    const fileNameLen = view.getUint16(curCentral + 28, true);
    const extraLen = view.getUint16(curCentral + 30, true);
    const commentLen = view.getUint16(curCentral + 32, true);
    const localHeaderOffset = view.getUint32(curCentral + 42, true);

    const fileNameBytes = bytes.subarray(curCentral + 46, curCentral + 46 + fileNameLen);
    const filePath = decoder.decode(fileNameBytes).replace(/\\/g, '/');

    curCentral += 46 + fileNameLen + extraLen + commentLen;

    // Skip directories and macOS metadata
    if (filePath.endsWith('/') || filePath.startsWith('__MACOSX/')) {
      continue;
    }

    // Read local header to find exact payload start
    if (localHeaderOffset + 30 > bytes.length) continue;
    const localSig = view.getUint32(localHeaderOffset, true);
    if (localSig !== 0x04034b50) continue;

    const localFileNameLen = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLen = view.getUint16(localHeaderOffset + 28, true);
    const dataStart = localHeaderOffset + 30 + localFileNameLen + localExtraLen;

    if (method === 0) {
      // Stored (no compression)
      const data = bytes.subarray(dataStart, dataStart + uncompressedSize);
      entries.push({ path: filePath, data: new Uint8Array(data) });
    } else if (method === 8) {
      // Deflate
      const compressedData = bytes.subarray(dataStart, dataStart + compressedSize);
      const decompressed = await decompressDeflateRaw(compressedData);
      entries.push({ path: filePath, data: decompressed });
    } else {
      console.warn(`[zip-reader] Unsupported compression method ${method} for ${filePath}`);
    }
  }

  return entries;
}
