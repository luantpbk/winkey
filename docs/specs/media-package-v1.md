# Winkey media package v1: video, audio tracks (dub / voice-over) and subtitles (MUX1, ADR-042)

This is the format for exporting a film or episode to Winkey with **separate audio tracks** (original, dubbed or voice-over in any language) and **separate subtitles**. Viewers can then switch audio language and turn subtitles on or off in the player.

Status: **specification**. Subtitles (WebVTT per language) already work today in Studio. Separate audio tracks arrive with MUX1 (see "Rollout").

## 1. Folder layout

One folder per video (film or episode):

```
<package>/
  manifest.json            required, describes everything below
  video.mp4                required, picture + (optional) original audio
  audio/
    vi.m4a                 one file per extra audio track
    en.m4a
  subs/
    vi.vtt                 one file per subtitle track
    en.vtt
    vi-forced.vtt          optional "forced" track (signs and foreign lines only)
```

- File names are free. `manifest.json` is the source of truth; the names above are only a recommendation.
- Use only ASCII letters, digits, `-`, `_`, `.` and `/` in paths. No spaces.

## 2. Video file (`video`)

| Item | Requirement |
|---|---|
| Container | MP4 (preferred), MOV or MKV |
| Video codec | H.264, HEVC or AV1; Winkey re-encodes it anyway |
| Resolution / frame rate | Up to 3840×2160, constant frame rate preferred (23.976, 24, 25, 29.97, 30, 50, 60) |
| Original audio | Optional, at most one track inside the file. Its language goes in `original_audio.lang` |
| Size / duration | Same limits as a normal upload |

**The video's timeline is the reference clock.** Every audio and subtitle file is aligned to it: t = 0 is the video's first frame.

## 3. Audio tracks (`audio_tracks`)

Each track is a **complete final mix**: dialogue plus music and effects, ready to play on its own. The player switches whole tracks and **does not mix** a voice track over the original.

- For a **voice-over** (`voiceover`), export the original sound with the narration on top, already mixed.
- For a **dub** (`dub`), export the dubbed dialogue with the M&E stem.

| Item | Requirement |
|---|---|
| Format | Preferred: **WAV PCM 24-bit or FLAC** (lossless). Accepted: AAC-LC in `.m4a` at ≥ 192 kb/s stereo, or Opus in `.ogg`/`.webm` at ≥ 128 kb/s |
| Sample rate | **48 kHz** (44.1 kHz accepted, resampled) |
| Channels | Stereo (2.0). 5.1 is accepted and downmixed to stereo |
| Start | Starts at the video's **first frame**. Keep leading silence; do not trim it |
| Duration | Equal to the video duration **±100 ms**. Longer or shorter files are rejected |
| Loudness | Recommended −16 LUFS integrated, true peak ≤ −1 dBTP. Keep all tracks of one video at the same loudness so switching does not jump in volume |
| Count | At most **8** extra tracks per video |

Winkey encodes each track to AAC-LC 128 kb/s stereo, 48 kHz, as an HLS alternate audio rendition.

## 4. Subtitles (`subtitles`)

| Item | Requirement |
|---|---|
| Format | **WebVTT** (`.vtt`), UTF-8 without BOM. The first line is `WEBVTT` |
| Size | ≤ 512 KiB per file |
| Timing | `HH:MM:SS.mmm --> HH:MM:SS.mmm`, on the video timeline (t = 0 = first frame) |
| Styling | Plain text plus `<i>`, `<b>`, `<u>`. Cue settings such as `line:` and `position:` are allowed; no `STYLE` blocks or images |
| Line length | At most 2 lines per cue, about 42 characters per line |
| Count | At most **20** tracks per video (the current limit) |
| `kind` | `subtitles` (translation), `captions` (for deaf and hard-of-hearing viewers: includes sounds such as `[nhạc]`), `forced` (only signs and foreign-language lines; shown automatically with the matching audio) |

If your software exports **SRT**, convert it: add a `WEBVTT` line and a blank line at the top, and replace the comma in times with a dot (`00:01:02,500` → `00:01:02.500`). Cue numbers can stay.

## 5. `manifest.json`

```json
{
  "schema": "winkey.media-package/v1",
  "title": "Tên phim – Tập 1",
  "video": {
    "file": "video.mp4",
    "original_audio": { "lang": "zh", "label": "Tiếng Trung (gốc)" }
  },
  "audio_tracks": [
    { "file": "audio/vi.m4a", "lang": "vi", "label": "Thuyết minh", "kind": "voiceover", "default": true },
    { "file": "audio/vi-dub.m4a", "lang": "vi", "label": "Lồng tiếng", "kind": "dub" },
    { "file": "audio/en.m4a", "lang": "en", "label": "English", "kind": "dub" }
  ],
  "subtitles": [
    { "file": "subs/vi.vtt", "lang": "vi", "label": "Tiếng Việt", "kind": "subtitles", "default": true },
    { "file": "subs/en.vtt", "lang": "en", "label": "English", "kind": "subtitles" },
    { "file": "subs/vi-forced.vtt", "lang": "vi", "label": "Tiếng Việt (bắt buộc)", "kind": "forced" }
  ]
}
```

Field rules:

| Field | Rule |
|---|---|
| `schema` | Exactly `winkey.media-package/v1` |
| `title` | 1–200 characters. Used as the default title; it can be edited in Studio |
| `video.file` | Required path |
| `video.original_audio` | Omit it if the video file has no audio. `lang` and `label` follow the rules below |
| `lang` | BCP 47: lowercase language plus optional uppercase region: `vi`, `en`, `zh`, `en-US`, `zh-TW`. The same pattern as the subtitle API: `^[a-z]{2,3}(-[A-Z]{2})?$` |
| `label` | 1–50 characters, shown in the player menu |
| `kind` (audio) | `original`, `dub`, `voiceover` or `commentary` |
| `kind` (subtitles) | `subtitles`, `captions` or `forced` |
| `default` | At most one `true` per list. Default audio when none is marked: the original audio, otherwise the first track. Subtitles: off unless one is marked `default` |
| Uniqueness | `lang` + `kind` must be unique within each list (one `vi` voice-over, one `vi` dub, and so on) |

## 6. Checklist for the export software

1. Every audio file starts at the video's first frame and differs from the video duration by at most 100 ms.
2. Audio tracks are full mixes (voice + music + effects), 48 kHz, stereo, preferably WAV or FLAC.
3. Subtitles are WebVTT, UTF-8, at most 512 KiB each, timed on the video timeline.
4. `manifest.json` validates against section 5: unique `lang`+`kind`, at most one `default` per list, at most 8 audio and 20 subtitle tracks.
5. All tracks of one video share the same loudness target.

## 7. Rollout (MUX1)

- **Today:** the video upload plus subtitles. Upload the video normally, then add each `.vtt` in Studio (one per language, through `PUT /v1/videos/{id}/subtitles/{lang}`).
- **MUX1, planned:**
  1. Contract change: audio tracks on the upload and playback APIs (`Playback.audio_tracks`) plus subtitle `kind`.
  2. Migration `media.video_audio_tracks`.
  3. Transcoder: HLS with **video-only variants plus `#EXT-X-MEDIA:TYPE=AUDIO` renditions**. An audio track added after publishing is encoded on its own; the video is not re-encoded.
  4. Studio "upload package" (folder or `.zip` with `manifest.json`) and per-track add/replace/remove.
  5. Player: audio-language and subtitle menus, remembered per viewer.
- Videos uploaded before MUX1 keep their current single-audio HLS.
