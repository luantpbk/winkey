'use client';

import React, { useState, useEffect, Suspense, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '../../../i18n/routing';
import { useAuth } from '../../../lib/auth/auth-context';
import { executeVerifyOnce } from '../../../lib/auth/verify-email-action';
import { PlaySquare, AlertCircle, CheckCircle2, Loader2, Home, Settings } from 'lucide-react';

function VerifyEmailContent() {
  const t = useTranslations('auth');
  const { user, refresh } = useAuth();
  const tokenRef = useRef<string | null>(null);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const handledRef = useRef(false);

  const [status, setStatus] = useState<
    'loading' | 'success' | 'invalid' | 'rate_limited' | 'error'
  >('loading');

  useEffect(() => {
    if (typeof window === 'undefined') return;

    if (!tokenRef.current) {
      const params = new URLSearchParams(window.location.search);
      const rawToken = params.get('token');
      if (rawToken && rawToken.trim().length > 0) {
        tokenRef.current = rawToken.trim();
        window.history.replaceState({}, '', window.location.pathname);
      }
    }

    const currentToken = tokenRef.current;
    if (!currentToken) {
      setStatus('invalid');
      return;
    }

    let isCancelled = false;

    executeVerifyOnce(currentToken)
      .then(async (result) => {
        if (isCancelled || handledRef.current) return;
        handledRef.current = true;

        if (result.status === 204) {
          setStatus('success');
          // If the user is currently signed in, refresh session / getMe so verification state updates
          try {
            await refreshRef.current();
          } catch {
            // Non-blocking
          }
        } else if (result.status === 400) {
          setStatus('invalid');
        } else if (result.status === 429) {
          setStatus('rate_limited');
        } else {
          setStatus('error');
        }
      })
      .catch(() => {
        if (!isCancelled && !handledRef.current) {
          handledRef.current = true;
          setStatus('error');
        }
      });

    return () => {
      isCancelled = true;
    };
  }, []);

  return (
    <div className="flex min-h-[calc(100vh-140px)] items-center justify-center p-4">
      <meta name="referrer" content="no-referrer" />

      <div className="w-full max-w-md rounded-2xl border border-gray-200 dark:border-[#272727] bg-white dark:bg-[#141414] p-8 shadow-2xl">
        <div className="flex flex-col items-center gap-2 text-center mb-6">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-red-600 text-white shadow-lg">
            <PlaySquare className="h-7 w-7 fill-current" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white mt-2">
            {t('verifyEmailTitle')}
          </h1>
        </div>

        {status === 'loading' && (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <Loader2 className="h-8 w-8 animate-spin text-red-500" />
            <p className="text-xs text-gray-500 dark:text-gray-400">{t('verifyEmailLoading')}</p>
          </div>
        )}

        {status === 'success' && (
          <div className="flex flex-col items-center gap-4 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-500 border border-emerald-500/20">
              <CheckCircle2 className="h-6 w-6" />
            </div>
            <p className="text-base font-semibold text-gray-900 dark:text-white">
              {t('verifyEmailSuccess')}
            </p>
            <div className="flex flex-col sm:flex-row gap-2 w-full mt-2">
              <Link
                href="/"
                className="flex-1 flex h-11 items-center justify-center gap-2 rounded-xl bg-red-600 font-semibold text-sm text-white hover:bg-red-700 transition"
              >
                <Home className="h-4 w-4" />
                <span>{t('home')}</span>
              </Link>
              {user && (
                <Link
                  href="/settings/account"
                  className="flex-1 flex h-11 items-center justify-center gap-2 rounded-xl border border-gray-300 dark:border-[#383838] bg-gray-50 dark:bg-[#1e1e1e] font-semibold text-sm text-gray-800 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-[#282828] transition"
                >
                  <Settings className="h-4 w-4" />
                  <span>{t('settings')}</span>
                </Link>
              )}
            </div>
          </div>
        )}

        {status === 'invalid' && (
          <div className="flex flex-col items-center gap-4 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-red-500/10 text-red-500 border border-red-500/20">
              <AlertCircle className="h-6 w-6" />
            </div>
            <p className="text-xs text-gray-600 dark:text-gray-300 leading-relaxed">
              {t('verifyEmailInvalid')}
            </p>
            <div className="flex flex-col sm:flex-row gap-2 w-full mt-2">
              <Link
                href="/login"
                className="flex-1 flex h-11 items-center justify-center gap-2 rounded-xl bg-red-600 font-semibold text-sm text-white hover:bg-red-700 transition"
              >
                <span>{t('submitLogin')}</span>
              </Link>
              <Link
                href="/settings/account"
                className="flex-1 flex h-11 items-center justify-center gap-2 rounded-xl border border-gray-300 dark:border-[#383838] bg-gray-50 dark:bg-[#1e1e1e] font-semibold text-sm text-gray-800 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-[#282828] transition"
              >
                <span>Cài đặt</span>
              </Link>
            </div>
          </div>
        )}

        {status === 'rate_limited' && (
          <div className="flex flex-col items-center gap-4 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-amber-500/10 text-amber-500 border border-amber-500/20">
              <AlertCircle className="h-6 w-6" />
            </div>
            <p className="text-xs text-gray-600 dark:text-gray-300 leading-relaxed">
              {t('rateLimited')}
            </p>
            <Link
              href="/"
              className="mt-2 flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-red-600 font-semibold text-sm text-white hover:bg-red-700 transition"
            >
              <span>Trang chủ</span>
            </Link>
          </div>
        )}

        {status === 'error' && (
          <div className="flex flex-col items-center gap-4 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-red-500/10 text-red-500 border border-red-500/20">
              <AlertCircle className="h-6 w-6" />
            </div>
            <p className="text-xs text-gray-600 dark:text-gray-300 leading-relaxed">
              Đã xảy ra lỗi khi xác minh email. Vui lòng thử lại sau.
            </p>
            <Link
              href="/"
              className="mt-2 flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-red-600 font-semibold text-sm text-white hover:bg-red-700 transition"
            >
              <span>Trang chủ</span>
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={null}>
      <VerifyEmailContent />
    </Suspense>
  );
}
