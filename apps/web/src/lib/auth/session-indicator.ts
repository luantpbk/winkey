import { tokenStore } from './token-store';

export const HAS_SESSION_COOKIE = 'wk_has_session';
export const SESSION_PROBED_COOKIE = 'wk_session_probed';

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
 * Checks whether this device has already probed for an existing session.
 * Returns true if the non-secret wk_session_probed cookie is set to '1' or 'true'.
 */
export function hasSessionProbed(): boolean {
  if (typeof document === 'undefined') {
    return false;
  }
  const cookies = document.cookie ? document.cookie.split(';') : [];
  for (const cookie of cookies) {
    const [rawKey, ...rest] = cookie.trim().split('=');
    if (rawKey === SESSION_PROBED_COOKIE) {
      const val = rest.join('=');
      return val === '1' || val === 'true';
    }
  }
  return false;
}

/**
 * Indicates whether a one-time probe should be performed on boot.
 * True when neither wk_has_session nor wk_session_probed is present.
 */
export function shouldProbeSession(): boolean {
  return !hasSessionIndicator() && !hasSessionProbed();
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

/**
 * Marks that this device has already probed for a session once.
 * Path is '/', SameSite is 'Lax', max-age is 30 days.
 */
export function setSessionProbed(): void {
  if (typeof document === 'undefined') {
    return;
  }
  const isSecure = typeof window !== 'undefined' && window.location.protocol === 'https:';
  document.cookie = `${SESSION_PROBED_COOKIE}=1; path=/; max-age=2592000; SameSite=Lax${isSecure ? '; Secure' : ''}`;
}

/**
 * Clears the session probed cookie (useful for test resets).
 */
export function clearSessionProbed(): void {
  if (typeof document === 'undefined') {
    return;
  }
  const isSecure = typeof window !== 'undefined' && window.location.protocol === 'https:';
  document.cookie = `${SESSION_PROBED_COOKIE}=; path=/; max-age=0; expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax${isSecure ? '; Secure' : ''}`;
}

/**
 * Query marker added to the Google sign-in `return_to`. The OAuth callback sets only the HttpOnly
 * refresh cookie, so without the marker a device that already probed (wk_session_probed) would never
 * call /v1/auth/refresh after returning from Google (auth.v1 googleCallback: "the web app then calls
 * /v1/auth/refresh").
 */
export const OAUTH_RETURN_PARAM = 'wk_oauth';

/** Appends the OAuth-return marker to a relative path, keeping its query and hash. */
export function withOAuthReturnMarker(path: string): string {
  const hashIndex = path.indexOf('#');
  const base = hashIndex === -1 ? path : path.slice(0, hashIndex);
  const hash = hashIndex === -1 ? '' : path.slice(hashIndex);
  return `${base}${base.includes('?') ? '&' : '?'}${OAUTH_RETURN_PARAM}=1${hash}`;
}

/**
 * When the current URL carries the OAuth-return marker, removes it from the address bar
 * (replaceState, no new history entry) and returns true.
 */
export function consumeOAuthReturnMarker(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  const url = new URL(window.location.href);
  if (!url.searchParams.has(OAUTH_RETURN_PARAM)) {
    return false;
  }
  url.searchParams.delete(OAUTH_RETURN_PARAM);
  window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
  return true;
}
