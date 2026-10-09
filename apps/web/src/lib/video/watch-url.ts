import type { PlaybackSample } from '@winkey/api-client';

export type WatchSurface = NonNullable<PlaybackSample['surface']>;

export const VALID_WATCH_SURFACES: readonly WatchSurface[] = [
  'for_you',
  'latest',
  'trending',
  'up_next',
  'search',
  'subscriptions',
  'channel',
  'playlist',
  'other',
] as const;

/**
 * Checks if a value is a valid WatchSurface enum from the contract.
 */
export function isWatchSurface(value: unknown): value is WatchSurface {
  return typeof value === 'string' && (VALID_WATCH_SURFACES as readonly string[]).includes(value);
}

/**
 * Parses a string into a valid WatchSurface, defaulting to 'other' if unknown or missing.
 */
export function parseWatchSurface(value: string | null | undefined): WatchSurface {
  if (!value) return 'other';
  return isWatchSurface(value) ? value : 'other';
}

/**
 * Shared helper to build watch URLs.
 * Every link to a watch page carries ?src=<surface>.
 * Extra query parameters (e.g. ?comment=..., ?t=...) can also be supplied.
 */
export function buildWatchUrl(
  videoId: string,
  surface?: WatchSurface,
  extraParams?: Record<string, string | number | boolean | null | undefined>,
): string {
  const params = new URLSearchParams();

  if (extraParams) {
    for (const [key, val] of Object.entries(extraParams)) {
      if (val !== undefined && val !== null && val !== '') {
        params.set(key, String(val));
      }
    }
  }

  if (surface) {
    params.set('src', surface);
  }

  const query = params.toString();
  return `/watch/${encodeURIComponent(videoId)}${query ? `?${query}` : ''}`;
}

let lastStrippedSurface: { pathname: string; surface: WatchSurface } | null = null;

/**
 * Reads `src` once from window.location, validates it (unknown -> 'other'),
 * and strips `src` from the address bar using history.replaceState (keeping other params).
 * Returns the resolved WatchSurface for the current playback.
 * Caches the resolved surface for the pathname to safely support React StrictMode remounts.
 */
export function stripWatchSurfaceFromAddressBar(): WatchSurface {
  if (typeof window === 'undefined') return 'other';
  try {
    const url = new URL(window.location.href);
    const rawSrc = url.searchParams.get('src');

    if (rawSrc) {
      const surface = parseWatchSurface(rawSrc);
      lastStrippedSurface = { pathname: url.pathname, surface };

      url.searchParams.delete('src');
      const search = url.searchParams.toString();
      const newUrl = `${url.pathname}${search ? `?${search}` : ''}${url.hash}`;
      window.history.replaceState(window.history.state, '', newUrl);

      return surface;
    }

    if (lastStrippedSurface && lastStrippedSurface.pathname === url.pathname) {
      return lastStrippedSurface.surface;
    }

    return 'other';
  } catch {
    return 'other';
  }
}
