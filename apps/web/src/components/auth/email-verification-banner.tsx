'use client';

import React, { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { useAuth } from '../../lib/auth/auth-context';
import { api } from '../../lib/api-client';
import { ShieldAlert, X, Loader2, Check } from 'lucide-react';

export function EmailVerificationBanner() {
  const t = useTranslations('auth');
  const { user, isAuthenticated, refresh } = useAuth();

  const [isDismissed, setIsDismissed] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [statusMessage, setStatusMessage] = useState<'sent' | 'rate_limited' | 'error' | null>(
    null,
  );

  const storageKey = user ? `wk_dismiss_email_banner_${user.id}` : null;

  useEffect(() => {
    if (!storageKey || typeof window === 'undefined') return;
    const dismissed = sessionStorage.getItem(storageKey) === 'true';
    setIsDismissed(dismissed);
    setStatusMessage(null);
  }, [storageKey]);

  if (!isAuthenticated || !user || user.email_verified || isDismissed) {
    return null;
  }

  const handleDismiss = () => {
    if (storageKey && typeof window !== 'undefined') {
      sessionStorage.setItem(storageKey, 'true');
    }
    setIsDismissed(true);
  };

  const handleResend = async () => {
    setIsSending(true);
    setStatusMessage(null);

    try {
      const res = await api.auth.POST('/v1/auth/email/verification');

      if (res.response.status === 202) {
        setStatusMessage('sent');
      } else if (res.response.status === 409) {
        // 409 EMAIL_ALREADY_VERIFIED: hide the banner and refresh getMe
        setIsDismissed(true);
        if (storageKey && typeof window !== 'undefined') {
          sessionStorage.setItem(storageKey, 'true');
        }
        await refresh();
      } else if (res.response.status === 429) {
        setStatusMessage('rate_limited');
      } else {
        setStatusMessage('error');
      }
    } catch {
      setStatusMessage('error');
    } finally {
      setIsSending(false);
    }
  };

  return (
    <div
      role="region"
      aria-label="Email verification"
      className="w-full bg-amber-500/15 border-b border-amber-500/30 px-4 py-2.5 text-xs text-amber-900 dark:text-amber-200 transition-colors flex items-center justify-between gap-3 z-30"
    >
      <div className="flex items-center gap-2 min-w-0">
        <ShieldAlert className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <span className="truncate font-medium">{t('verifyBannerText')}</span>
      </div>

      <div className="flex items-center gap-3 shrink-0">
        {statusMessage === 'sent' && (
          <span className="inline-flex items-center gap-1 font-semibold text-emerald-600 dark:text-emerald-400">
            <Check className="h-3.5 w-3.5" />
            {t('emailSent')}
          </span>
        )}

        {statusMessage === 'rate_limited' && (
          <span className="font-semibold text-amber-700 dark:text-amber-300">
            {t('rateLimited')}
          </span>
        )}

        {statusMessage === 'error' && (
          <span className="font-semibold text-red-600 dark:text-red-400">Lỗi</span>
        )}

        {statusMessage !== 'sent' && (
          <button
            onClick={handleResend}
            disabled={isSending}
            className="flex items-center gap-1 px-3 py-1 rounded-lg bg-amber-600 dark:bg-amber-500 text-white font-semibold hover:bg-amber-700 dark:hover:bg-amber-600 transition disabled:opacity-50"
          >
            {isSending ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
            <span>{t('resendEmail')}</span>
          </button>
        )}

        <button
          onClick={handleDismiss}
          aria-label="Dismiss email verification banner"
          className="rounded-md p-1 text-amber-700 dark:text-amber-300 hover:bg-amber-500/20 transition"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
