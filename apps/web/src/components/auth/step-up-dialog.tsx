'use client';

import React, { useState, useEffect } from 'react';
import { api } from '../../lib/api-client';
import type { SecuritySummary, StepUpRequest } from '@winkey/api-client';
import {
  isWebAuthnSupported,
  parseRequestOptions,
  serializeCredential,
} from '../../lib/auth/webauthn';
import {
  ShieldAlert,
  Key,
  Lock,
  Mail,
  Smartphone,
  AlertCircle,
  X,
  CheckCircle2,
} from 'lucide-react';

interface StepUpDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  securitySummary?: SecuritySummary | null;
}

type StepUpMethod = 'password' | 'totp' | 'passkey' | 'email_code';

export function StepUpDialog({ isOpen, onClose, onSuccess, securitySummary }: StepUpDialogProps) {
  const [selectedMethod, setSelectedMethod] = useState<StepUpMethod>('password');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [emailCodeSent, setEmailCodeSent] = useState(false);
  const [isSendingEmail, setIsSendingEmail] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Compute available methods based on account security summary
  const hasPassword = securitySummary?.has_password ?? true;
  const hasTotp = securitySummary?.totp_enabled ?? false;
  const hasPasskey = (securitySummary?.passkey_count ?? 0) > 0 && isWebAuthnSupported();

  useEffect(() => {
    if (isOpen) {
      setPassword('');
      setCode('');
      setEmailCodeSent(false);
      setErrorMessage(null);

      if (hasPassword) {
        setSelectedMethod('password');
      } else if (hasTotp) {
        setSelectedMethod('totp');
      } else if (hasPasskey) {
        setSelectedMethod('passkey');
      } else {
        setSelectedMethod('email_code');
      }
    }
  }, [isOpen, hasPassword, hasTotp, hasPasskey]);

  if (!isOpen) return null;

  const handleSendEmailCode = async () => {
    setIsSendingEmail(true);
    setErrorMessage(null);
    try {
      const { response, error } = await api.auth.POST('/v1/auth/me/step-up/email-code');
      if (response.status === 202 || response.ok) {
        setEmailCodeSent(true);
      } else {
        setErrorMessage(error?.detail || 'Không thể gửi mã xác nhận qua email. Vui lòng thử lại.');
      }
    } catch {
      setErrorMessage('Lỗi kết nối khi gửi email xác thực.');
    } finally {
      setIsSendingEmail(false);
    }
  };

  const handlePasskeyStepUp = async () => {
    setIsSubmitting(true);
    setErrorMessage(null);
    try {
      const {
        data: options,
        error: optError,
        response,
      } = await api.auth.POST('/v1/auth/passkeys/assertion-options', {
        body: { purpose: 'step_up' },
      });

      if (!response.ok || !options) {
        setErrorMessage(optError?.detail || 'Không thể lấy yêu cầu xác thực passkey.');
        setIsSubmitting(false);
        return;
      }

      const requestOptions = parseRequestOptions(options);
      const credential = await navigator.credentials.get(requestOptions);
      if (!credential) {
        setErrorMessage('Không nhận được thông tin xác thực từ thiết bị.');
        setIsSubmitting(false);
        return;
      }

      const serialized = serializeCredential(credential);
      const { response: stepUpRes, error: stepUpErr } = await api.auth.POST('/v1/auth/me/step-up', {
        body: {
          method: 'passkey',
          flow_id: options.flow_id,
          credential: serialized,
        },
      });

      if (stepUpRes.ok) {
        onSuccess();
        onClose();
      } else {
        setErrorMessage(stepUpErr?.detail || 'Xác thực passkey không thành công.');
      }
    } catch (err: unknown) {
      const errorObj = err as { name?: string; message?: string };
      if (errorObj?.name !== 'NotAllowedError') {
        setErrorMessage(errorObj?.message || 'Lỗi khi xác thực passkey.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedMethod === 'passkey') {
      await handlePasskeyStepUp();
      return;
    }

    setIsSubmitting(true);
    setErrorMessage(null);

    try {
      const body: StepUpRequest = { method: selectedMethod };
      if (selectedMethod === 'password') {
        body.password = password;
      } else if (selectedMethod === 'totp' || selectedMethod === 'email_code') {
        body.code = code.trim();
      }

      const { response, error } = await api.auth.POST('/v1/auth/me/step-up', {
        body,
      });

      if (response.ok) {
        onSuccess();
        onClose();
      } else {
        if (error?.code === 'STEP_UP_CODE_INVALID') {
          setErrorMessage('Mã xác thực không chính xác hoặc đã hết hạn.');
        } else if (error?.code === 'PASSWORD_INVALID') {
          setErrorMessage('Mật khẩu không chính xác.');
        } else {
          setErrorMessage(error?.detail || error?.title || 'Xác thực không thành công.');
        }
      }
    } catch {
      setErrorMessage('Lỗi kết nối máy chủ.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="step-up-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
    >
      <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl p-6 space-y-5">
        <div className="flex items-center justify-between pb-3 border-b border-slate-800">
          <div className="flex items-center gap-2.5">
            <div className="p-2 bg-amber-500/10 rounded-lg text-amber-500 border border-amber-500/20">
              <ShieldAlert className="w-5 h-5" />
            </div>
            <h2 id="step-up-title" className="text-lg font-bold text-white">
              Xác thực bảo mật nâng cao
            </h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Đóng"
            className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <p className="text-xs text-slate-400">
          Thao tác nhạy cảm này yêu cầu bạn xác nhận danh tính để bảo vệ an toàn cho tài khoản.
        </p>

        {errorMessage && (
          <div
            role="alert"
            className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg flex items-start gap-2.5 text-red-400 text-xs"
          >
            <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <span>{errorMessage}</span>
          </div>
        )}

        {/* Method selection tabs */}
        <div className="grid grid-cols-2 gap-2 text-xs">
          {hasPassword && (
            <button
              type="button"
              onClick={() => {
                setSelectedMethod('password');
                setErrorMessage(null);
              }}
              className={`p-2.5 rounded-lg border flex items-center justify-center gap-1.5 transition-colors font-medium ${
                selectedMethod === 'password'
                  ? 'bg-red-500/10 border-red-500/40 text-red-400'
                  : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
              }`}
            >
              <Lock className="w-3.5 h-3.5" />
              <span>Mật khẩu</span>
            </button>
          )}

          {hasTotp && (
            <button
              type="button"
              onClick={() => {
                setSelectedMethod('totp');
                setErrorMessage(null);
              }}
              className={`p-2.5 rounded-lg border flex items-center justify-center gap-1.5 transition-colors font-medium ${
                selectedMethod === 'totp'
                  ? 'bg-red-500/10 border-red-500/40 text-red-400'
                  : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
              }`}
            >
              <Smartphone className="w-3.5 h-3.5" />
              <span>Mã ứng dụng (TOTP)</span>
            </button>
          )}

          {hasPasskey && (
            <button
              type="button"
              onClick={() => {
                setSelectedMethod('passkey');
                setErrorMessage(null);
              }}
              className={`p-2.5 rounded-lg border flex items-center justify-center gap-1.5 transition-colors font-medium ${
                selectedMethod === 'passkey'
                  ? 'bg-red-500/10 border-red-500/40 text-red-400'
                  : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
              }`}
            >
              <Key className="w-3.5 h-3.5" />
              <span>Passkey</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => {
              setSelectedMethod('email_code');
              setErrorMessage(null);
            }}
            className={`p-2.5 rounded-lg border flex items-center justify-center gap-1.5 transition-colors font-medium ${
              selectedMethod === 'email_code'
                ? 'bg-red-500/10 border-red-500/40 text-red-400'
                : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
            }`}
          >
            <Mail className="w-3.5 h-3.5" />
            <span>Mã email</span>
          </button>
        </div>

        {/* Input depending on method */}
        <form onSubmit={handleSubmit} className="space-y-4">
          {selectedMethod === 'password' && (
            <div>
              <label
                htmlFor="step-up-pwd"
                className="block text-xs font-medium text-slate-300 mb-1.5"
              >
                Nhập mật khẩu hiện tại
              </label>
              <input
                id="step-up-pwd"
                type="password"
                required
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-sm text-white focus:outline-none focus:border-red-500"
              />
            </div>
          )}

          {selectedMethod === 'totp' && (
            <div>
              <label
                htmlFor="step-up-totp"
                className="block text-xs font-medium text-slate-300 mb-1.5"
              >
                Mã xác thực 6 chữ số từ ứng dụng
              </label>
              <input
                id="step-up-totp"
                type="text"
                maxLength={6}
                pattern="[0-9]*"
                inputMode="numeric"
                autoComplete="one-time-code"
                required
                autoFocus
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="000000"
                className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-center text-xl tracking-[0.4em] font-mono text-white focus:outline-none focus:border-red-500"
              />
            </div>
          )}

          {selectedMethod === 'email_code' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-400">Mã 6 chữ số gửi tới email của bạn</span>
                <button
                  type="button"
                  onClick={handleSendEmailCode}
                  disabled={isSendingEmail}
                  className="text-red-400 hover:text-red-300 font-medium underline underline-offset-2"
                >
                  {isSendingEmail
                    ? 'Đang gửi...'
                    : emailCodeSent
                      ? 'Gửi lại mã'
                      : 'Gửi mã về email'}
                </button>
              </div>
              {emailCodeSent && (
                <div className="text-emerald-400 text-xs flex items-center gap-1.5">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>Đã gửi mã xác nhận tới hộp thư của bạn.</span>
                </div>
              )}
              <input
                id="step-up-email-code"
                type="text"
                maxLength={6}
                pattern="[0-9]*"
                inputMode="numeric"
                required
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="000000"
                className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-center text-xl tracking-[0.4em] font-mono text-white focus:outline-none focus:border-red-500"
              />
            </div>
          )}

          {selectedMethod === 'passkey' && (
            <div className="py-2 text-center text-xs text-slate-400">
              Nhấn nút bên dưới để xác thực sinh trắc học hoặc mã PIN trên thiết bị của bạn.
            </div>
          )}

          <div className="flex items-center justify-end gap-2.5 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="px-4 py-2 text-xs font-medium text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition-colors"
            >
              Hủy
            </button>
            <button
              type="submit"
              disabled={
                isSubmitting ||
                (selectedMethod === 'password' && !password) ||
                (selectedMethod === 'totp' && code.length !== 6) ||
                (selectedMethod === 'email_code' && code.length !== 6)
              }
              className="px-4 py-2 bg-red-600 hover:bg-red-500 disabled:opacity-50 disabled:cursor-not-allowed text-xs font-medium text-white rounded-lg shadow transition-colors flex items-center gap-1.5"
            >
              {isSubmitting ? (
                <div className="w-3.5 h-3.5 border-2 border-white/20 border-t-white rounded-full animate-spin" />
              ) : selectedMethod === 'passkey' ? (
                'Xác thực bằng Passkey'
              ) : (
                'Xác nhận'
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
