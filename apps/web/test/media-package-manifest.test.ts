import { describe, it, expect } from 'vitest';
import {
  validateMediaPackageManifest,
  type MediaPackageManifest,
} from '../src/lib/media-package/manifest';

describe('MUX1: Media Package Manifest Validation (spec section 5)', () => {
  const validManifest: MediaPackageManifest = {
    schema: 'winkey.media-package/v1',
    title: 'Tên phim – Tập 1',
    video: {
      file: 'video.mp4',
      original_audio: { lang: 'zh', label: 'Tiếng Trung (gốc)' },
    },
    audio_tracks: [
      {
        file: 'audio/vi.m4a',
        lang: 'vi',
        label: 'Thuyết minh',
        kind: 'voiceover',
        default: true,
      },
      {
        file: 'audio/vi-dub.m4a',
        lang: 'vi',
        label: 'Lồng tiếng',
        kind: 'dub',
      },
      {
        file: 'audio/en.m4a',
        lang: 'en',
        label: 'English',
        kind: 'dub',
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
      {
        file: 'subs/en.vtt',
        lang: 'en',
        label: 'English',
        kind: 'subtitles',
      },
    ],
  };

  const availableFiles = new Set([
    'manifest.json',
    'video.mp4',
    'audio/vi.m4a',
    'audio/vi-dub.m4a',
    'audio/en.m4a',
    'subs/vi.vtt',
    'subs/en.vtt',
  ]);

  it('passes on completely valid manifest with available files', () => {
    const result = validateMediaPackageManifest(validManifest, availableFiles);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects invalid schema', () => {
    const invalid = { ...validManifest, schema: 'winkey.media-package/v2' };
    const result = validateMediaPackageManifest(invalid, availableFiles);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('schema'))).toBe(true);
  });

  it('rejects missing or empty title or title > 200 chars', () => {
    const noTitle = { ...validManifest, title: '' };
    expect(validateMediaPackageManifest(noTitle).valid).toBe(false);

    const longTitle = { ...validManifest, title: 'a'.repeat(201) };
    const res = validateMediaPackageManifest(longTitle);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes('200'))).toBe(true);
  });

  it('validates BCP 47 language pattern for audio and subtitles', () => {
    const invalidLang: MediaPackageManifest = {
      ...validManifest,
      audio_tracks: [
        {
          file: 'audio/vi.m4a',
          lang: 'vietnamese', // invalid BCP 47 tag
          label: 'Thuyết minh',
          kind: 'voiceover',
        },
      ],
    };
    const res = validateMediaPackageManifest(invalidLang);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes('BCP 47'))).toBe(true);
  });

  it('accepts regional BCP 47 tags (e.g. en-US, zh-TW)', () => {
    const regionalManifest: MediaPackageManifest = {
      ...validManifest,
      audio_tracks: [
        {
          file: 'audio/en.m4a',
          lang: 'en-US',
          label: 'English (US)',
          kind: 'dub',
        },
      ],
      subtitles: [
        {
          file: 'subs/en.vtt',
          lang: 'zh-TW',
          label: '繁體中文',
          kind: 'subtitles',
        },
      ],
    };
    expect(validateMediaPackageManifest(regionalManifest).valid).toBe(true);
  });

  it('enforces maximum 8 audio tracks limit', () => {
    const nineAudioTracks: MediaPackageManifest = {
      ...validManifest,
      audio_tracks: Array.from({ length: 9 }).map((_, i) => ({
        file: `audio/track${i}.m4a`,
        lang: `l${i}`,
        label: `Track ${i}`,
        kind: 'dub',
      })),
    };
    const res = validateMediaPackageManifest(nineAudioTracks);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes('Tối đa 8 track âm thanh'))).toBe(true);
  });

  it('enforces maximum 20 subtitle tracks limit', () => {
    const twentyOneSubs: MediaPackageManifest = {
      ...validManifest,
      subtitles: Array.from({ length: 21 }).map((_, i) => ({
        file: `subs/sub${i}.vtt`,
        lang: `s${i}`,
        label: `Sub ${i}`,
      })),
    };
    const res = validateMediaPackageManifest(twentyOneSubs);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes('Tối đa 20 phụ đề'))).toBe(true);
  });

  it('enforces unique (lang, kind) for audio tracks', () => {
    const duplicateAudio: MediaPackageManifest = {
      ...validManifest,
      audio_tracks: [
        { file: 'audio/1.m4a', lang: 'vi', label: 'TM 1', kind: 'voiceover' },
        { file: 'audio/2.m4a', lang: 'vi', label: 'TM 2', kind: 'voiceover' }, // duplicate lang+kind
      ],
    };
    const res = validateMediaPackageManifest(duplicateAudio);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes('Trùng lặp track âm thanh'))).toBe(true);
  });

  it('allows same language for audio if kind is different (e.g. vi voiceover and vi dub)', () => {
    const differentKinds: MediaPackageManifest = {
      ...validManifest,
      audio_tracks: [
        { file: 'audio/1.m4a', lang: 'vi', label: 'Thuyết minh', kind: 'voiceover' },
        { file: 'audio/2.m4a', lang: 'vi', label: 'Lồng tiếng', kind: 'dub' },
      ],
    };
    expect(validateMediaPackageManifest(differentKinds).valid).toBe(true);
  });

  it('enforces unique lang for subtitles', () => {
    const duplicateSub: MediaPackageManifest = {
      ...validManifest,
      subtitles: [
        { file: 'subs/1.vtt', lang: 'vi', label: 'Tiếng Việt 1', kind: 'subtitles' },
        { file: 'subs/2.vtt', lang: 'vi', label: 'Tiếng Việt 2', kind: 'captions' }, // duplicate lang
      ],
    };
    const res = validateMediaPackageManifest(duplicateSub);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes('Trùng lặp phụ đề cho ngôn ngữ'))).toBe(true);
  });

  it('enforces at most one default: true per list', () => {
    const twoDefaultAudio: MediaPackageManifest = {
      ...validManifest,
      audio_tracks: [
        { file: 'audio/1.m4a', lang: 'vi', label: 'TM', kind: 'voiceover', default: true },
        { file: 'audio/2.m4a', lang: 'en', label: 'EN', kind: 'dub', default: true },
      ],
    };
    const res = validateMediaPackageManifest(twoDefaultAudio);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes('tối đa 1 track âm thanh mặc định'))).toBe(true);

    const twoDefaultSubs: MediaPackageManifest = {
      ...validManifest,
      subtitles: [
        { file: 'subs/1.vtt', lang: 'vi', label: 'VI', default: true },
        { file: 'subs/2.vtt', lang: 'en', label: 'EN', default: true },
      ],
    };
    const subRes = validateMediaPackageManifest(twoDefaultSubs);
    expect(subRes.valid).toBe(false);
    expect(subRes.errors.some((e) => e.includes('tối đa 1 phụ đề mặc định'))).toBe(true);
  });

  it('flags missing referenced files when availableFiles is supplied', () => {
    const incompleteFiles = new Set(['manifest.json', 'video.mp4']);
    const res = validateMediaPackageManifest(validManifest, incompleteFiles);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes('audio/vi.m4a'))).toBe(true);
    expect(res.errors.some((e) => e.includes('subs/vi.vtt'))).toBe(true);
  });
});
