import { describe, it, expect } from 'vitest';
import { winkeyTagSlug, parseBodyTokens, extractCandidates } from '../../src/utils/text-parser.js';

describe('text-parser', () => {
  describe('winkeyTagSlug', () => {
    it('handles basic ASCII tags', () => {
      expect(winkeyTagSlug('winkey')).toBe('winkey');
      expect(winkeyTagSlug('tech_news')).toBe('tech-news');
    });

    it('folds Vietnamese diacritics and d/D properly', () => {
      expect(winkeyTagSlug('HàNội')).toBe('hanoi');
      expect(winkeyTagSlug('Hà Nội')).toBe('ha-noi');
      expect(winkeyTagSlug('ĐẲNG')).toBe('dang');
      expect(winkeyTagSlug('đẹp_lắm')).toBe('dep-lam');
      expect(winkeyTagSlug('#Hà_Nội 2026')).toBe('ha-noi-2026');
    });

    it('matches slug equality for different spellings', () => {
      expect(winkeyTagSlug('HàNội')).toBe(winkeyTagSlug('hanoi'));
      expect(winkeyTagSlug('HàNội')).toBe(winkeyTagSlug('HANOI'));
      expect(winkeyTagSlug('Hà_Nội')).toBe(winkeyTagSlug('ha-noi'));
    });

    it('returns empty string for non-Latin and punctuation-only tags', () => {
      expect(winkeyTagSlug('!!!')).toBe('');
      expect(winkeyTagSlug('___')).toBe('');
      expect(winkeyTagSlug('电影')).toBe('');
    });
  });

  describe('extractCandidates and token boundaries', () => {
    it('does not parse emails as mentions', () => {
      const text = 'Contact support at user@example.com or admin@winkey.vn for help.';
      const { rawHandles } = extractCandidates(text);
      expect(rawHandles).toEqual([]);
    });

    it('does not parse URLs with hash fragments as hashtags', () => {
      const text = 'Visit https://example.com#section and http://winkey.vn/page#header today.';
      const { rawTags } = extractCandidates(text);
      expect(rawTags).toEqual([]);
    });

    it('parses valid mentions at start, middle, and end of sentence', () => {
      const text = '@alice check this out with @bob! Also ping @charlie.';
      const { handles } = parseBodyTokens(text);
      expect(handles).toEqual(['alice', 'bob', 'charlie']);
    });

    it('parses valid hashtags with Vietnamese diacritics', () => {
      const text = 'Chào mừng đến #HàNội và thưởng thức #ẩm_thực tuyệt vời!';
      const { hashtags } = parseBodyTokens(text);
      expect(hashtags).toEqual([
        { tag: 'HàNội', slug: 'hanoi' },
        { tag: 'ẩm_thực', slug: 'am-thuc' },
      ]);
    });

    it('keeps the first spelling of each hashtag slug and deduplicates', () => {
      const text = '#HàNội is #hanoi and #HANOI. We also love #saigon and #SàiGòn.';
      const { hashtags } = parseBodyTokens(text);
      expect(hashtags).toEqual([
        { tag: 'HàNội', slug: 'hanoi' },
        { tag: 'saigon', slug: 'saigon' },
      ]);
    });

    it('caps mentions at 10 items', () => {
      const handles = Array.from({ length: 15 }, (_, i) => `@user_${i}`).join(' ');
      const { handles: parsed } = parseBodyTokens(handles);
      expect(parsed).toHaveLength(10);
      expect(parsed[0]).toBe('user_0');
      expect(parsed[9]).toBe('user_9');
    });

    it('caps hashtags at 10 items', () => {
      const tags = Array.from({ length: 15 }, (_, i) => `#tag_${i}`).join(' ');
      const { hashtags: parsed } = parseBodyTokens(tags);
      expect(parsed).toHaveLength(10);
      expect(parsed[0].slug).toBe('tag-0');
      expect(parsed[9].slug).toBe('tag-9');
    });

    it('ignores tags with empty slug', () => {
      const text = '#电影 #!!! #good_tag';
      const { hashtags } = parseBodyTokens(text);
      expect(hashtags).toEqual([{ tag: 'good_tag', slug: 'good-tag' }]);
    });
  });
});
