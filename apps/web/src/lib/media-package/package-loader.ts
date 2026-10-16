import {
  validateMediaPackageManifest,
  type MediaPackageManifest,
  type ManifestAudioTrack,
  type ManifestSubtitle,
} from './manifest';
import { readZipEntries } from './zip-reader';

export interface LoadedMediaPackage {
  manifest: MediaPackageManifest;
  manifestRaw: string;
  videoFile: File;
  audioTracks: Array<{
    meta: ManifestAudioTrack;
    file: File;
  }>;
  subtitles: Array<{
    meta: ManifestSubtitle;
    file: File;
    content: string;
  }>;
  allFilePaths: string[];
}

export interface PackageLoadResult {
  success: boolean;
  package?: LoadedMediaPackage;
  errors: string[];
}

export async function readBlobAsText(blob: Blob | File): Promise<string> {
  if (typeof blob.text === 'function') {
    return await blob.text();
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string) || '');
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

export async function readBlobAsArrayBuffer(blob: Blob | File): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') {
    return await blob.arrayBuffer();
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\/+/, '');
}

/**
 * Given a map of path -> File, detects any common root folder
 * (e.g. "package-name/manifest.json") and strips it so manifest.json is at root.
 */
function normalizeFileMap(fileMap: Map<string, File>): Map<string, File> {
  // Check if manifest.json is already at root
  if (fileMap.has('manifest.json')) {
    return fileMap;
  }

  // Find where manifest.json is
  for (const [p] of fileMap.entries()) {
    if (p.endsWith('/manifest.json')) {
      const prefix = p.slice(0, p.length - 'manifest.json'.length);
      const normalized = new Map<string, File>();
      for (const [origPath, file] of fileMap.entries()) {
        if (origPath.startsWith(prefix)) {
          const stripped = origPath.slice(prefix.length);
          normalized.set(stripped, file);
        } else {
          normalized.set(origPath, file);
        }
      }
      return normalized;
    }
  }

  return fileMap;
}

/**
 * Loads and validates a media package from a normalized file map.
 */
export async function loadFromNormalizedMap(
  fileMap: Map<string, File>,
): Promise<PackageLoadResult> {
  const normalized = normalizeFileMap(fileMap);

  const manifestFile = normalized.get('manifest.json');
  if (!manifestFile) {
    return {
      success: false,
      errors: ['Không tìm thấy tập tin manifest.json trong gói media.'],
    };
  }

  let manifestRaw = '';
  let parsedManifest: unknown;
  try {
    manifestRaw = await readBlobAsText(manifestFile);
    parsedManifest = JSON.parse(manifestRaw);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      errors: [`Tập tin manifest.json không hợp lệ hoặc lỗi cú pháp JSON: ${msg}`],
    };
  }

  const availableFiles = new Set(Array.from(normalized.keys()));
  const validation = validateMediaPackageManifest(parsedManifest, availableFiles);

  if (!validation.valid) {
    return {
      success: false,
      errors: validation.errors,
    };
  }

  const manifest = parsedManifest as MediaPackageManifest;

  // Resolve video file
  const videoClean = manifest.video.file.replace(/^[./]+/, '').trim();
  const videoFile = normalized.get(videoClean) || normalized.get(manifest.video.file);
  if (!videoFile) {
    return {
      success: false,
      errors: [`Không tìm thấy tập tin video "${manifest.video.file}" trong gói.`],
    };
  }

  // Resolve audio tracks
  const audioTracks: LoadedMediaPackage['audioTracks'] = [];
  if (manifest.audio_tracks) {
    for (const track of manifest.audio_tracks) {
      const audioClean = track.file.replace(/^[./]+/, '').trim();
      const file = normalized.get(audioClean) || normalized.get(track.file);
      if (!file) {
        return {
          success: false,
          errors: [`Không tìm thấy tập tin audio "${track.file}" trong gói.`],
        };
      }
      audioTracks.push({ meta: track, file });
    }
  }

  // Resolve subtitles and read content
  const subtitles: LoadedMediaPackage['subtitles'] = [];
  if (manifest.subtitles) {
    for (const sub of manifest.subtitles) {
      const subClean = sub.file.replace(/^[./]+/, '').trim();
      const file = normalized.get(subClean) || normalized.get(sub.file);
      if (!file) {
        return {
          success: false,
          errors: [`Không tìm thấy tập tin phụ đề "${sub.file}" trong gói.`],
        };
      }
      const content = await readBlobAsText(file);
      subtitles.push({ meta: sub, file, content });
    }
  }

  return {
    success: true,
    errors: [],
    package: {
      manifest,
      manifestRaw,
      videoFile,
      audioTracks,
      subtitles,
      allFilePaths: Array.from(normalized.keys()),
    },
  };
}

/**
 * Loads a media package from a folder of files (e.g. from webkitdirectory input).
 */
export async function loadPackageFromFiles(
  files: FileList | File[] | Iterable<File>,
): Promise<PackageLoadResult> {
  const fileMap = new Map<string, File>();

  for (const file of Array.from(files)) {
    // webkitRelativePath contains "my-package/video.mp4" when selected via folder input
    const relPath = normalizePath(file.webkitRelativePath || file.name);
    fileMap.set(relPath, file);
  }

  return loadFromNormalizedMap(fileMap);
}

/**
 * Loads a media package from a .zip file lazily without loading the archive into RAM.
 */
export async function loadPackageFromZip(zipFile: File): Promise<PackageLoadResult> {
  try {
    const rawMap = await readZipEntries(zipFile);
    const fileMap = new Map<string, File>();
    for (const [entryPath, file] of rawMap.entries()) {
      fileMap.set(normalizePath(entryPath), file);
    }
    return loadFromNormalizedMap(fileMap);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      errors: [`Không thể giải nén tập tin ZIP: ${msg}`],
    };
  }
}
