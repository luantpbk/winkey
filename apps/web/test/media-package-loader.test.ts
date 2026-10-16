import { describe, it, expect } from 'vitest';
import {
  loadPackageFromZip,
  loadFromNormalizedMap,
  readBlobAsText,
} from '../src/lib/media-package/package-loader';

function createMockZipBuffer(files: Record<string, string>): Uint8Array {
  const parts: Uint8Array[] = [];
  const centralRecords: Uint8Array[] = [];
  let offset = 0;

  for (const [name, content] of Object.entries(files)) {
    const nameBytes = new TextEncoder().encode(name);
    const dataBytes = new TextEncoder().encode(content);

    // Local file header: 30 bytes + nameLen
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); // signature
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(8, 0, true); // method 0 (stored)
    lv.setUint32(18, dataBytes.length, true); // compressed size
    lv.setUint32(22, dataBytes.length, true); // uncompressed size
    lv.setUint16(26, nameBytes.length, true); // file name length
    local.set(nameBytes, 30);

    parts.push(local);
    parts.push(dataBytes);

    // Central directory header: 46 bytes + nameLen
    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true); // signature
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(10, 0, true); // method 0
    cv.setUint32(20, dataBytes.length, true); // compressed size
    cv.setUint32(24, dataBytes.length, true); // uncompressed size
    cv.setUint16(28, nameBytes.length, true); // file name length
    cv.setUint32(42, offset, true); // local header offset
    cd.set(nameBytes, 46);

    centralRecords.push(cd);
    offset += local.length + dataBytes.length;
  }

  const centralOffset = offset;
  let centralSize = 0;
  for (const cd of centralRecords) {
    parts.push(cd);
    centralSize += cd.length;
  }

  // End of Central Directory (EOCD): 22 bytes
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); // signature
  ev.setUint16(8, Object.keys(files).length, true); // total entries on disk
  ev.setUint16(10, Object.keys(files).length, true); // total entries
  ev.setUint32(12, centralSize, true); // size of central directory
  ev.setUint32(16, centralOffset, true); // offset of central directory
  parts.push(eocd);

  // Combine into single Uint8Array
  const totalLength = parts.reduce((acc, p) => acc + p.length, 0);
  const result = new Uint8Array(totalLength);
  let pos = 0;
  for (const p of parts) {
    result.set(p, pos);
    pos += p.length;
  }
  return result;
}

