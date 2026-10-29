'use client';

import React, { useEffect, useRef, useState } from 'react';
import Script from 'next/script';
import { useNonce } from '../providers';

declare global {
  interface Window {
    __TURNSTILE_SITE_KEY__?: string;
    turnstile?: {
      render: (
        container: HTMLElement | string,
        options: {
          sitekey: string;
          callback?: (token: string) => void;
          'error-callback'?: (error: unknown) => void;
          'expired-callback'?: () => void;
          theme?: 'light' | 'dark' | 'auto';
        },
      ) => string;
      reset: (widgetId?: string) => void;
      remove: (widgetId?: string) => void;
    };
  }
}

interface TurnstileWidgetProps {
  onToken: (token: string) => void;
  className?: string;
  nonce?: string;
}

export function TurnstileWidget({
  onToken,
  className = '',
  nonce: propNonce,
}: TurnstileWidgetProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const contextNonce = useNonce();
  const nonce = propNonce || contextNonce;

  const [scriptLoaded, setScriptLoaded] = useState(false);
  const siteKey =
    process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ||
    (typeof window !== 'undefined' ? window.__TURNSTILE_SITE_KEY__ : undefined);

  useEffect(() => {
    if (typeof window !== 'undefined' && window.turnstile) {
      setScriptLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!scriptLoaded || !siteKey || !containerRef.current || !window.turnstile) return;

    try {
      if (widgetIdRef.current) {
        window.turnstile.remove(widgetIdRef.current);
        widgetIdRef.current = null;
      }

      widgetIdRef.current = window.turnstile.render(containerRef.current, {
        sitekey: siteKey,
        theme: 'dark',
        callback: (token: string) => {
          onToken(token);
        },
        'expired-callback': () => {
          onToken('');
        },
        'error-callback': () => {
          onToken('');
        },
      });
    } catch {
      // Ignored in test / headless environments
    }

    return () => {
      if (widgetIdRef.current && window.turnstile) {
        try {
          window.turnstile.remove(widgetIdRef.current);
          widgetIdRef.current = null;
        } catch {
          // ignore
        }
      }
    };
  }, [scriptLoaded, siteKey, onToken]);

  if (!siteKey) return null;

  return (
    <>
      <Script
        id="cf-turnstile-script"
        src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
        strategy="afterInteractive"
        nonce={nonce}
        onLoad={() => setScriptLoaded(true)}
      />
      <div
        data-testid="turnstile-widget"
        className={`my-3 flex justify-center ${className}`}
        ref={containerRef}
      />
    </>
  );
}
