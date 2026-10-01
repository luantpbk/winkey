'use client';

import React, { useState, Suspense } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { Link } from '../../../i18n/routing';
import { api } from '../../../lib/api-client';
import { PlaySquare, AlertCircle, CheckCircle2, ArrowLeft } from 'lucide-react';
import type { Problem } from '@winkey/api-client';

function ForgotPasswordForm() {
  const t = useTranslations('auth');
  const locale = useLocale();

  const [email, setEmail] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [generalError, setGeneralError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFieldErrors({});
    setGeneralError(null);

    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setFieldErrors({ email: t('email') + ' is required' });
      return;
    }

    setIsSubmitting(true);
    try {
      const res = await api.auth.POST('/v1/auth/password/forgot', {
        body: {
          email: trimmedEmail,
          locale: (locale === 'en' ? 'en' : 'vi') as 'en' | 'vi',
        },
      });

      if (res.response.status === 202) {
        setIsSuccess(true);
      } else if (res.response.status === 429) {
        const retryAfter = res.response.headers.get('Retry-After');
        if (retryAfter) {
          setGeneralError(`${t('rateLimited')} (${retryAfter}s)`);
        } else {
          setGeneralError(t('rateLimited'));
        }
      } else if (res.response.status === 400) {
        const problem = res.error as Problem | undefined;
        if (problem?.errors && problem.errors.length > 0) {
          const map: Record<string, string> = {};
          for (const err of problem.errors) {
            map[err.field] = err.message;
          }
          setFieldErrors(map);
        } else {
          setGeneralError(problem?.detail || problem?.title || 'Bad request');
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
      <div className="w-full max-w-md rounded-2xl border border-gray-200 dark:border-[#272727] bg-white dark:bg-[#141414] p-8 shadow-2xl">
        <div className="flex flex-col items-center gap-2 text-center mb-6">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-red-600 text-white shadow-lg">
            <PlaySquare className="h-7 w-7 fill-current" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white mt-2">
            {t('forgotPasswordTitle')}
          </h1>
          <p className="text-xs text-gray-500 dark:text-gray-400">{t('forgotPasswordDesc')}</p>
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

        {isSuccess ? (
          <div className="flex flex-col items-center gap-4 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-500 border border-emerald-500/20">
              <CheckCircle2 className="h-6 w-6" />
            </div>
            <p className="text-sm text-gray-700 dark:text-gray-300">{t('forgotPasswordSuccess')}</p>
            <Link
              href="/login"
              className="mt-2 flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-red-600 font-semibold text-sm text-white hover:bg-red-700 transition"
            >
              <ArrowLeft className="h-4 w-4" />
              <span>{t('backToLogin')}</span>
            </Link>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div>
              <label
                htmlFor="forgot-email"
                className="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1.5"
              >
                {t('email')}
              </label>
              <input
                id="forgot-email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@example.com"
                className={`w-full h-11 rounded-xl border px-3.5 text-sm bg-gray-50 dark:bg-[#1e1e1e] text-gray-900 dark:text-white focus:outline-none focus:ring-2 ${
                  fieldErrors.email
                    ? 'border-red-500 focus:ring-red-500'
                    : 'border-gray-300 dark:border-[#383838] focus:border-red-500 focus:ring-red-500'
                }`}
              />
              {fieldErrors.email && (
                <p className="mt-1 text-xs text-red-500 font-medium">{fieldErrors.email}</p>
              )}
            </div>

            <button
              type="submit"
              disabled={isSubmitting}
              className="mt-2 flex h-11 w-full items-center justify-center rounded-xl bg-red-600 font-semibold text-sm text-white hover:bg-red-700 transition disabled:opacity-50"
            >
              {isSubmitting ? '...' : t('forgotPasswordSubmit')}
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

export default function ForgotPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ForgotPasswordForm />
    </Suspense>
  );
}