describe('MUX1: Media Package Loader (Folder & ZIP)', () => {
  const validManifestJson = JSON.stringify({
    schema: 'winkey.media-package/v1',
    title: 'Phim Ngắn Hành Động',
    video: {
      file: 'video.mp4',
    },
    audio_tracks: [
      {
        file: 'audio/vi.m4a',
        lang: 'vi',
        label: 'Thuyết minh',
        kind: 'voiceover',
        default: true,
      },
    ],
    subtitles: [
      {
        file: 'subs/vi.vtt',
        lang: 'vi',
        label: 'Tiếng Việt',
        kind: 'subtitles',
        default: true,
      },
    ],
  });

  const validVttContent = `WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nXin chào các bạn.`;

  it('loads valid package from a folder map with common root folder', async () => {
    const fileMap = new Map<string, File>([
      ['my-pack/manifest.json', new File([validManifestJson], 'manifest.json')],
      ['my-pack/video.mp4', new File(['dummy video'], 'video.mp4', { type: 'video/mp4' })],
      ['my-pack/audio/vi.m4a', new File(['dummy audio'], 'vi.m4a', { type: 'audio/x-m4a' })],
      ['my-pack/subs/vi.vtt', new File([validVttContent], 'vi.vtt', { type: 'text/vtt' })],
    ]);

    const result = await loadFromNormalizedMap(fileMap);
    expect(result.success).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.package?.manifest.title).toBe('Phim Ngắn Hành Động');
    expect(result.package?.videoFile.name).toBe('video.mp4');
    expect(result.package?.audioTracks).toHaveLength(1);
    expect(result.package?.audioTracks[0].meta.lang).toBe('vi');
    expect(result.package?.subtitles).toHaveLength(1);
    expect(result.package?.subtitles[0].content).toContain('Xin chào các bạn');
  });

  it('returns clear error when manifest.json is missing in folder', async () => {
    const fileMap = new Map<string, File>([['video.mp4', new File(['dummy'], 'video.mp4')]]);
    const result = await loadFromNormalizedMap(fileMap);
    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.includes('manifest.json'))).toBe(true);
  });

  it('returns clear error when manifest has invalid JSON syntax', async () => {
    const fileMap = new Map<string, File>([
      ['manifest.json', new File(['{ invalid json'], 'manifest.json')],
    ]);
    const result = await loadFromNormalizedMap(fileMap);
    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.includes('lỗi cú pháp JSON'))).toBe(true);
  });

  it('loads valid package from a ZIP file', async () => {
    const zipBytes = createMockZipBuffer({
      'manifest.json': validManifestJson,
      'video.mp4': 'video dummy bytes',
      'audio/vi.m4a': 'audio dummy bytes',
      'subs/vi.vtt': validVttContent,
    });

    const zipFile = new File([zipBytes as BlobPart], 'package.zip', {
      type: 'application/zip',
    });
    const result = await loadPackageFromZip(zipFile);
    expect(result.success).toBe(true);
    expect(result.package?.manifest.title).toBe('Phim Ngắn Hành Động');
    expect(result.package?.videoFile).toBeDefined();
    expect(result.package?.audioTracks).toHaveLength(1);
    expect(result.package?.subtitles).toHaveLength(1);
  });

  it('reads stored entry via slice as a virtual File (zero memory overhead)', async () => {
    const videoContent = 'VIRTUAL_SLICED_VIDEO_PAYLOAD_CHUNK_DATA';
    const zipBytes = createMockZipBuffer({
      'manifest.json': validManifestJson,
      'video.mp4': videoContent,
      'audio/vi.m4a': 'audio dummy bytes',
      'subs/vi.vtt': validVttContent,
    });

    const zipFile = new File([zipBytes as BlobPart], 'package.zip', {
      type: 'application/zip',
    });
    const result = await loadPackageFromZip(zipFile);
    expect(result.success).toBe(true);
    const videoFile = result.package?.videoFile;
    expect(videoFile).toBeDefined();

    // Verify reading via slice
    const sliced = videoFile!.slice(0, 7);
    const text = await readBlobAsText(sliced);
    expect(text).toBe('VIRTUAL');
  });

  it('rejects deflated media entries with a clear error ("zip without compression")', async () => {
    // Construct a zip where video.mp4 has compression method = 8
    const nameBytes = new TextEncoder().encode('video.mp4');
    const dataBytes = new TextEncoder().encode('dummy video data');

    const lfh = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(lfh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, 8, true); // METHOD 8 (DEFLATE)
    lv.setUint32(18, dataBytes.length, true);
    lv.setUint32(22, dataBytes.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lfh.set(nameBytes, 30);

    const cdfh = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cdfh.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, 8, true); // METHOD 8 (DEFLATE)
    cv.setUint32(20, dataBytes.length, true);
    cv.setUint32(24, dataBytes.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, 0, true);
    cdfh.set(nameBytes, 46);

    const offset = lfh.length + dataBytes.length;
    const cdSize = cdfh.length;

    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, 1, true);
    ev.setUint16(10, 1, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, offset, true);

    const combined = new Uint8Array(lfh.length + dataBytes.length + cdfh.length + eocd.length);
    combined.set(lfh, 0);
    combined.set(dataBytes, lfh.length);
    combined.set(cdfh, offset);
    combined.set(eocd, offset + cdSize);

    const zipFile = new File([combined], 'deflated-media.zip', { type: 'application/zip' });
    const result = await loadPackageFromZip(zipFile);
    expect(result.success).toBe(false);
    expect(
      result.errors.some(
        (e) => e.includes('phải được lưu trữ không nén') || e.includes('zip without compression'),
      ),
    ).toBe(true);
  });

  it('loads valid package from a ZIP64 archive with ZIP64 locator and ZIP64 extra fields', async () => {
    const files: Record<string, string> = {
      'manifest.json': validManifestJson,
      'video.mp4': 'zip64 video content bytes',
      'audio/vi.m4a': 'zip64 audio content bytes',
      'subs/vi.vtt': validVttContent,
    };

    const parts: Uint8Array[] = [];
    const centralRecords: Uint8Array[] = [];
    let offset = 0;

    for (const [name, content] of Object.entries(files)) {
      const nameBytes = new TextEncoder().encode(name);
      const dataBytes = new TextEncoder().encode(content);

      // Local file header: 30 bytes + nameLen
      const local = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 45, true);
      lv.setUint16(8, 0, true);
      lv.setUint32(18, dataBytes.length, true);
      lv.setUint32(22, dataBytes.length, true);
      lv.setUint16(26, nameBytes.length, true);
      local.set(nameBytes, 30);

      parts.push(local);
      parts.push(dataBytes);

      // Central directory header with ZIP64 extra field (0x0001)
      // Extra field: header ID 0x0001 (2B) + data size 24 (2B) + uncomp 8B + comp 8B + localOffset 8B = 28 bytes
      const extraSize = 28;
      const cd = new Uint8Array(46 + nameBytes.length + extraSize);
      const cv = new DataView(cd.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 45, true);
      cv.setUint16(6, 45, true);
      cv.setUint16(10, 0, true);
      // Set 0xFFFFFFFF to signal ZIP64 fields in extra
      cv.setUint32(20, 0xffffffff, true);
      cv.setUint32(24, 0xffffffff, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, extraSize, true);
      cv.setUint32(42, 0xffffffff, true);
      cd.set(nameBytes, 46);

      // Write ZIP64 extra field at 46 + nameBytes.length
      const extraOffset = 46 + nameBytes.length;
      cv.setUint16(extraOffset, 0x0001, true); // Tag
      cv.setUint16(extraOffset + 2, 24, true); // Size
      // 8B uncompressed size
      cv.setUint32(extraOffset + 4, dataBytes.length, true);
      cv.setUint32(extraOffset + 8, 0, true);
      // 8B compressed size
      cv.setUint32(extraOffset + 12, dataBytes.length, true);
      cv.setUint32(extraOffset + 16, 0, true);
      // 8B local header offset
      cv.setUint32(extraOffset + 20, offset, true);
      cv.setUint32(extraOffset + 24, 0, true);

      centralRecords.push(cd);
      offset += local.length + dataBytes.length;
    }

    const cdOffset = offset;
    let cdSize = 0;
    for (const cd of centralRecords) {
      parts.push(cd);
      cdSize += cd.length;
    }

    const zip64EocdOffset = cdOffset + cdSize;

    // ZIP64 End of Central Directory Record: 56 bytes
    const zip64Eocd = new Uint8Array(56);
    const zev = new DataView(zip64Eocd.buffer);
    zev.setUint32(0, 0x06064b50, true);
    // Size of record after this field (56 - 12 = 44)
    zev.setUint32(4, 44, true);
    zev.setUint32(8, 0, true);
    zev.setUint16(12, 45, true);
    zev.setUint16(14, 45, true);
    // total entries = 4
    zev.setUint32(24, Object.keys(files).length, true);
    zev.setUint32(28, 0, true);
    zev.setUint32(32, Object.keys(files).length, true);
    zev.setUint32(36, 0, true);
    // size of CD
    zev.setUint32(40, cdSize, true);
    zev.setUint32(44, 0, true);
    // offset of CD
    zev.setUint32(48, cdOffset, true);
    zev.setUint32(52, 0, true);
    parts.push(zip64Eocd);

    // ZIP64 End of Central Directory Locator: 20 bytes
    const locator = new Uint8Array(20);
    const lv = new DataView(locator.buffer);
    lv.setUint32(0, 0x07064b50, true);
    lv.setUint32(4, 0, true);
    // Offset of ZIP64 EOCD
    lv.setUint32(8, zip64EocdOffset, true);
    lv.setUint32(12, 0, true);
    lv.setUint32(16, 1, true); // total disks
    parts.push(locator);

    // Standard EOCD with 0xFFFF / 0xFFFFFFFF
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, 0xffff, true);
    ev.setUint16(10, 0xffff, true);
    ev.setUint32(12, 0xffffffff, true);
    ev.setUint32(16, 0xffffffff, true);
    parts.push(eocd);

    const totalLen = parts.reduce((acc, p) => acc + p.length, 0);
    const zipBytes = new Uint8Array(totalLen);
    let pos = 0;
    for (const p of parts) {
      zipBytes.set(p, pos);
      pos += p.length;
    }

    const zipFile = new File([zipBytes], 'package64.zip', { type: 'application/zip' });
    const result = await loadPackageFromZip(zipFile);
    expect(result.success).toBe(true);
    expect(result.package?.manifest.title).toBe('Phim Ngắn Hành Động');
    expect(result.package?.videoFile).toBeDefined();
    expect(result.package?.audioTracks).toHaveLength(1);
    expect(result.package?.subtitles).toHaveLength(1);

    // Check slice on video file from zip64
    const text = await readBlobAsText(result.package!.videoFile.slice(0, 5));
    expect(text).toBe('zip64');
  });
});
