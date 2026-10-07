'use client';

import { useState, useEffect } from 'react';

/**
 * Hook to dynamically resolve the sanitized runtime FEEDBACK_URL from the server.
 * Ensures that changes to FEEDBACK_URL across server/container restarts take effect
 * on the exact same build artifact without requiring a rebuild, while preserving
 * static site generation (SSG) for legal pages.
 */
export function useFeedbackUrl(initialUrl?: string | null): string | null {
  const [remoteUrl, setRemoteUrl] = useState<string | null>(null);

  useEffect(() => {
    if (initialUrl !== undefined) {
      return;
    }
    if (typeof fetch !== 'function') {
      return;
    }
    let mounted = true;
    fetch('/api/feedback-url')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (mounted && data && typeof data === 'object' && 'feedbackUrl' in data) {
          setRemoteUrl(data.feedbackUrl);
        }
      })
      .catch(() => {
        // Keep null on network failure / offline
      });

    return () => {
      mounted = false;
    };
  }, [initialUrl]);

  if (initialUrl !== undefined) {
    return initialUrl;
  }
  return remoteUrl;
}
