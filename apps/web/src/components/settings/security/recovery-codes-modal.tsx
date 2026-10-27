'use client';

import React, { useState } from 'react';
import { Copy, Download, Check, AlertTriangle, ShieldCheck } from 'lucide-react';

interface RecoveryCodesModalProps {
  isOpen: boolean;
  codes: string[];
  onClose: () => void;
  title?: string;
}

export function RecoveryCodesModal({
  isOpen,
  codes,
  onClose,
  title = 'Mã khôi phục dự phòng',
}: RecoveryCodesModalProps) {
  const [hasCopied, setHasCopied] = useState(false);
  const [confirmedSaved, setConfirmedSaved] = useState(false);

  if (!isOpen || !codes || codes.length === 0) return null;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(codes.join('\n'));
      setHasCopied(true);
      setTimeout(() => setHasCopied(false), 2500);
    } catch {
      // ignore
    }
  };

  const handleDownload = () => {
    const textContent = `MÃ KHÔI PHỤC WINKEY\nNgày tạo: ${new Date().toLocaleString('vi-VN')}\n\n${codes.join(
      '\n',
    )}\n\nLưu ý: Mỗi mã chỉ dùng được 1 lần để đăng nhập khi bạn mất thiết bị 2FA hoặc Passkey.`;
    const blob = new Blob([textContent], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'winkey-recovery-codes.txt';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="recovery-codes-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm"
    >
      <div className="w-full max-w-lg bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl p-6 space-y-5">
        <div className="flex items-center gap-3 pb-3 border-b border-slate-800">
          <div className="p-2.5 bg-amber-500/10 rounded-xl text-amber-500 border border-amber-500/20">
            <ShieldCheck className="w-6 h-6" />
          </div>
          <div>
            <h2 id="recovery-codes-title" className="text-lg font-bold text-white">
              {title}
            </h2>
            <p className="text-xs text-slate-400">
              Lưu giữ các mã này cẩn thận để có thể khôi phục quyền truy cập.
            </p>
          </div>
        </div>

        <div
          role="alert"
          className="p-3 bg-amber-500/10 border border-amber-500/20 rounded-xl flex items-start gap-2.5 text-amber-400 text-xs"
        >
          <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <div>
            <span className="font-semibold">Quan trọng: </span>
            Các mã này chỉ hiển thị duy nhất MỘT LẦN. Sau khi đóng cửa sổ này, bạn sẽ không thể xem
            lại.
          </div>
        </div>

        {/* 10 codes in 2 columns */}
        <div className="p-4 bg-slate-950 border border-slate-800 rounded-xl grid grid-cols-2 gap-2 text-center">
          {codes.map((c, i) => (
            <div
              key={i}
              className="py-1.5 px-2 bg-slate-900/60 rounded text-slate-200 font-mono text-sm tracking-wider border border-slate-800/80 select-all"
            >
              {c}
            </div>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={handleCopy}
            className="flex-1 py-2 px-3 bg-slate-800 hover:bg-slate-700 text-white rounded-lg border border-slate-700 text-xs font-medium flex items-center justify-center gap-2 transition-colors"
          >
            {hasCopied ? (
              <>
                <Check className="w-4 h-4 text-emerald-400" />
                <span>Đã sao chép</span>
              </>
            ) : (
              <>
                <Copy className="w-4 h-4 text-slate-300" />
                <span>Sao chép tất cả</span>
              </>
            )}
          </button>

          <button
            type="button"
            onClick={handleDownload}
            className="flex-1 py-2 px-3 bg-slate-800 hover:bg-slate-700 text-white rounded-lg border border-slate-700 text-xs font-medium flex items-center justify-center gap-2 transition-colors"
          >
            <Download className="w-4 h-4 text-slate-300" />
            <span>Tải xuống .txt</span>
          </button>
        </div>

        <div className="pt-2 border-t border-slate-800">
          <label className="flex items-start gap-3 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={confirmedSaved}
              onChange={(e) => setConfirmedSaved(e.target.checked)}
              className="mt-0.5 rounded border-slate-700 bg-slate-950 text-red-600 focus:ring-red-500 w-4 h-4"
            />
            <span className="text-xs text-slate-300">
              Tôi đã sao chép hoặc lưu trữ các mã khôi phục này ở một nơi an toàn.
            </span>
          </label>
        </div>

        <div className="flex justify-end pt-2">
          <button
            type="button"
            disabled={!confirmedSaved}
            onClick={() => {
              setConfirmedSaved(false);
              onClose();
            }}
            className="w-full sm:w-auto px-5 py-2.5 bg-red-600 hover:bg-red-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-medium text-xs rounded-lg transition-colors shadow-lg shadow-red-600/20"
          >
            Tôi đã lưu & Đóng
          </button>
        </div>
      </div>
    </div>
  );
}
