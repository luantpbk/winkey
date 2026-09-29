'use client';

import React, { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Link, useRouter } from '../../../i18n/routing';
import { useAuth } from '../../../lib/auth/auth-context';
import { PlaySquare, AlertCircle } from 'lucide-react';

export default function LoginPage() {
  const t = useTranslations('auth');
  const router = useRouter();
  const { login } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [generalError, setGeneralError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFieldErrors({});
    setGeneralError(null);
    setIsSubmitting(true);

    const res = await login({ email, password });
    setIsSubmitting(false);

    if (res.success) {
      router.push('/');
    } else if (res.error) {
      if (res.error.errors && res.error.errors.length > 0) {
        const errorsMap: Record<string, string> = {};
        for (const err of res.error.errors) {
          errorsMap[err.field] = err.message;
        }
        setFieldErrors(errorsMap);
      } else {
        setGeneralError(res.error.detail || res.error.title || t('invalidCredentials'));
      }
    }
  };

  return (
    <div className="flex min-h-[calc(100vh-140px)] items-center justify-center p-4">
      <div className="w-full max-w-md rounded-2xl border border-[#272727] dark:border-[#272727] border-gray-200 bg-[#141414] dark:bg-[#141414] bg-white p-8 shadow-2xl">
        <div className="flex flex-col items-center gap-2 text-center mb-6">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-red-600 text-white shadow-lg">
            <PlaySquare className="h-7 w-7 fill-current" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white mt-2">{t('loginTitle')}</h1>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Tiếp tục để trải nghiệm nội dung video độc quyền
          </p>
        </div>

        {generalError && (
          <div className="mb-4 flex items-center gap-2 rounded-xl bg-red-500/10 border border-red-500/30 p-3 text-xs text-red-500">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{generalError}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div>
            <label className="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1.5">
              {t('email')}
            </label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@example.com"
              className={`w-full h-11 rounded-xl border px-3.5 text-sm bg-[#1e1e1e] dark:bg-[#1e1e1e] bg-gray-50 text-gray-900 dark:text-white focus:outline-none focus:ring-2 ${
                fieldErrors.email
                  ? 'border-red-500 focus:ring-red-500'
                  : 'border-[#383838] dark:border-[#383838] border-gray-300 focus:border-red-500 focus:ring-red-500'
              }`}
            />
            {fieldErrors.email && (
              <p className="mt-1 text-xs text-red-500 font-medium">{fieldErrors.email}</p>
            )}
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1.5">
              {t('password')}
            </label>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              className={`w-full h-11 rounded-xl border px-3.5 text-sm bg-[#1e1e1e] dark:bg-[#1e1e1e] bg-gray-50 text-gray-900 dark:text-white focus:outline-none focus:ring-2 ${
                fieldErrors.password
                  ? 'border-red-500 focus:ring-red-500'
                  : 'border-[#383838] dark:border-[#383838] border-gray-300 focus:border-red-500 focus:ring-red-500'
              }`}
            />
            {fieldErrors.password && (
              <p className="mt-1 text-xs text-red-500 font-medium">{fieldErrors.password}</p>
            )}
          </div>

          <button
            type="submit"
            disabled={isSubmitting}
            className="mt-2 flex h-11 w-full items-center justify-center rounded-xl bg-red-600 font-semibold text-sm text-white hover:bg-red-700 transition disabled:opacity-50"
          >
            {isSubmitting ? 'Đang xử lý...' : t('submitLogin')}
          </button>
        </form>

        <div className="relative my-6">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-[#2e2e2e] dark:border-[#2e2e2e] border-gray-200" />
          </div>
          <div className="relative flex justify-center text-xs uppercase">
            <span className="bg-[#141414] dark:bg-[#141414] bg-white px-2 text-gray-500">
              Hoặc
            </span>
          </div>
        </div>

        {/* Continue with Google */}
        <a
          href="/v1/auth/oauth/google?return_to=/"
          className="flex h-11 w-full items-center justify-center gap-3 rounded-xl border border-[#383838] dark:border-[#383838] border-gray-300 bg-[#1e1e1e] dark:bg-[#1e1e1e] bg-gray-50 px-4 text-sm font-semibold text-gray-800 dark:text-gray-200 hover:bg-[#282828] dark:hover:bg-[#282828] hover:bg-gray-100 transition"
        >
          <svg className="h-5 w-5" viewBox="0 0 24 24">
            <path
              fill="#4285F4"
              d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
            />
            <path
              fill="#34A853"
              d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
            />
            <path
              fill="#FBBC05"
              d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
            />
            <path
              fill="#EA4335"
              d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
            />
          </svg>
          <span>{t('continueGoogle')}</span>
        </a>

        <p className="mt-6 text-center text-xs text-gray-500 dark:text-gray-400">
          {t('noAccount')}{' '}
          <Link href="/register" className="font-semibold text-red-500 hover:underline">
            {t('submitRegister')}
          </Link>
        </p>
      </div>
    </div>
  );
}
