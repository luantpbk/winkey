'use client';

import React, { useState, useEffect, useRef, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Link, useRouter } from '../../../i18n/routing';
import { useAuth } from '../../../lib/auth/auth-context';
import type { RegisterRequest } from '@winkey/api-client';
import { PlaySquare, AlertCircle } from 'lucide-react';

function RegisterForm() {
  const t = useTranslations('auth');
  const router = useRouter();
  const searchParams = useSearchParams();
  const { register } = useAuth();

  const [displayName, setDisplayName] = useState('');
  const [handle, setHandle] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [generalError, setGeneralError] = useState<string | null>(null);

  const inviteInputRef = useRef<HTMLInputElement>(null);

  // Prefill invite code from ?invite= and handle ?error= from OAuth callback
  useEffect(() => {
    const inviteParam = searchParams.get('invite');
    if (inviteParam) {
      setInviteCode(inviteParam.slice(0, 64));
    }

    const errorParam = searchParams.get('error');
    if (errorParam === 'INVITE_REQUIRED') {
      setFieldErrors((prev) => ({ ...prev, invite_code: t('inviteRequired') }));
      inviteInputRef.current?.focus();
    } else if (errorParam === 'INVITE_INVALID') {
      setFieldErrors((prev) => ({ ...prev, invite_code: t('inviteInvalid') }));
      inviteInputRef.current?.focus();
    }
  }, [searchParams, t]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!agreed) return;

    setFieldErrors({});
    setGeneralError(null);
    setIsSubmitting(true);

    const trimmedInvite = inviteCode.trim();
    const payload: RegisterRequest = {
      email,
      password,
      handle,
      display_name: displayName,
      ...(trimmedInvite ? { invite_code: trimmedInvite } : {}),
    };

    const res = await register(payload);
    setIsSubmitting(false);

    if (res.success) {
      router.push('/');
    } else if (res.error) {
      if (res.error.code === 'INVITE_REQUIRED') {
        setFieldErrors({ invite_code: t('inviteRequired') });
        inviteInputRef.current?.focus();
      } else if (res.error.code === 'INVITE_INVALID') {
        setFieldErrors({ invite_code: t('inviteInvalid') });
        inviteInputRef.current?.focus();
      } else if (res.error.errors && res.error.errors.length > 0) {
        const errorsMap: Record<string, string> = {};
        for (const err of res.error.errors) {
          errorsMap[err.field] = err.message;
        }
        setFieldErrors(errorsMap);
        if (errorsMap.invite_code) {
          inviteInputRef.current?.focus();
        }
      } else {
        setGeneralError(res.error.detail || res.error.title || 'Đăng ký thất bại');
      }
    }
  };

  const trimmedInvite = inviteCode.trim();
  const googleHref =
    '/v1/auth/oauth/google?return_to=/' +
    (trimmedInvite ? `&invite_code=${encodeURIComponent(trimmedInvite)}` : '');

  return (
    <div className="flex min-h-[calc(100vh-140px)] items-center justify-center p-4">
      <div className="w-full max-w-md rounded-2xl border border-[#272727] dark:border-[#272727] border-gray-200 bg-[#141414] dark:bg-[#141414] bg-white p-8 shadow-2xl">
        <div className="flex flex-col items-center gap-2 text-center mb-6">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-red-600 text-white shadow-lg">
            <PlaySquare className="h-7 w-7 fill-current" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white mt-2">
            {t('registerTitle')}
          </h1>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Tạo kênh và bắt đầu đăng tải video của bạn
          </p>
        </div>

        {generalError && (
          <div className="mb-4 flex items-center gap-2 rounded-xl bg-red-500/10 border border-red-500/30 p-3 text-xs text-red-500">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{generalError}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="flex flex-col gap-3.5">
          {/* Display Name */}
          <div>
            <label className="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">
              {t('displayName')}
            </label>
            <input
              type="text"
              required
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Nguyễn Văn A"
              className={`w-full h-10 rounded-xl border px-3.5 text-sm bg-[#1e1e1e] dark:bg-[#1e1e1e] bg-gray-50 text-gray-900 dark:text-white focus:outline-none focus:ring-2 ${
                fieldErrors.display_name
                  ? 'border-red-500 focus:ring-red-500'
                  : 'border-[#383838] dark:border-[#383838] border-gray-300 focus:border-red-500 focus:ring-red-500'
              }`}
            />
            {fieldErrors.display_name && (
              <p className="mt-1 text-xs text-red-500 font-medium">{fieldErrors.display_name}</p>
            )}
          </div>

          {/* Handle */}
          <div>
            <label className="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">
              {t('handle')}
            </label>
            <input
              type="text"
              required
              pattern="^[A-Za-z0-9_.]{3,30}$"
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
              placeholder="nguyenvana (3-30 ký tự)"
              className={`w-full h-10 rounded-xl border px-3.5 text-sm bg-[#1e1e1e] dark:bg-[#1e1e1e] bg-gray-50 text-gray-900 dark:text-white focus:outline-none focus:ring-2 ${
                fieldErrors.handle
                  ? 'border-red-500 focus:ring-red-500'
                  : 'border-[#383838] dark:border-[#383838] border-gray-300 focus:border-red-500 focus:ring-red-500'
              }`}
            />
            {fieldErrors.handle && (
              <p className="mt-1 text-xs text-red-500 font-medium">{fieldErrors.handle}</p>
            )}
          </div>

          {/* Email */}
          <div>
            <label className="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">
              {t('email')}
            </label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@example.com"
              className={`w-full h-10 rounded-xl border px-3.5 text-sm bg-[#1e1e1e] dark:bg-[#1e1e1e] bg-gray-50 text-gray-900 dark:text-white focus:outline-none focus:ring-2 ${
                fieldErrors.email
                  ? 'border-red-500 focus:ring-red-500'
                  : 'border-[#383838] dark:border-[#383838] border-gray-300 focus:border-red-500 focus:ring-red-500'
              }`}
            />
            {fieldErrors.email && (
              <p className="mt-1 text-xs text-red-500 font-medium">{fieldErrors.email}</p>
            )}
          </div>

          {/* Password */}
          <div>
            <label className="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">
              {t('password')}
            </label>
            <input
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Tối thiểu 8 ký tự"
              className={`w-full h-10 rounded-xl border px-3.5 text-sm bg-[#1e1e1e] dark:bg-[#1e1e1e] bg-gray-50 text-gray-900 dark:text-white focus:outline-none focus:ring-2 ${
                fieldErrors.password
                  ? 'border-red-500 focus:ring-red-500'
                  : 'border-[#383838] dark:border-[#383838] border-gray-300 focus:border-red-500 focus:ring-red-500'
              }`}
            />
            {fieldErrors.password && (
              <p className="mt-1 text-xs text-red-500 font-medium">{fieldErrors.password}</p>
            )}
          </div>

          {/* Invite Code (ADR-034: closed beta invite) */}
          <div>
            <label
              htmlFor="invite-code-input"
              className="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1"
            >
              {t('inviteCode')}
            </label>
            <input
              id="invite-code-input"
              ref={inviteInputRef}
              type="text"
              maxLength={64}
              value={inviteCode}
              onChange={(e) => setInviteCode(e.target.value)}
              placeholder={t('invitePlaceholder')}
              className={`w-full h-10 rounded-xl border px-3.5 text-sm bg-[#1e1e1e] dark:bg-[#1e1e1e] bg-gray-50 text-gray-900 dark:text-white focus:outline-none focus:ring-2 ${
                fieldErrors.invite_code
                  ? 'border-red-500 focus:ring-red-500'
                  : 'border-[#383838] dark:border-[#383838] border-gray-300 focus:border-red-500 focus:ring-red-500'
              }`}
            />
            {fieldErrors.invite_code && (
              <p data-testid="invite-error-msg" className="mt-1 text-xs text-red-500 font-medium">
                {fieldErrors.invite_code}
              </p>
            )}
          </div>

          {/* Required legal agreement checkbox (client-only) */}
          <div className="flex items-start gap-2.5 pt-1">
            <input
              id="terms-agreement-checkbox"
              data-testid="terms-agreement-checkbox"
              type="checkbox"
              checked={agreed}
              onChange={(e) => setAgreed(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-gray-300 dark:border-gray-600 text-red-600 focus:ring-red-500 cursor-pointer shrink-0"
            />
            <label
              htmlFor="terms-agreement-checkbox"
              className="text-xs text-gray-600 dark:text-gray-400 leading-normal select-none cursor-pointer"
            >
              {t('agreeTermsPrefix')}
              <Link
                href="/dieu-khoan"
                target="_blank"
                rel="noopener noreferrer"
                className="text-red-500 hover:underline font-medium"
              >
                {t('agreeTermsOfService')}
              </Link>
              {t('agreeAnd')}
              <Link
                href="/quyen-rieng-tu"
                target="_blank"
                rel="noopener noreferrer"
                className="text-red-500 hover:underline font-medium"
              >
                {t('agreePrivacyPolicy')}
              </Link>
            </label>
          </div>

          {/* Submit button: gated by agreement checkbox */}
          <button
            type="submit"
            disabled={isSubmitting || !agreed}
            data-testid="register-submit-btn"
            className="mt-2 flex h-11 w-full items-center justify-center rounded-xl bg-red-600 font-semibold text-sm text-white hover:bg-red-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSubmitting ? 'Đang tạo tài khoản...' : t('submitRegister')}
          </button>
        </form>

        <div className="relative my-5">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-[#2e2e2e] dark:border-[#2e2e2e] border-gray-200" />
          </div>
          <div className="relative flex justify-center text-xs uppercase">
            <span className="bg-[#141414] dark:bg-[#141414] bg-white px-2 text-gray-500">Hoặc</span>
          </div>
        </div>

        {/* Continue with Google: gated by agreement checkbox & carries invite_code */}
        <a
          href={agreed ? googleHref : undefined}
          data-testid="google-oauth-btn"
          aria-disabled={!agreed}
          onClick={(e) => {
            if (!agreed) {
              e.preventDefault();
            }
          }}
          className={`flex h-11 w-full items-center justify-center gap-3 rounded-xl border border-[#383838] dark:border-[#383838] border-gray-300 bg-[#1e1e1e] dark:bg-[#1e1e1e] bg-gray-50 px-4 text-sm font-semibold text-gray-800 dark:text-gray-200 transition ${
            !agreed
              ? 'opacity-50 cursor-not-allowed pointer-events-none'
              : 'hover:bg-[#282828] dark:hover:bg-[#282828] hover:bg-gray-100'
          }`}
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

        <p className="mt-5 text-center text-xs text-gray-500 dark:text-gray-400">
          {t('haveAccount')}{' '}
          <Link href="/login" className="font-semibold text-red-500 hover:underline">
            {t('submitLogin')}
          </Link>
        </p>
      </div>
    </div>
  );
}

export default function RegisterPage() {
  return (
    <Suspense fallback={null}>
      <RegisterForm />
    </Suspense>
  );
}
