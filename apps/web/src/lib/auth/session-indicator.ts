import { tokenStore } from './token-store';

export const HAS_SESSION_COOKIE = 'wk_has_session';

/**
 * Checks whether there is an indication that a user session exists.
 * Returns true if an in-memory access token exists or if the non-secret
 * wk_has_session cookie is set to '1' or 'true'.
 */
export function hasSessionIndicator(): boolean {
  if (typeof document === 'undefined') {
    return false;
  }
  if (tokenStore.get()) {
    return true;
  }
  const cookies = document.cookie ? document.cookie.split(';') : [];
  for (const cookie of cookies) {
    const [rawKey, ...rest] = cookie.trim().split('=');
    if (rawKey === HAS_SESSION_COOKIE) {
      const val = rest.join('=');
      return val === '1' || val === 'true';
    }
  }
  return false;
}

/**
 * Marks that an authenticated session exists by setting the non-secret wk_has_session cookie.
 * Path is '/', SameSite is 'Lax', max-age is 30 days (2592000s) matching refresh token TTL.
 */
export function setSessionIndicator(): void {
  if (typeof document === 'undefined') {
    return;
  }
  const isSecure = typeof window !== 'undefined' && window.location.protocol === 'https:';
  document.cookie = `${HAS_SESSION_COOKIE}=1; path=/; max-age=2592000; SameSite=Lax${isSecure ? '; Secure' : ''}`;
}

/**
 * Clears the session indicator cookie.
 */
export function clearSessionIndicator(): void {
  if (typeof document === 'undefined') {
    return;
  }
  const isSecure = typeof window !== 'undefined' && window.location.protocol === 'https:';
  document.cookie = `${HAS_SESSION_COOKIE}=; path=/; max-age=0; expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax${isSecure ? '; Secure' : ''}`;
}
