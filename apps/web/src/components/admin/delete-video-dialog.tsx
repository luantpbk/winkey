'use client';

import React, { useState, useEffect } from 'react';
import { Trash2, AlertTriangle, X, Loader2 } from 'lucide-react';

interface DeleteVideoDialogProps {
  isOpen: boolean;
  videoTitle: string;
  onClose: () => void;
  onConfirm: () => Promise<void> | void;
}

export function DeleteVideoDialog({
  isOpen,
  videoTitle,
  onClose,
  onConfirm,
}: DeleteVideoDialogProps) {
  const [confirmText, setConfirmText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setConfirmText('');
      setError(null);
      setIsSubmitting(false);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const isConfirmed = confirmText.trim() === 'XOÁ';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isConfirmed) {
      setError('Vui lòng gõ chính xác chữ "XOÁ" để xác nhận.');
      return;
    }

    try {
      setIsSubmitting(true);
      setError(null);
      await onConfirm();
      onClose();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Có lỗi xảy ra khi xoá video.';
      setError(msg);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-video-dialog-title"
      data-testid="delete-video-dialog"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-in fade-in duration-200"
    >
      <div className="relative w-full max-w-md rounded-2xl border border-red-900/50 bg-[#141414] p-6 shadow-2xl space-y-4">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-[#242424] pb-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-red-500/10 text-red-500">
              <Trash2 className="h-5 w-5" />
            </div>
            <div>
              <h2 id="delete-video-dialog-title" className="text-base font-bold text-white">
                Xoá vĩnh viễn video
              </h2>
              <p className="text-xs text-gray-400 mt-0.5 line-clamp-1">{videoTitle}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Đóng hộp thoại"
            data-testid="delete-video-close-btn"
            className="rounded-lg p-1.5 text-gray-400 hover:bg-white/10 hover:text-white transition"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Warning Banner */}
        <div className="flex items-start gap-2.5 rounded-xl bg-red-950/40 border border-red-800/40 p-3 text-xs text-red-300">
          <AlertTriangle className="h-4 w-4 shrink-0 text-red-400 mt-0.5" />
          <div>
            <span className="font-bold">Cảnh báo: </span>
            <span>
              Hành động này không thể hoàn tác. Toàn bộ tệp video và dữ liệu liên quan sẽ bị xoá
              vĩnh viễn.
            </span>
          </div>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="confirm-delete-text"
              className="block text-xs font-semibold text-gray-300 mb-1.5"
            >
              Gõ <strong className="text-red-400 font-mono tracking-wider">XOÁ</strong> để xác nhận:
            </label>
            <input
              id="confirm-delete-text"
              type="text"
              value={confirmText}
              onChange={(e) => {
                setConfirmText(e.target.value);
                if (error) setError(null);
              }}
              placeholder="XOÁ"
              autoComplete="off"
              data-testid="confirm-delete-input"
              className="w-full rounded-xl border border-[#383838] bg-[#1a1a1a] px-3.5 py-2.5 text-xs text-white placeholder-gray-600 focus:border-red-500 focus:outline-none focus:ring-1 focus:ring-red-500 font-mono transition"
              required
            />
          </div>

          {error && (
            <div
              data-testid="delete-video-error-msg"
              className="rounded-xl bg-red-500/10 border border-red-500/30 p-2.5 text-xs text-red-400"
            >
              {error}
            </div>
          )}

          {/* Action buttons */}
          <div className="flex items-center justify-end gap-2.5 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              data-testid="delete-video-cancel-btn"
              className="rounded-xl border border-[#383838] px-4 py-2.5 text-xs font-semibold text-gray-300 hover:bg-white/5 transition disabled:opacity-50"
            >
              Huỷ
            </button>
            <button
              type="submit"
              disabled={!isConfirmed || isSubmitting}
              data-testid="confirm-delete-submit-btn"
              className="inline-flex items-center gap-1.5 rounded-xl bg-red-600 hover:bg-red-700 px-4 py-2.5 text-xs font-semibold text-white shadow-lg transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <span>Đang xoá...</span>
                </>
              ) : (
                <>
                  <Trash2 className="h-3.5 w-3.5" />
                  <span>Xoá vĩnh viễn</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
