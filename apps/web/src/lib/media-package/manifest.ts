export const MEDIA_PACKAGE_SCHEMA = 'winkey.media-package/v1' as const;

export const BCP47_LANG_REGEX = /^[a-z]{2,3}(-[A-Z]{2})?$/;

export type AudioTrackKind = 'original' | 'dub' | 'voiceover' | 'commentary';
export type SubtitleTrackKind = 'subtitles' | 'captions';

export interface ManifestOriginalAudio {
  lang: string;
  label: string;
}

export interface ManifestVideo {
  file: string;
  original_audio?: ManifestOriginalAudio;
}

export interface ManifestAudioTrack {
  file: string;
  lang: string;
  label: string;
  kind: AudioTrackKind;
  default?: boolean;
}

export interface ManifestSubtitle {
  file: string;
  lang: string;
  label: string;
  kind?: SubtitleTrackKind;
  default?: boolean;
}

export interface MediaPackageManifest {
  schema: typeof MEDIA_PACKAGE_SCHEMA;
  title: string;
  description?: string;
  visibility?: 'PUBLIC' | 'UNLISTED' | 'PRIVATE';
  video: ManifestVideo;
  audio_tracks?: ManifestAudioTrack[];
  subtitles?: ManifestSubtitle[];
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validates a media package manifest according to specs/media-package-v1.md section 5.
 *
 * @param manifest Parsed JSON object of manifest.json
 * @param availableFiles Optional set of normalized file paths present in the package
 */
export function validateMediaPackageManifest(
  manifest: unknown,
  availableFiles?: Set<string> | string[],
): ValidationResult {
  const errors: string[] = [];

  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return {
      valid: false,
      errors: ['manifest.json phải là một đối tượng JSON hợp lệ.'],
    };
  }

  const m = manifest as Record<string, unknown>;

  // 1. schema
  if (m.schema !== MEDIA_PACKAGE_SCHEMA) {
    errors.push(`schema không hợp lệ: phải là "${MEDIA_PACKAGE_SCHEMA}".`);
  }

  // 2. title
  if (typeof m.title !== 'string' || m.title.trim().length === 0) {
    errors.push('title là bắt buộc và không được để trống.');
  } else if (m.title.length > 200) {
    errors.push('title không được vượt quá 200 ký tự.');
  }

  // File lookup helper
  const fileSet = availableFiles
    ? availableFiles instanceof Set
      ? availableFiles
      : new Set(availableFiles)
    : null;

  const checkFileExists = (filePath: string, fieldName: string) => {
    if (!fileSet) return;
    const cleanPath = filePath.replace(/^[./]+/, '').trim();
    if (!fileSet.has(cleanPath) && !fileSet.has(filePath)) {
      errors.push(
        `Tập tin "${filePath}" được chỉ định trong ${fieldName} không tìm thấy trong gói.`,
      );
    }
  };

  // 3. video
  if (!m.video || typeof m.video !== 'object' || Array.isArray(m.video)) {
    errors.push('video là bắt buộc và phải là một đối tượng.');
  } else {
    const v = m.video as Record<string, unknown>;
    if (typeof v.file !== 'string' || v.file.trim().length === 0) {
      errors.push('video.file là bắt buộc.');
    } else {
      checkFileExists(v.file, 'video.file');
    }

    if (v.original_audio !== undefined) {
      if (
        !v.original_audio ||
        typeof v.original_audio !== 'object' ||
        Array.isArray(v.original_audio)
      ) {
        errors.push('video.original_audio phải là một đối tượng.');
      } else {
        const oa = v.original_audio as Record<string, unknown>;
        if (typeof oa.lang !== 'string' || !BCP47_LANG_REGEX.test(oa.lang)) {
          errors.push(
            `video.original_audio.lang "${oa.lang ?? ''}" không đúng chuẩn BCP 47 (ví dụ: vi, en, zh-TW).`,
          );
        }
        if (typeof oa.label !== 'string' || oa.label.trim().length === 0 || oa.label.length > 50) {
          errors.push('video.original_audio.label phải từ 1 đến 50 ký tự.');
        }
      }
    }
  }

