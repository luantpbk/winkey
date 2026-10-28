'use client';

import React, { useState } from 'react';
import QRCode from 'qrcode';
import { api } from '../../../lib/api-client';
import { Smartphone, Check, Copy, AlertCircle, Trash2, ArrowRight } from 'lucide-react';
import { RecoveryCodesModal } from './recovery-codes-modal';

interface TotpSectionProps {
  totpEnabled: boolean;
  onRefresh: () => void;
  onRequireStepUp: (onSuccessRetry: () => Promise<void>) => void;
}

export function TotpSection({ totpEnabled, onRefresh, onRequireStepUp }: TotpSectionProps) {
  const [isSettingUp, setIsSettingUp] = useState(false);
  const [setupData, setSetupData] = useState<{
    setup_id: string;
    secret: string;
    otpauth_uri: string;
  } | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [hasCopiedSecret, setHasCopiedSecret] = useState(false);

  // Recovery codes modal after setup
  const [newRecoveryCodes, setNewRecoveryCodes] = useState<string[] | null>(null);

  const handleStartSetup = async () => {
    setIsSubmitting(true);
    setErrorMessage(null);
    try {
      const { data, error, response } = await api.auth.POST('/v1/auth/me/totp');
      if (response.ok && data) {
        setSetupData(data);
        setIsSettingUp(true);
        // Render QR locally using qrcode library
        try {
          const url = await QRCode.toDataURL(data.otpauth_uri, {
            margin: 1,
            width: 220,
            color: {
              dark: '#000000',
              light: '#ffffff',
            },
          });
          setQrDataUrl(url);
        } catch (qrErr) {
          console.error('Failed to generate local QR code', qrErr);
        }
      } else {
        setErrorMessage(error?.detail || 'Không thể bắt đầu thiết lập TOTP.');
      }
    } catch {
      setErrorMessage('Lỗi kết nối khi khởi tạo TOTP.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleConfirmSetup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!setupData) return;

    setIsSubmitting(true);
    setErrorMessage(null);
    try {
      const { data, error, response } = await api.auth.POST('/v1/auth/me/totp/confirm', {
        body: {
          setup_id: setupData.setup_id,
          code: code.trim(),
        },
      });

      if (response.ok && data) {
        setIsSettingUp(false);
        setSetupData(null);
        setCode('');
        onRefresh();

        if (data.recovery_codes && data.recovery_codes.length > 0) {
          setNewRecoveryCodes(data.recovery_codes);
        }
      } else {
        setErrorMessage(
          error?.code === 'TOTP_CODE_INVALID'
            ? 'Mã xác thực 6 chữ số không chính xác. Hãy đảm bảo giờ trên điện thoại đồng bộ chính xác.'
            : error?.detail || 'Xác nhận mã TOTP không thành công.',
        );
      }
    } catch {
      setErrorMessage('Lỗi kết nối khi xác thực TOTP.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const executeDisableTotp = async () => {
    setIsSubmitting(true);
    setErrorMessage(null);
    try {
      const { response, error } = await api.auth.DELETE('/v1/auth/me/totp');
      if (response.status === 204 || response.ok) {
        onRefresh();
      } else if (response.status === 403 && error?.code === 'STEP_UP_REQUIRED') {
        onRequireStepUp(executeDisableTotp);
      } else {
        setErrorMessage(error?.detail || 'Không thể tắt TOTP.');
      }
    } catch {
      setErrorMessage('Lỗi kết nối khi tắt TOTP.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDisableTotp = () => {
    if (confirm('Bạn có chắc chắn muốn tắt xác thực qua ứng dụng (TOTP)?')) {
      executeDisableTotp();
    }
  };

  const handleCopySecret = async () => {
    if (!setupData?.secret) return;
    try {
      await navigator.clipboard.writeText(setupData.secret);
      setHasCopiedSecret(true);
      setTimeout(() => setHasCopiedSecret(false), 2000);
    } catch {
      // ignore
    }
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-800">
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-red-500/10 rounded-xl text-red-500 border border-red-500/20">
            <Smartphone className="w-6 h-6" />
          </div>
          <div>
            <h3 className="text-base font-bold text-white">Ứng dụng xác thực (TOTP)</h3>
            <p className="text-xs text-slate-400">
              Sử dụng các ứng dụng như Google Authenticator, Microsoft Authenticator, 1Password để
              tạo mã đăng nhập.
            </p>
          </div>
        </div>

        <div>
          {totpEnabled ? (
            <div className="flex items-center gap-3">
              <span className="px-2.5 py-1 bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 text-xs font-semibold rounded-full">
                Đang bật
              </span>
              <button
                type="button"
                onClick={handleDisableTotp}
                disabled={isSubmitting}
                className="px-3 py-1.5 bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/20 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Tắt TOTP</span>
              </button>
            </div>
          ) : (
            !isSettingUp && (
              <button
                type="button"
                onClick={handleStartSetup}
                disabled={isSubmitting}
                className="px-4 py-2 bg-red-600 hover:bg-red-500 text-white rounded-lg text-xs font-medium transition-colors shadow-lg shadow-red-600/20 flex items-center gap-2"
              >
                <span>Bật xác thực ứng dụng</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            )
          )}
        </div>
      </div>

      {errorMessage && (
        <div
          role="alert"
          className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg flex items-start gap-2.5 text-red-400 text-xs"
        >
          <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <span>{errorMessage}</span>
        </div>
      )}

      {isSettingUp && setupData && (
        <div className="pt-2 space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-center">
            {/* QR Code container */}
            <div className="flex flex-col items-center justify-center p-4 bg-slate-950 border border-slate-800 rounded-xl space-y-3">
              <span className="text-xs font-semibold text-slate-300">
                1. Quét mã QR bằng ứng dụng Authenticator
              </span>
              <div className="p-3 bg-white rounded-xl shadow-md">
                {qrDataUrl ? (
                  <img src={qrDataUrl} alt="Mã QR thiết lập TOTP" className="w-48 h-48 block" />
                ) : (
                  <div className="w-48 h-48 flex items-center justify-center text-slate-400 text-xs">
                    Đang tạo mã QR...
                  </div>
                )}
              </div>
              <span className="text-[11px] text-slate-500 text-center">
                Mã QR được tạo an toàn trực tiếp trên trình duyệt của bạn
              </span>
            </div>

            {/* Secret key & Confirmation */}
            <div className="space-y-4">
              <div>
                <span className="text-xs font-semibold text-slate-300 block mb-1.5">
                  2. Hoặc nhập mã khóa bí mật theo cách thủ công:
                </span>
                <div className="flex items-center gap-2 p-2.5 bg-slate-950 border border-slate-800 rounded-lg">
                  <span className="font-mono text-sm text-red-400 tracking-wider flex-1 truncate select-all">
                    {setupData.secret}
                  </span>
                  <button
                    type="button"
                    onClick={handleCopySecret}
                    className="p-1.5 hover:bg-slate-800 text-slate-400 hover:text-white rounded-md transition-colors"
                    title="Sao chép mã khóa"
                  >
                    {hasCopiedSecret ? (
                      <Check className="w-4 h-4 text-emerald-400" />
                    ) : (
                      <Copy className="w-4 h-4" />
                    )}
                  </button>
                </div>
              </div>

              <form onSubmit={handleConfirmSetup} className="space-y-3 pt-2">
                <div>
                  <label
                    htmlFor="totp-confirm-code"
                    className="block text-xs font-medium text-slate-300 mb-1"
                  >
                    3. Nhập mã 6 chữ số hiển thị trên ứng dụng:
                  </label>
                  <input
                    id="totp-confirm-code"
                    type="text"
                    maxLength={6}
                    pattern="[0-9]*"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    required
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    placeholder="000000"
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-center font-mono text-lg tracking-[0.4em] text-white focus:outline-none focus:border-red-500"
                  />
                </div>

                <div className="flex items-center gap-2 pt-2">
                  <button
                    type="submit"
                    disabled={isSubmitting || code.length !== 6}
                    className="flex-1 py-2.5 px-4 bg-red-600 hover:bg-red-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-semibold rounded-lg transition-colors shadow-lg shadow-red-600/20"
                  >
                    {isSubmitting ? 'Đang xác minh...' : 'Kích hoạt xác thực TOTP'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setIsSettingUp(false);
                      setSetupData(null);
                      setCode('');
                    }}
                    className="py-2.5 px-4 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium rounded-lg transition-colors"
                  >
                    Hủy
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}

      {/* Recovery Codes Modal shown once */}
      {newRecoveryCodes && (
        <RecoveryCodesModal
          isOpen={true}
          codes={newRecoveryCodes}
          onClose={() => setNewRecoveryCodes(null)}
          title="Mã khôi phục mới cho tài khoản"
        />
      )}
    </div>
  );
}
