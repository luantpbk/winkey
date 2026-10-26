'use client';

import React, { useState, useEffect } from 'react';
import { EyeOff, AlertCircle, X, Loader2 } from 'lucide-react';

interface HideVideoDialogProps {
  isOpen: boolean;
  videoTitle: string;
  onClose: () => void;
  onConfirm: (reason: string) => Promise<void> | void;
}

export function HideVideoDialog({ isOpen, videoTitle, onClose, onConfirm }: HideVideoDialogProps) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setReason('');
      setError(null);
      setIsSubmitting(false);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const trimmed = reason.trim();
  const isValid = trimmed.length >= 1 && trimmed.length <= 500;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValid) {
      setError('Lý do ẩn video phải từ 1 đến 500 ký tự.');
      return;
    }

    try {
      setIsSubmitting(true);
      setError(null);
      await onConfirm(trimmed);
      onClose();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Có lỗi xảy ra khi ẩn video.';
      setError(msg);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="hide-video-dialog-title"
      data-testid="hide-video-dialog"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-in fade-in duration-200"
    >
      <div className="relative w-full max-w-lg rounded-2xl border border-[#2e2e2e] bg-[#141414] p-6 shadow-2xl space-y-4">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-[#242424] pb-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-500/10 text-amber-500">
              <EyeOff className="h-5 w-5" />
            </div>
            <div>
              <h2 id="hide-video-dialog-title" className="text-base font-bold text-white">
                Ẩn video vi phạm
              </h2>
              <p className="text-xs text-gray-400 mt-0.5 line-clamp-1">{videoTitle}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Đóng hộp thoại"
            data-testid="hide-video-close-btn"
            className="rounded-lg p-1.5 text-gray-400 hover:bg-white/10 hover:text-white transition"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Content & Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="text-xs text-gray-300">
            Video sau khi ẩn sẽ không xuất hiện trên trang chủ, tìm kiếm và không ai có thể xem (trừ
            chủ sở hữu và người kiểm duyệt/admin).
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label htmlFor="hide-reason" className="text-xs font-semibold text-gray-200">
                Lý do ẩn video <span className="text-red-500">*</span>
              </label>
              <span
                className={`text-[11px] ${trimmed.length > 500 ? 'text-red-500' : 'text-gray-400'}`}
              >
                {trimmed.length}/500
              </span>
            </div>
            <textarea
              id="hide-reason"
              rows={3}
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
                if (error) setError(null);
              }}
              placeholder="Nhập lý do ẩn video (bắt buộc, ví dụ: Vi phạm bản quyền, nội dung nhạy cảm...)"
              data-testid="hide-video-reason-input"
              className="w-full rounded-xl border border-[#383838] bg-[#1a1a1a] p-3 text-xs text-white placeholder-gray-500 focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500 transition"
              maxLength={500}
              required
            />
          </div>

          {error && (
            <div
              data-testid="hide-video-error-msg"
              className="flex items-center gap-2 rounded-xl bg-red-500/10 border border-red-500/30 p-2.5 text-xs text-red-400"
            >
              <AlertCircle className="h-4 w-4 shrink-0 text-red-500" />
              <span>{error}</span>
            </div>
          )}

          {/* Action buttons */}
          <div className="flex items-center justify-end gap-2.5 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              data-testid="hide-video-cancel-btn"
              className="rounded-xl border border-[#383838] px-4 py-2.5 text-xs font-semibold text-gray-300 hover:bg-white/5 transition disabled:opacity-50"
            >
              Huỷ
            </button>
            <button
              type="submit"
              disabled={!isValid || isSubmitting}
              data-testid="hide-video-submit-btn"
              className="inline-flex items-center gap-1.5 rounded-xl bg-amber-600 hover:bg-amber-500 px-4 py-2.5 text-xs font-semibold text-white shadow-lg transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <span>Đang ẩn...</span>
                </>
              ) : (
                <>
                  <EyeOff className="h-3.5 w-3.5" />
                  <span>Ẩn video</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
