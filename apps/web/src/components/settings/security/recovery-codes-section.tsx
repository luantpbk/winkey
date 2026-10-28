'use client';

import React, { useState } from 'react';
import { api } from '../../../lib/api-client';
import { ShieldAlert, RefreshCw, AlertCircle, Lock } from 'lucide-react';
import { RecoveryCodesModal } from './recovery-codes-modal';

interface RecoveryCodesSectionProps {
  remainingCount: number;
  onRefresh: () => void;
  onRequireStepUp: (onSuccessRetry: () => Promise<void>) => void;
}

export function RecoveryCodesSection({
  remainingCount,
  onRefresh,
  onRequireStepUp,
}: RecoveryCodesSectionProps) {
  const [isGenerating, setIsGenerating] = useState(false);
  const [newCodes, setNewCodes] = useState<string[] | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const executeRegenerate = async () => {
    setIsGenerating(true);
    setErrorMessage(null);
    try {
      const { data, error, response } = await api.auth.POST('/v1/auth/me/recovery-codes');

      if (response.ok && data) {
        setNewCodes(data.recovery_codes);
        onRefresh();
      } else if (response.status === 403 && error?.code === 'STEP_UP_REQUIRED') {
        onRequireStepUp(executeRegenerate);
      } else {
        setErrorMessage(error?.detail || 'Không thể tạo mã khôi phục mới.');
      }
    } catch {
      setErrorMessage('Lỗi kết nối máy chủ.');
    } finally {
      setIsGenerating(false);
    }
  };

  const handleRegenerate = () => {
    if (
      confirm(
        'Tạo mã mới sẽ vô hiệu hóa toàn bộ các mã khôi phục hiện tại của bạn. Bạn có chắc chắn muốn tiếp tục?',
      )
    ) {
      executeRegenerate();
    }
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-800">
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-amber-500/10 rounded-xl text-amber-500 border border-amber-500/20">
            <Lock className="w-6 h-6" />
          </div>
          <div>
            <h3 className="text-base font-bold text-white">Mã khôi phục (Recovery Codes)</h3>
            <p className="text-xs text-slate-400">
              Sử dụng khi bạn mất điện thoại hoặc không thể truy cập ứng dụng tạo mã xác thực.
            </p>
          </div>
        </div>

        <div>
          <button
            type="button"
            onClick={handleRegenerate}
            disabled={isGenerating}
            className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-lg text-xs font-medium border border-slate-700 transition-colors flex items-center gap-2"
          >
            {isGenerating ? (
              <div className="w-4 h-4 border-2 border-white/20 border-t-white rounded-full animate-spin" />
            ) : (
              <RefreshCw className="w-4 h-4 text-amber-400" />
            )}
            <span>Tạo mã mới</span>
          </button>
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

      <div className="flex flex-col sm:flex-row sm:items-center justify-between p-4 bg-slate-950 border border-slate-800 rounded-xl gap-3">
        <div>
          <span className="text-sm font-semibold text-white block">
            {remainingCount > 0
              ? `Bạn còn ${remainingCount} mã khôi phục chưa sử dụng`
              : 'Bạn chưa có mã khôi phục hoặc đã sử dụng hết'}
          </span>
          <span className="text-xs text-slate-400">
            {remainingCount <= 2 && remainingCount > 0
              ? 'Số lượng mã còn lại rất ít. Bạn nên tạo bộ mã mới để phòng ngừa rủi ro mất quyền truy cập.'
              : 'Mỗi mã chỉ được sử dụng duy nhất một lần.'}
          </span>
        </div>

        {remainingCount <= 2 && (
          <span className="self-start sm:self-center px-2.5 py-1 bg-amber-500/15 border border-amber-500/30 text-amber-400 text-xs font-semibold rounded-full flex items-center gap-1.5">
            <ShieldAlert className="w-3.5 h-3.5" />
            <span>Sắp hết mã</span>
          </span>
        )}
      </div>

      {newCodes && (
        <RecoveryCodesModal
          isOpen={true}
          codes={newCodes}
          onClose={() => setNewCodes(null)}
          title="Bộ mã khôi phục mới"
        />
      )}
    </div>
  );
}
