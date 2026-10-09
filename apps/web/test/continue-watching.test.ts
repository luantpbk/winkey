import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  CONTINUE_WATCHING_STORAGE_KEY,
  MAX_CONTINUE_WATCHING_ENTRIES,
  getContinueWatching,
  saveContinueWatching,
  removeContinueWatching,
  pruneContinueWatching,
} from '../src/lib/video/continue-watching';

describe('Continue Watching Local Index (ADR-033 / Task CIN1)', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('handles invalid JSON gracefully and returns empty array', () => {
    localStorage.setItem(CONTINUE_WATCHING_STORAGE_KEY, '{invalid json');
    expect(getContinueWatching()).toEqual([]);

    localStorage.setItem(CONTINUE_WATCHING_STORAGE_KEY, 'null');
    expect(getContinueWatching()).toEqual([]);

    localStorage.setItem(CONTINUE_WATCHING_STORAGE_KEY, '{"not":"an array"}');
    expect(getContinueWatching()).toEqual([]);
  });

  it('upserts new entries newest first', () => {
    saveContinueWatching('vid-1', 30, 100);
    let entries = getContinueWatching();
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe('vid-1');
    expect(entries[0].t).toBe(30);
    expect(entries[0].d).toBe(100);

    saveContinueWatching('vid-2', 45, 120);
    entries = getContinueWatching();
    expect(entries).toHaveLength(2);
    expect(entries[0].id).toBe('vid-2');
    expect(entries[1].id).toBe('vid-1');

    // Updating vid-1 moves it to the front
    saveContinueWatching('vid-1', 60, 100);
    entries = getContinueWatching();
    expect(entries).toHaveLength(2);
    expect(entries[0].id).toBe('vid-1');
    expect(entries[0].t).toBe(60);
    expect(entries[1].id).toBe('vid-2');
  });

  it('caps at maximum 20 entries', () => {
    for (let i = 1; i <= 25; i++) {
      saveContinueWatching(`vid-${i}`, 10, 100);
    }
    const entries = getContinueWatching();
    expect(entries).toHaveLength(MAX_CONTINUE_WATCHING_ENTRIES);
    expect(entries[0].id).toBe('vid-25');
    expect(entries[MAX_CONTINUE_WATCHING_ENTRIES - 1].id).toBe('vid-6');
  });

  it('removes the entry when progress is >= 95%', () => {
    saveContinueWatching('vid-1', 50, 100);
    expect(getContinueWatching()).toHaveLength(1);

    // 95 / 100 = 0.95 -> should remove
    saveContinueWatching('vid-1', 95, 100);
    expect(getContinueWatching()).toHaveLength(0);

    saveContinueWatching('vid-2', 50, 100);
    // 96 / 100 > 0.95 -> should remove
    saveContinueWatching('vid-2', 96, 100);
    expect(getContinueWatching()).toHaveLength(0);
  });

  it('removes entry explicitly via removeContinueWatching', () => {
    saveContinueWatching('vid-1', 10, 100);
    saveContinueWatching('vid-2', 20, 100);
    expect(getContinueWatching()).toHaveLength(2);

    removeContinueWatching('vid-1');
    const entries = getContinueWatching();
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe('vid-2');
  });

  it('prunes unreadable or missing video IDs from the index', () => {
    saveContinueWatching('vid-1', 10, 100);
    saveContinueWatching('vid-2', 20, 100);
    saveContinueWatching('vid-3', 30, 100);

    // batchGetVideos only returned vid-1 and vid-3
    pruneContinueWatching(['vid-1', 'vid-3']);

    const entries = getContinueWatching();
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.id)).toEqual(['vid-3', 'vid-1']);
  });

  it('wraps localStorage exceptions safely in try/catch', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });

    expect(() => saveContinueWatching('vid-1', 10, 100)).not.toThrow();
    expect(() => removeContinueWatching('vid-1')).not.toThrow();
    expect(() => pruneContinueWatching(['vid-1'])).not.toThrow();
  });
});
