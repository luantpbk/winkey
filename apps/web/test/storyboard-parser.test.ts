import { describe, it, expect } from 'vitest';
import {
  parseVttTimestamp,
  parseStoryboardVtt,
  findStoryboardCue,
  type StoryboardCue,
} from '../src/lib/video/storyboard-parser';

describe('Storyboard Parser Utility (Task U7)', () => {
  describe('parseVttTimestamp', () => {
    it.each([
      ['00:00.000', 0],
      ['01:30.500', 90.5],
      ['59:59.999', 3599.999],
      ['00:00:00.000', 0],
      ['01:00:00.000', 3600],
      ['01:23:45.678', 1 * 3600 + 23 * 60 + 45.678],
      ['00:10', 10],
      ['01:10:05', 4205],
    ])('correctly parses timestamp "%s" to %f seconds', (input, expected) => {
      expect(parseVttTimestamp(input)).toBeCloseTo(expected, 3);
    });

    it('returns null for invalid timestamps', () => {
      expect(parseVttTimestamp('')).toBeNull();
      expect(parseVttTimestamp('invalid')).toBeNull();
      expect(parseVttTimestamp('00')).toBeNull();
      expect(parseVttTimestamp('65:00')).toBeNull(); // invalid minutes >= 60
      expect(parseVttTimestamp('00:60.000')).toBeNull(); // invalid seconds >= 60
      expect(parseVttTimestamp('1:2:3:4')).toBeNull();
    });
  });

  describe('parseStoryboardVtt', () => {
    const baseUrl =
      'https://media.winkey.vn/s/1720000000/sig123/v/0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c10/storyboard/storyboard.vtt';

    it('parses standard WebVTT storyboard with relative sprite URLs and coordinates', () => {
      const vtt = `WEBVTT - Video Storyboard Previews

00:00:00.000 --> 00:00:05.000
sprites_0.jpg#xywh=0,0,160,90

00:00:05.000 --> 00:00:10.000
sprites_0.jpg#xywh=160,0,160,90

00:00:10.000 --> 00:00:15.000
sprites_0.jpg#xywh=320,0,160,90
`;

      const cues = parseStoryboardVtt(vtt, baseUrl);
      expect(cues).toHaveLength(3);

      expect(cues[0]).toEqual({
        start: 0,
        end: 5,
        url: 'https://media.winkey.vn/s/1720000000/sig123/v/0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c10/storyboard/sprites_0.jpg',
        x: 0,
        y: 0,
        w: 160,
        h: 90,
      });

      expect(cues[1]).toEqual({
        start: 5,
        end: 10,
        url: 'https://media.winkey.vn/s/1720000000/sig123/v/0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c10/storyboard/sprites_0.jpg',
        x: 160,
        y: 0,
        w: 160,
        h: 90,
      });

      expect(cues[2]).toEqual({
        start: 10,
        end: 15,
        url: 'https://media.winkey.vn/s/1720000000/sig123/v/0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c10/storyboard/sprites_0.jpg',
        x: 320,
        y: 0,
        w: 160,
        h: 90,
      });
    });

    it('parses hours-optional timestamps (MM:SS.mmm)', () => {
      const vtt = `WEBVTT

00:00.000 --> 00:10.000
sheet.jpg#xywh=0,0,200,112

00:10.000 --> 00:20.000
sheet.jpg#xywh=200,0,200,112
`;

      const cues = parseStoryboardVtt(vtt, baseUrl);
      expect(cues).toHaveLength(2);
      expect(cues[0].start).toBe(0);
      expect(cues[0].end).toBe(10);
      expect(cues[1].start).toBe(10);
      expect(cues[1].end).toBe(20);
    });

    it('preserves signed URL prefixes and query params in resolved sprite URLs', () => {
      const signedUrl =
        'https://media.winkey.vn/s/1720000000/sig_token_abc/v/vid_123/storyboard/preview.vtt?token=xyz';
      const vtt = `WEBVTT

00:00:00.000 --> 00:00:05.000
../img/sprite_grid.jpg#xywh=0,0,160,90
`;

      const cues = parseStoryboardVtt(vtt, signedUrl);
      expect(cues).toHaveLength(1);
      // Resolved relative to preview.vtt: ../img/sprite_grid.jpg
      expect(cues[0].url).toBe(
        'https://media.winkey.vn/s/1720000000/sig_token_abc/v/vid_123/img/sprite_grid.jpg',
      );
    });

    it('gracefully skips bad lines, comments, headers, and invalid cues', () => {
      const vttWithErrors = `WEBVTT
NOTE This is a note block that should be ignored

cue-1-identifier
00:00:00.000 --> 00:00:05.000
good.jpg#xywh=0,0,160,90

invalid-cue-end-before-start
00:00:10.000 --> 00:00:05.000
bad_timing.jpg#xywh=0,0,160,90

malformed-timing
not-a-timestamp --> definitely-not
broken.jpg#xywh=0,0,160,90

cue-with-missing-coords
00:00:20.000 --> 00:00:25.000
no_coords.jpg

cue-with-valid-trailing-settings
00:00:30.000 --> 00:00:35.000 position:50% line:0
good2.jpg#xywh=160,0,160,90
`;

      const cues = parseStoryboardVtt(vttWithErrors, baseUrl);
      expect(cues).toHaveLength(2);
      expect(cues[0].url).toContain('good.jpg');
      expect(cues[1].url).toContain('good2.jpg');
    });

    it('resolves sprite URLs correctly when storyboardUrl is a relative path', () => {
      const vtt = `WEBVTT

00:00:00.000 --> 00:00:05.000
sprites_0.jpg#xywh=0,0,160,90
`;
      const cues = parseStoryboardVtt(vtt, '/v1/mock-storyboard/123/storyboard.vtt');
      expect(cues).toHaveLength(1);
      expect(cues[0].url).toContain('/v1/mock-storyboard/123/sprites_0.jpg');
    });

    it('returns empty array when content or url is empty', () => {
      expect(parseStoryboardVtt('', baseUrl)).toEqual([]);
      expect(parseStoryboardVtt('WEBVTT', '')).toEqual([]);
    });
  });

  describe('findStoryboardCue', () => {
    const mockCues: StoryboardCue[] = [
      { start: 0, end: 5, url: 'img1.jpg', x: 0, y: 0, w: 160, h: 90 },
      { start: 5, end: 10, url: 'img2.jpg', x: 0, y: 0, w: 160, h: 90 },
      { start: 10, end: 15, url: 'img3.jpg', x: 0, y: 0, w: 160, h: 90 },
    ];

    it('returns null for empty cues array', () => {
      expect(findStoryboardCue([], 3)).toBeNull();
    });

    it('finds exact matching cue within range', () => {
      const cue = findStoryboardCue(mockCues, 7.5);
      expect(cue).toBeDefined();
      expect(cue?.start).toBe(5);
      expect(cue?.end).toBe(10);
    });

    it('returns first cue when time is <= first start', () => {
      const cue = findStoryboardCue(mockCues, -1);
      expect(cue?.start).toBe(0);
    });

    it('returns last cue when time is >= last end', () => {
      const cue = findStoryboardCue(mockCues, 25);
      expect(cue?.start).toBe(10);
    });
  });
});
