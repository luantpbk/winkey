'use client';

import React, { useState, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { Link, useRouter } from '../../../../i18n/routing';
import { useAuth } from '../../../../lib/auth/auth-context';
import { getPendingMfaChallenge, clearPendingMfaChallenge } from '../../../../lib/auth/mfa-state';
import { getSafeReturnTo } from '../../../../lib/auth/return-to';
import { PlaySquare, AlertCircle, ShieldCheck, Key } from 'lucide-react';
import {
  isWebAuthnSupported,
  parseRequestOptions,
  serializeCredential,
} from '../../../../lib/auth/webauthn';
import { api } from '../../../../lib/api-client';

function MfaForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const returnTo = searchParams.get('return_to') || searchParams.get('returnTo');
  const safeReturnTo = getSafeReturnTo(returnTo);
  const { completeMfaLogin } = useAuth();

  const [code, setCode] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isPasskeySubmitting, setIsPasskeySubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [supportsPasskey, setSupportsPasskey] = useState(false);
  const [availableMethods, setAvailableMethods] = useState<string[]>(['totp']);

  useEffect(() => {
    const challenge = getPendingMfaChallenge();
    // Google sign-in sets `wk_mfa` cookie, in which case there might not be an in-memory challenge
    const hasWkMfaCookie = typeof document !== 'undefined' && document.cookie.includes('wk_mfa=');

    if (!challenge && !hasWkMfaCookie) {
      router.replace('/login?error=session_expired');
      return;
    }

    if (challenge?.methods && challenge.methods.length > 0) {
      setAvailableMethods(challenge.methods);
    } else {
      // Default fallback when from cookie
      setAvailableMethods(['totp', 'recovery_code', 'passkey']);
    }

    setSupportsPasskey(isWebAuthnSupported());
  }, [router]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setIsSubmitting(true);

    const payload = useRecovery ? { recovery_code: recoveryCode.trim() } : { code: code.trim() };

    const res = await completeMfaLogin(payload);
    setIsSubmitting(false);

    if (res.success) {
      router.push(safeReturnTo);
    } else if (res.error) {
      if (res.error.code === 'MFA_CODE_INVALID') {
        setErrorMessage(
          useRecovery
            ? 'Mã khôi phục không đúng hoặc đã được sử dụng.'
            : 'Mã xác thực 6 chữ số không đúng hoặc đã hết hạn.',
        );
      } else if (res.error.code === 'MFA_TOKEN_INVALID') {
        clearPendingMfaChallenge();
        router.push('/login?error=mfa_token_invalid');
      } else {
        setErrorMessage(
          res.error.detail || res.error.title || 'Xác thực thất bại. Vui lòng thử lại.',
        );
      }
    }
  };

  const handlePasskeyLogin = async () => {
    setErrorMessage(null);
    setIsPasskeySubmitting(true);
    try {
      const challenge = getPendingMfaChallenge();
      const {
        data: options,
        error: optError,
        response,
      } = await api.auth.POST('/v1/auth/passkeys/assertion-options', {
        body: {
          purpose: 'mfa',
          ...(challenge?.mfa_token ? { mfa_token: challenge.mfa_token } : {}),
        },
      });

      if (!response.ok || !options) {
        setErrorMessage(optError?.detail || 'Không thể tạo yêu cầu xác thực passkey.');
        setIsPasskeySubmitting(false);
        return;
      }

      const requestOptions = parseRequestOptions(options);
      const credential = await navigator.credentials.get(requestOptions);
      if (!credential) {
        setErrorMessage('Không nhận được thông tin xác thực từ thiết bị.');
        setIsPasskeySubmitting(false);
        return;
      }

      const serialized = serializeCredential(credential);
      const res = await completeMfaLogin({ credential: serialized });
      setIsPasskeySubmitting(false);

      if (res.success) {
        router.push(safeReturnTo);
      } else if (res.error) {
        if (res.error.code === 'MFA_TOKEN_INVALID') {
          clearPendingMfaChallenge();
          router.push('/login?error=mfa_token_invalid');
        } else {
          setErrorMessage(res.error.detail || 'Xác thực passkey không thành công.');
        }
      }
    } catch (err: unknown) {
      setIsPasskeySubmitting(false);
      const errorObj = err as { name?: string; message?: string };
      if (errorObj?.name !== 'NotAllowedError') {
        setErrorMessage(errorObj?.message || 'Không thể đăng nhập bằng passkey.');
      }
    }
  };

  const hasPasskey = availableMethods.includes('passkey') && supportsPasskey;

  return (
    <div className="w-full max-w-md p-8 space-y-6 bg-slate-900 border border-slate-800 rounded-2xl shadow-xl">
      <div className="text-center space-y-2">
        <div className="flex justify-center">
          <div className="p-3 bg-red-500/10 rounded-2xl text-red-500 border border-red-500/20">
            <ShieldCheck className="w-8 h-8" />
          </div>
        </div>
        <h1 className="text-2xl font-bold tracking-tight text-white">Xác thực hai lớp (2FA)</h1>
        <p className="text-sm text-slate-400">
          {useRecovery
            ? 'Nhập một trong các mã khôi phục đã lưu khi bật xác thực.'
            : 'Nhập mã gồm 6 chữ số từ ứng dụng xác thực (Google Authenticator, Authy,...).'}
        </p>
      </div>

      {errorMessage && (
        <div
          role="alert"
          aria-live="polite"
          className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg flex items-start gap-3 text-red-400 text-sm"
        >
          <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
          <span>{errorMessage}</span>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        {!useRecovery ? (
          <div>
            <label htmlFor="2fa-code" className="block text-sm font-medium text-slate-300 mb-1">
              Mã xác thực
            </label>
            <input
              id="2fa-code"
              type="text"
              name="code"
              maxLength={6}
              pattern="[0-9]*"
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              autoFocus
              value={code}
              onChange={(e) => {
                const val = e.target.value.replace(/\D/g, '').slice(0, 6);
                setCode(val);
                if (errorMessage) setErrorMessage(null);
              }}
              placeholder="000000"
              className="w-full px-4 py-3 bg-slate-950 border border-slate-800 rounded-lg text-white text-center text-2xl tracking-[0.5em] font-mono focus:outline-none focus:border-red-500 transition-colors"
            />
          </div>
        ) : (
          <div>
            <label
              htmlFor="recovery-code"
              className="block text-sm font-medium text-slate-300 mb-1"
            >
              Mã khôi phục
            </label>
            <input
              id="recovery-code"
              type="text"
              name="recovery_code"
              required
              autoFocus
              value={recoveryCode}
              onChange={(e) => {
                setRecoveryCode(e.target.value);
                if (errorMessage) setErrorMessage(null);
              }}
              placeholder="xxxx-xxxx"
              className="w-full px-4 py-3 bg-slate-950 border border-slate-800 rounded-lg text-white font-mono text-center tracking-wider focus:outline-none focus:border-red-500 transition-colors"
            />
          </div>
        )}

        <button
          type="submit"
          disabled={
            isSubmitting ||
            (!useRecovery && code.length !== 6) ||
            (useRecovery && !recoveryCode.trim())
          }
          className="w-full py-3 px-4 bg-red-600 hover:bg-red-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium rounded-lg shadow-lg shadow-red-600/30 transition-all flex items-center justify-center gap-2"
        >
          {isSubmitting ? (
            <div className="w-5 h-5 border-2 border-white/20 border-t-white rounded-full animate-spin" />
          ) : (
            'Xác nhận'
          )}
        </button>
      </form>

      <div className="space-y-3 pt-2 text-center text-sm">
        {availableMethods.includes('recovery_code') && (
          <div>
            <button
              type="button"
              onClick={() => {
                setUseRecovery(!useRecovery);
                setErrorMessage(null);
              }}
              className="text-slate-400 hover:text-white transition-colors underline underline-offset-4"
            >
              {useRecovery ? 'Dùng mã xác thực 6 chữ số' : 'Dùng mã khôi phục'}
            </button>
          </div>
        )}

        {hasPasskey && (
          <div className="pt-2 border-t border-slate-800/80">
            <button
              type="button"
              onClick={handlePasskeyLogin}
              disabled={isPasskeySubmitting}
              className="w-full py-2.5 px-4 bg-slate-800/80 hover:bg-slate-700/80 text-white rounded-lg border border-slate-700 transition-colors flex items-center justify-center gap-2 font-medium"
            >
              {isPasskeySubmitting ? (
                <div className="w-4 h-4 border-2 border-white/20 border-t-white rounded-full animate-spin" />
              ) : (
                <>
                  <Key className="w-4 h-4 text-red-400" />
                  <span>Dùng passkey</span>
                </>
              )}
            </button>
          </div>
        )}

        <div className="pt-2">
          <Link
            href="/login"
            className="text-xs text-slate-500 hover:text-slate-400 transition-colors"
          >
            Quay lại trang đăng nhập
          </Link>
        </div>
      </div>
    </div>
  );
}

export default function TwoFactorLoginPage() {
  return (
    <div className="min-h-[80vh] flex flex-col items-center justify-center px-4 py-12">
      <div className="mb-8 flex items-center gap-2">
        <PlaySquare className="w-8 h-8 text-red-500" />
        <span className="text-2xl font-bold tracking-tight text-white">Winkey</span>
      </div>

      <Suspense
        fallback={
          <div className="w-full max-w-md p-8 bg-slate-900 border border-slate-800 rounded-2xl flex items-center justify-center">
            <div className="w-6 h-6 border-2 border-red-500/20 border-t-red-500 rounded-full animate-spin" />
          </div>
        }
      >
        <MfaForm />
      </Suspense>
    </div>
  );
}
