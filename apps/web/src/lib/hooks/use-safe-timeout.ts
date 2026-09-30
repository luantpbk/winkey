import { useCallback, useEffect, useRef } from 'react';

export type SafeTimeoutClearFn = () => void;
export type SafeTimeoutFn = (handler: () => void, delayMs: number) => SafeTimeoutClearFn;

/**
 * useSafeTimeout
 *
 * Keeps track of active timer IDs in a useRef set and automatically clears
 * them all when the component unmounts, preventing unhandled errors, memory leaks,
 * or state updates on unmounted components after async teardown.
 */
export function useSafeTimeout(): SafeTimeoutFn {
  const timerIdsRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  useEffect(() => {
    const timerIds = timerIdsRef.current;
    return () => {
      timerIds.forEach((id) => clearTimeout(id));
      timerIds.clear();
    };
  }, []);

  const safeTimeout = useCallback((handler: () => void, delayMs: number): SafeTimeoutClearFn => {
    const timerId = setTimeout(() => {
      timerIdsRef.current.delete(timerId);
      handler();
    }, delayMs);

    timerIdsRef.current.add(timerId);

    return () => {
      clearTimeout(timerId);
      timerIdsRef.current.delete(timerId);
    };
  }, []);

  return safeTimeout;
}
