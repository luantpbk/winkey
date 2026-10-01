'use client';

import React, { useState, useEffect, Suspense, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '../../../i18n/routing';
import { api } from '../../../lib/api-client';
import { tokenStore } from '../../../lib/auth/token-store';
import { useAuth } from '../../../lib/auth/auth-context';
import { PlaySquare, AlertCircle, CheckCircle2, ArrowLeft } from 'lucide-react';
import type { Problem } from '@winkey/api-client';

function ResetPasswordForm() {
  const t = useTranslations('auth');
  const { clearSession } = useAuth();

  const tokenRef = useRef<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [tokenChecked, setTokenChecked] = useState(false);
  const [invalidToken, setInvalidToken] = useState(false);

  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [generalError, setGeneralError] = useState<string | null>(null);

  // Extract token and immediately strip from address bar (Referer & history hygiene)
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
      setInvalidToken(true);
    } else {
      setToken(currentToken);
    }
    setTokenChecked(true);
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFieldErrors({});
    setGeneralError(null);

    if (!token) {
      setInvalidToken(true);
      return;
    }

    const errors: Record<string, string> = {};
    if (newPassword.length < 8) {
      errors.newPassword = t('passwordTooShort');
    } else if (newPassword.length > 128) {
      errors.newPassword = t('passwordTooLong');
    }

    if (newPassword !== confirmPassword) {
      errors.confirmPassword = t('passwordMismatch');
    }

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }

    setIsSubmitting(true);
    try {
      const res = await api.auth.POST('/v1/auth/password/reset', {
        body: {
          token,
          new_password: newPassword,
        },
      });

      if (res.response.status === 204) {
        // Clear all local/in-memory session state since server revoked every refresh family
        tokenStore.clear();
        clearSession();
        setIsSuccess(true);
      } else if (res.response.status === 400) {
        const problem = res.error as Problem | undefined;
        if (problem?.code === 'INVALID_TOKEN') {
          setInvalidToken(true);
        } else if (problem?.errors && problem.errors.length > 0) {
          const map: Record<string, string> = {};
          for (const err of problem.errors) {
            map[err.field === 'new_password' ? 'newPassword' : err.field] = err.message;
          }
          setFieldErrors(map);
        } else {
          setGeneralError(problem?.detail || problem?.title || 'Bad request');
        }
      } else if (res.response.status === 429) {
        const retryAfter = res.response.headers.get('Retry-After');
        if (retryAfter) {
          setGeneralError(`${t('rateLimited')} (${retryAfter}s)`);
        } else {
          setGeneralError(t('rateLimited'));
        }
      } else {
        const problem = res.error as Problem | undefined;
        setGeneralError(problem?.detail || problem?.title || 'An error occurred');
      }
    } catch {
      setGeneralError('Network error');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-[calc(100vh-140px)] items-center justify-center p-4">
      <meta name="referrer" content="no-referrer" />

      <div className="w-full max-w-md rounded-2xl border border-gray-200 dark:border-[#272727] bg-white dark:bg-[#141414] p-8 shadow-2xl">
        <div className="flex flex-col items-center gap-2 text-center mb-6">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-red-600 text-white shadow-lg">
            <PlaySquare className="h-7 w-7 fill-current" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white mt-2">
            {t('resetPasswordTitle')}
          </h1>
          <p className="text-xs text-gray-500 dark:text-gray-400">{t('resetPasswordDesc')}</p>
        </div>

        {generalError && (
          <div
            role="alert"
            className="mb-4 flex items-center gap-2 rounded-xl bg-red-500/10 border border-red-500/30 p-3 text-xs text-red-500"
          >
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{generalError}</span>
          </div>
        )}

        {tokenChecked && invalidToken ? (
          <div className="flex flex-col items-center gap-4 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-red-500/10 text-red-500 border border-red-500/20">
              <AlertCircle className="h-6 w-6" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-gray-900 dark:text-white">
                {t('invalidTokenTitle')}
              </h2>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                {t('invalidTokenMessage')}
              </p>
            </div>
            <Link
              href="/forgot-password"
              className="mt-2 flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-red-600 font-semibold text-sm text-white hover:bg-red-700 transition"
            >
              <span>{t('requestNewResetLink')}</span>
            </Link>
          </div>
        ) : isSuccess ? (
          <div className="flex flex-col items-center gap-4 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-500 border border-emerald-500/20">
              <CheckCircle2 className="h-6 w-6" />
            </div>
            <p className="text-sm font-medium text-gray-900 dark:text-white">
              {t('resetPasswordSuccess')}
            </p>
            <Link
              href="/login"
              className="mt-2 flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-red-600 font-semibold text-sm text-white hover:bg-red-700 transition"
            >
              <span>{t('submitLogin')}</span>
            </Link>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div>
              <label
                htmlFor="new-password"
                className="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1.5"
              >
                {t('newPassword')}
              </label>
              <input
                id="new-password"
                type="password"
                required
                minLength={8}
                maxLength={128}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="••••••••"
                className={`w-full h-11 rounded-xl border px-3.5 text-sm bg-gray-50 dark:bg-[#1e1e1e] text-gray-900 dark:text-white focus:outline-none focus:ring-2 ${
                  fieldErrors.newPassword
                    ? 'border-red-500 focus:ring-red-500'
                    : 'border-gray-300 dark:border-[#383838] focus:border-red-500 focus:ring-red-500'
                }`}
              />
              {fieldErrors.newPassword && (
                <p className="mt-1 text-xs text-red-500 font-medium">{fieldErrors.newPassword}</p>
              )}
            </div>

            <div>
              <label
                htmlFor="confirm-password"
                className="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1.5"
              >
                {t('confirmPassword')}
              </label>
              <input
                id="confirm-password"
                type="password"
                required
                minLength={8}
                maxLength={128}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="••••••••"
                className={`w-full h-11 rounded-xl border px-3.5 text-sm bg-gray-50 dark:bg-[#1e1e1e] text-gray-900 dark:text-white focus:outline-none focus:ring-2 ${
                  fieldErrors.confirmPassword
                    ? 'border-red-500 focus:ring-red-500'
                    : 'border-gray-300 dark:border-[#383838] focus:border-red-500 focus:ring-red-500'
                }`}
              />
              {fieldErrors.confirmPassword && (
                <p className="mt-1 text-xs text-red-500 font-medium">
                  {fieldErrors.confirmPassword}
                </p>
              )}
            </div>

            <button
              type="submit"
              disabled={isSubmitting || !tokenChecked}
              className="mt-2 flex h-11 w-full items-center justify-center rounded-xl bg-red-600 font-semibold text-sm text-white hover:bg-red-700 transition disabled:opacity-50"
            >
              {isSubmitting ? '...' : t('resetPasswordSubmit')}
            </button>

            <div className="mt-4 text-center">
              <Link
                href="/login"
                className="inline-flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400 hover:text-red-500 dark:hover:text-red-400 transition"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                <span>{t('backToLogin')}</span>
              </Link>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ResetPasswordForm />
    </Suspense>
  );
}
