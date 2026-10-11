/**
 * Validates and sanitizes the `return_to` destination parameter to prevent open redirect attacks.
 *
 * Requirements:
 * - Must start with '/' not followed by another '/' or '\' (/^\/(?![/\\])/).
 * - Must not contain control characters (ASCII 0x00-0x1F or 0x7F).
 * - Any invalid or disallowed value falls back to '/'.
 */
export function getSafeReturnTo(returnTo: string | null | undefined): string {
  if (!returnTo || typeof returnTo !== 'string') {
    return '/';
  }

  // Reject paths that don't match /^\/(?![/\\])/ (e.g. //evil.com, /\evil.com, https://evil.com)
  if (!/^\/(?![/\\])/.test(returnTo)) {
    return '/';
  }

  // Reject paths containing ASCII control characters (0x00-0x1F, 0x7F)
  for (let i = 0; i < returnTo.length; i++) {
    const code = returnTo.charCodeAt(i);
    if ((code >= 0 && code <= 31) || code === 127) {
      return '/';
    }
  }

  return returnTo;
}
