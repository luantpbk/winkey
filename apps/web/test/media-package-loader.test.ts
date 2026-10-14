import { describe, it, expect } from 'vitest';
import { loadPackageFromZip, loadFromNormalizedMap } from '../src/lib/media-package/package-loader';

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
});
