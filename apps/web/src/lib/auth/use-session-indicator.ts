'use client';

import { useSyncExternalStore } from 'react';
import { hasSessionIndicator } from './session-indicator';

const subscribeNever = () => () => {};
const noSessionOnServer = () => false;

/**
 * hasSessionIndicator for rendering. The cookie is readable only in the browser, so hydration uses the server's answer
 * (false) and React re-renders right after, with no hydration mismatch (#553). A separate file because
 * session-indicator.ts is also loaded by server components, which cannot import this React hook.
 */
export function useSessionIndicator(): boolean {
  return useSyncExternalStore(subscribeNever, hasSessionIndicator, noSessionOnServer);
}
