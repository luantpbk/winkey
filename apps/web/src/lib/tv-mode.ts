'use client';

import { useState, useEffect, useCallback } from 'react';

export const TV_MODE_STORAGE_KEY = 'winkey_tv_mode';

const TV_USER_AGENT_REGEX =
  /Tizen|webOS|Android.*TV|SMART-TV|SmartTV|AppleTV|BRAVIA|NetCast|Viera/i;

/**
 * Safely evaluates a media query without throwing in SSR or JSDOM.
 */
export function safeMatchMedia(query: string): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  try {
    return Boolean(window.matchMedia(query)?.matches);
  } catch {
    return false;
  }
}

/**
 * Detects whether the current device is a Smart TV / TV console.
 * Priority:
 * 1. User Agent matches known TV platforms (Tizen, webOS, Android TV, etc.)
 * 2. Viewport width >= 960px AND touch/remote coarse pointer with no hover capability
 */
export function detectIsTvDevice(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return false;
  }

  // Check TV User-Agents
  if (TV_USER_AGENT_REGEX.test(navigator.userAgent)) {
    return true;
  }

  // Check large screen + coarse non-hover pointer (TV remotes)
  const isLargeScreen = window.innerWidth >= 960;
  const hasNoHover = safeMatchMedia('(hover: none)') || safeMatchMedia('(pointer: coarse)');

  return Boolean(isLargeScreen && hasNoHover);
}

/**
 * Resolves active TV mode:
 * 1. Checks localStorage manual toggle preference ('true' / 'false')
 * 2. Falls back to device auto-detection (desktop/mobile default to false)
 */
export function getTvModePreference(): boolean {
  if (typeof window === 'undefined') return false;

  try {
    const stored = localStorage.getItem(TV_MODE_STORAGE_KEY);
    if (stored !== null) {
      return stored === 'true';
    }
  } catch {
    // Ignore storage access restrictions
  }

  return detectIsTvDevice();
}

/**
 * Reactive hook providing TV mode state and manual toggle control.
 */
export function useTvMode(): {
  isTvMode: boolean;
  setTvMode: (enabled: boolean) => void;
  toggleTvMode: () => void;
} {
  const [isTvMode, setIsTvModeState] = useState<boolean>(false);

  useEffect(() => {
    setIsTvModeState(getTvModePreference());

    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === TV_MODE_STORAGE_KEY) {
        setIsTvModeState(getTvModePreference());
      }
    };

    const handleCustomChange = () => {
      setIsTvModeState(getTvModePreference());
    };

    window.addEventListener('storage', handleStorageChange);
    window.addEventListener('winkey-tv-mode-changed', handleCustomChange);

    return () => {
      window.removeEventListener('storage', handleStorageChange);
      window.removeEventListener('winkey-tv-mode-changed', handleCustomChange);
    };
  }, []);

  const setTvMode = useCallback((enabled: boolean) => {
    try {
      localStorage.setItem(TV_MODE_STORAGE_KEY, String(enabled));
    } catch {
      // Ignore storage errors
    }
    setIsTvModeState(enabled);
    window.dispatchEvent(new Event('winkey-tv-mode-changed'));
  }, []);

  const toggleTvMode = useCallback(() => {
    setTvMode(!getTvModePreference());
  }, [setTvMode]);

  return { isTvMode, setTvMode, toggleTvMode };
}