  // 4. audio_tracks
  if (m.audio_tracks !== undefined) {
    if (!Array.isArray(m.audio_tracks)) {
      errors.push('audio_tracks phải là một mảng.');
    } else {
      const audioTracks = m.audio_tracks as unknown[];
      if (audioTracks.length > 8) {
        errors.push(`Tối đa 8 track âm thanh cho mỗi video (hiện có ${audioTracks.length}).`);
      }

      let defaultAudioCount = 0;
      const seenAudioLangKind = new Set<string>();

      audioTracks.forEach((track, idx) => {
        const prefix = `audio_tracks[${idx}]`;
        if (!track || typeof track !== 'object' || Array.isArray(track)) {
          errors.push(`${prefix} phải là một đối tượng.`);
          return;
        }

        const t = track as Record<string, unknown>;

        // file
        if (typeof t.file !== 'string' || t.file.trim().length === 0) {
          errors.push(`${prefix}.file là bắt buộc.`);
        } else {
          checkFileExists(t.file, `${prefix}.file`);
        }

        // lang
        if (typeof t.lang !== 'string' || !BCP47_LANG_REGEX.test(t.lang)) {
          errors.push(`${prefix}.lang "${t.lang ?? ''}" không đúng chuẩn BCP 47.`);
        }

        // label
        if (typeof t.label !== 'string' || t.label.trim().length === 0 || t.label.length > 50) {
          errors.push(`${prefix}.label phải từ 1 đến 50 ký tự.`);
        }

        // kind
        const validKinds: AudioTrackKind[] = ['original', 'dub', 'voiceover', 'commentary'];
        if (typeof t.kind !== 'string' || !validKinds.includes(t.kind as AudioTrackKind)) {
          errors.push(
            `${prefix}.kind "${t.kind ?? ''}" không hợp lệ (phải là original, dub, voiceover hoặc commentary).`,
          );
        }

        // default
        if (t.default === true) {
          defaultAudioCount++;
        }

        // Uniqueness: lang + kind
        if (typeof t.lang === 'string' && typeof t.kind === 'string') {
          const key = `${t.lang.toLowerCase()}:${t.kind}`;
          if (seenAudioLangKind.has(key)) {
            errors.push(
              `Trùng lặp track âm thanh với cùng ngôn ngữ "${t.lang}" và thể loại "${t.kind}".`,
            );
          }
          seenAudioLangKind.add(key);
        }
      });

      if (defaultAudioCount > 1) {
        errors.push(`Chỉ được có tối đa 1 track âm thanh mặc định (hiện có ${defaultAudioCount}).`);
      }
    }
  }

  // 5. subtitles
  if (m.subtitles !== undefined) {
    if (!Array.isArray(m.subtitles)) {
      errors.push('subtitles phải là một mảng.');
    } else {
      const subtitles = m.subtitles as unknown[];
      if (subtitles.length > 20) {
        errors.push(`Tối đa 20 phụ đề cho mỗi video (hiện có ${subtitles.length}).`);
      }

      let defaultSubCount = 0;
      const seenSubLang = new Set<string>();

      subtitles.forEach((sub, idx) => {
        const prefix = `subtitles[${idx}]`;
        if (!sub || typeof sub !== 'object' || Array.isArray(sub)) {
          errors.push(`${prefix} phải là một đối tượng.`);
          return;
        }

        const s = sub as Record<string, unknown>;

        // file
        if (typeof s.file !== 'string' || s.file.trim().length === 0) {
          errors.push(`${prefix}.file là bắt buộc.`);
        } else {
          checkFileExists(s.file, `${prefix}.file`);
        }

        // lang
        if (typeof s.lang !== 'string' || !BCP47_LANG_REGEX.test(s.lang)) {
          errors.push(`${prefix}.lang "${s.lang ?? ''}" không đúng chuẩn BCP 47.`);
        }

        // label
        if (typeof s.label !== 'string' || s.label.trim().length === 0 || s.label.length > 50) {
          errors.push(`${prefix}.label phải từ 1 đến 50 ký tự.`);
        }

        // kind
        if (s.kind !== undefined) {
          const validSubKinds: SubtitleTrackKind[] = ['subtitles', 'captions'];
          if (typeof s.kind !== 'string' || !validSubKinds.includes(s.kind as SubtitleTrackKind)) {
            errors.push(
              `${prefix}.kind "${s.kind ?? ''}" không hợp lệ (phải là subtitles hoặc captions).`,
            );
          }
        }

        // default
        if (s.default === true) {
          defaultSubCount++;
        }

        // Uniqueness: lang
        if (typeof s.lang === 'string') {
          const langKey = s.lang.toLowerCase();
          if (seenSubLang.has(langKey)) {
            errors.push(`Trùng lặp phụ đề cho ngôn ngữ "${s.lang}".`);
          }
          seenSubLang.add(langKey);
        }
      });

      if (defaultSubCount > 1) {
        errors.push(`Chỉ được có tối đa 1 phụ đề mặc định (hiện có ${defaultSubCount}).`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
