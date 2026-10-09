export interface ContinueWatchingEntry {
  id: string;
  t: number;
  d: number;
  at: number;
}

export const CONTINUE_WATCHING_STORAGE_KEY = 'winkey.continue_watching';
export const MAX_CONTINUE_WATCHING_ENTRIES = 20;

/**
 * Reads continue-watching entries from localStorage.
 * Handles corrupt JSON safely by treating it as empty array.
 */
export function getContinueWatching(): ContinueWatchingEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(CONTINUE_WATCHING_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is ContinueWatchingEntry =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof entry.id === 'string' &&
        entry.id.length > 0 &&
        typeof entry.t === 'number' &&
        !isNaN(entry.t) &&
        typeof entry.d === 'number' &&
        !isNaN(entry.d) &&
        typeof entry.at === 'number' &&
        !isNaN(entry.at),
    );
  } catch {
    return [];
  }
}

/**
 * Upserts a continue-watching entry into localStorage.
 * If position >= 95% of duration, the entry is removed instead.
 * Capped at 20 entries, newest first.
 */
export function saveContinueWatching(id: string, time: number, duration: number): void {
  if (typeof window === 'undefined') return;
  if (!id || time <= 0 || duration <= 0) return;

  try {
    if (time / duration >= 0.95) {
      removeContinueWatching(id);
      return;
    }

    const existing = getContinueWatching().filter((e) => e.id !== id);
    const updated: ContinueWatchingEntry[] = [
      {
        id,
        t: Math.round(time * 100) / 100,
        d: Math.round(duration * 100) / 100,
        at: Date.now(),
      },
      ...existing,
    ].slice(0, MAX_CONTINUE_WATCHING_ENTRIES);

    localStorage.setItem(CONTINUE_WATCHING_STORAGE_KEY, JSON.stringify(updated));
  } catch {
    // Ignore storage exceptions
  }
}

/**
 * Removes a continue-watching entry by video ID.
 */
export function removeContinueWatching(id: string): void {
  if (typeof window === 'undefined') return;
  if (!id) return;

  try {
    const existing = getContinueWatching().filter((e) => e.id !== id);
    localStorage.setItem(CONTINUE_WATCHING_STORAGE_KEY, JSON.stringify(existing));
  } catch {
    // Ignore storage exceptions
  }
}

/**
 * Prunes the continue-watching list to keep only IDs present in validIds.
 * Drops IDs that batchGetVideos did not return and rewrites the index.
 */
export function pruneContinueWatching(validIds: Set<string> | string[]): void {
  if (typeof window === 'undefined') return;

  try {
    const validSet = validIds instanceof Set ? validIds : new Set(validIds);
    const current = getContinueWatching();
    const pruned = current.filter((e) => validSet.has(e.id));
    if (pruned.length !== current.length) {
      localStorage.setItem(CONTINUE_WATCHING_STORAGE_KEY, JSON.stringify(pruned));
    }
  } catch {
    // Ignore storage exceptions
  }
}
