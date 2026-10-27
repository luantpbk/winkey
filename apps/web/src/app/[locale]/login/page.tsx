'use client';

import React, { useState, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Link, useRouter } from '../../../i18n/routing';
import { useAuth } from '../../../lib/auth/auth-context';
import { getSafeReturnTo } from '../../../lib/auth/return-to';
import { withOAuthReturnMarker } from '../../../lib/auth/session-indicator';
import { PlaySquare, AlertCircle, Key } from 'lucide-react';
import { A11Y_COLORS } from '../../../lib/a11y-tokens';
import {
  isWebAuthnSupported,
  parseRequestOptions,
  serializeCredential,
} from '../../../lib/auth/webauthn';
import { api } from '../../../lib/api-client';
import { TurnstileWidget } from '../../../components/auth/turnstile-widget';

function LoginForm() {
  const t = useTranslations('auth');
  const router = useRouter();
  const searchParams = useSearchParams();
  const returnTo = searchParams.get('return_to') || searchParams.get('returnTo');
  const errorParam = searchParams.get('error');
  const safeReturnTo = getSafeReturnTo(returnTo);
  const { login, passkeyLogin } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [turnstileToken, setTurnstileToken] = useState('');
  const [showTurnstile, setShowTurnstile] = useState(
    Boolean(process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY),
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isPasskeySubmitting, setIsPasskeySubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [generalError, setGeneralError] = useState<string | null>(null);
  const [supportsPasskey, setSupportsPasskey] = useState(false);

  useEffect(() => {
    setSupportsPasskey(isWebAuthnSupported());
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFieldErrors({});
    setGeneralError(null);
    setIsSubmitting(true);

    const res = await login({
      email,
      password,
      ...(turnstileToken ? { turnstile_token: turnstileToken } : {}),
    });
    setIsSubmitting(false);

    if (res.success) {
      router.push(safeReturnTo);
    } else if (res.mfaRequired) {
      const redirectUrl =
        '/login/2fa' + (safeReturnTo ? `?return_to=${encodeURIComponent(safeReturnTo)}` : '');
      router.push(redirectUrl);
    } else if (res.error) {
      if (res.error.code === 'CAPTCHA_REQUIRED') {
        setShowTurnstile(true);
        setGeneralError('Vui lòng hoàn thành xác thực bảo vệ Captcha để tiếp tục.');
      } else if (res.error.errors && res.error.errors.length > 0) {
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

  const handlePasskeyLogin = async () => {
    setGeneralError(null);
    setIsPasskeySubmitting(true);
    try {
      const {
        data: options,
        error: optError,
        response,
      } = await api.auth.POST('/v1/auth/passkeys/assertion-options', {
        body: { purpose: 'login' },
      });

      if (!response.ok || !options) {
        setGeneralError(optError?.detail || 'Không thể tạo yêu cầu xác thực passkey.');
        setIsPasskeySubmitting(false);
        return;
      }

      const requestOptions = parseRequestOptions(options);
      const credential = await navigator.credentials.get(requestOptions);
      if (!credential) {
        setGeneralError('Không nhận được thông tin xác thực từ thiết bị.');
        setIsPasskeySubmitting(false);
        return;
      }

      const serialized = serializeCredential(credential);
      const res = await passkeyLogin({
        flow_id: options.flow_id,
        credential: serialized,
      });
      if (res.success) {
        router.push(safeReturnTo);
      } else {
        setGeneralError(res.error?.detail || 'Đăng nhập bằng passkey thất bại.');
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Có lỗi khi xác thực passkey.';
      setGeneralError(msg);
    } finally {
      setIsPasskeySubmitting(false);
    }
  };

  return (
    <div className="flex min-h-[calc(100vh-140px)] items-center justify-center p-4">
      <div className="w-full max-w-md rounded-2xl border border-[#272727] dark:border-[#272727] border-gray-200 bg-[#141414] dark:bg-[#141414] bg-white p-8 shadow-2xl">
        <div className="flex flex-col items-center gap-2 text-center mb-6">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[#D9002B] text-white shadow-lg">
            <PlaySquare className="h-7 w-7 fill-current" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white mt-2">
            {t('loginTitle')}
          </h1>
          <p className={`text-xs ${A11Y_COLORS.textMuted}`}>
            Tiếp tục để trải nghiệm nội dung video độc quyền
          </p>
        </div>

        {errorParam === 'oauth_unavailable' && (
          <div
            role="alert"
            className="mb-4 flex items-center gap-2 rounded-xl bg-amber-500/10 border border-amber-500/30 p-3 text-xs text-amber-500"
          >
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{t('oauthUnavailable')}</span>
          </div>
        )}

        {errorParam === 'ACCOUNT_SUSPENDED' && (
          <div
            role="alert"
            className="mb-4 flex items-center gap-2 rounded-xl bg-red-500/10 border border-red-500/30 p-3 text-xs text-red-500"
          >
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{t('accountSuspended')}</span>
          </div>
        )}

        {(errorParam === 'session_expired' || errorParam === 'mfa_token_invalid') && (
          <div
            role="alert"
            className="mb-4 flex items-center gap-2 rounded-xl bg-amber-500/10 border border-amber-500/30 p-3 text-xs text-amber-500"
          >
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>Phiên xác thực đã hết hạn hoặc không hợp lệ. Vui lòng đăng nhập lại.</span>
          </div>
        )}

        {generalError && (
          <div
            role="alert"
            className="mb-4 flex items-center gap-2 rounded-xl bg-red-500/10 border border-red-500/30 p-3 text-xs text-red-500"
          >
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{generalError}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div>
            <label
              htmlFor="login-email"
              className="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1.5"
            >
              {t('email')}
            </label>
            <input
              id="login-email"
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
            <label
              htmlFor="login-password"
              className="block text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1.5"
            >
              {t('password')}
            </label>
            <input
              id="login-password"
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
            <div className="flex items-center justify-between mt-1">
              {fieldErrors.password ? (
                <p className={`text-xs ${A11Y_COLORS.brandText} font-medium`}>
                  {fieldErrors.password}
                </p>
              ) : (
                <span />
              )}
              <Link
                href="/forgot-password"
                className={`text-xs ${A11Y_COLORS.brandText} hover:underline`}
              >
                {t('forgotPasswordLink')}
              </Link>
            </div>
          </div>

          {showTurnstile && <TurnstileWidget onToken={(token) => setTurnstileToken(token)} />}

          <button
            type="submit"
            disabled={isSubmitting}
            className={`mt-2 flex h-11 w-full items-center justify-center rounded-xl ${A11Y_COLORS.brandSolidBg} font-semibold text-sm transition disabled:opacity-50`}
          >
            {isSubmitting ? 'Đang xử lý...' : t('submitLogin')}
          </button>
        </form>

        <div className="relative my-6">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-[#2e2e2e] dark:border-[#2e2e2e] border-gray-200" />
          </div>
          <div className="relative flex justify-center text-xs uppercase">
            <span
              className={`bg-[#141414] dark:bg-[#141414] bg-white px-2 ${A11Y_COLORS.textMuted}`}
            >
              Hoặc
            </span>
          </div>
        </div>

        <div className="flex flex-col gap-3">
          {/* Continue with Passkey */}
          {supportsPasskey && (
            <button
              type="button"
              data-testid="passkey-login-btn"
              onClick={handlePasskeyLogin}
              disabled={isPasskeySubmitting}
              className="flex h-11 w-full items-center justify-center gap-2.5 rounded-xl border border-[#383838] dark:border-[#383838] border-gray-300 bg-[#1e1e1e] dark:bg-[#1e1e1e] bg-gray-50 px-4 text-sm font-semibold text-gray-800 dark:text-gray-200 hover:bg-[#282828] dark:hover:bg-[#282828] hover:bg-gray-100 transition disabled:opacity-50"
            >
              <Key className="h-4 w-4 text-amber-500" />
              <span>
                {isPasskeySubmitting ? 'Đang xác thực passkey...' : 'Đăng nhập bằng passkey'}
              </span>
            </button>
          )}

          {/* Continue with Google */}
          <a
            href={`/v1/auth/oauth/google?return_to=${encodeURIComponent(withOAuthReturnMarker(safeReturnTo))}`}
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
        </div>

        <p className={`mt-6 text-center text-xs ${A11Y_COLORS.textMuted}`}>
          {t('noAccount')}{' '}
          <Link
            href="/register"
            className={`font-semibold ${A11Y_COLORS.brandText} hover:underline`}
          >
            {t('submitRegister')}
          </Link>
        </p>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
