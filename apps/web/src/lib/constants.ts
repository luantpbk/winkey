export const DEFAULT_THUMBNAIL_URL = '/placeholder-thumbnail.svg';

/**
 * Resolves a thumbnail URL from one or more candidates, falling back to the local
 * SVG placeholder asset if none are present or if they are empty/whitespace.
 */
export function getThumbnailUrl(...candidates: Array<string | null | undefined>): string {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return DEFAULT_THUMBNAIL_URL;
}
