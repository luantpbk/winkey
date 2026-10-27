'use client';

import React, { useState } from 'react';
import { UserX, AlertTriangle, X } from 'lucide-react';

export interface BlockConfirmDialogProps {
  isOpen: boolean;
  targetUser: { handle: string; display_name: string } | null;
  onClose: () => void;
  onConfirmBlock: () => Promise<void>;
}

export function BlockConfirmDialog({
  isOpen,
  targetUser,
  onClose,
  onConfirmBlock,
}: BlockConfirmDialogProps) {
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  if (!isOpen || !targetUser) return null;

  const handleConfirm = async () => {
    setIsSubmitting(true);
    setErrorMessage(null);
    try {
      await onConfirmBlock();
      onClose();
    } catch (err: any) {
      setErrorMessage(err?.message || 'Không thể chặn người dùng này. Vui lòng thử lại sau.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="block-dialog-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm"
    >
      <div className="relative w-full max-w-md bg-[#18181b] border border-red-500/30 rounded-2xl p-6 text-white shadow-2xl flex flex-col gap-5">
        {/* Header */}
        <div className="flex items-center justify-between pb-3 border-b border-zinc-800">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-red-500/10 text-red-500">
              <UserX className="w-5 h-5" />
            </div>
            <div>
              <h2 id="block-dialog-title" className="text-lg font-bold">
                Chặn {targetUser.display_name}
              </h2>
              <span className="text-xs text-zinc-400">@{targetUser.handle}</span>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Warning & Explanations */}
        <div className="space-y-3 text-xs sm:text-sm text-zinc-300">
          <p>Khi bạn chặn tài khoản này:</p>
          <ul className="list-disc list-inside space-y-1.5 text-zinc-400 pl-1">
            <li>Hai bên sẽ không thể theo dõi hoặc xem danh sách người theo dõi của nhau.</li>
            <li>
              Mọi lượt theo dõi và yêu cầu theo dõi hiện tại giữa hai bên sẽ bị huỷ bỏ ngay lập tức.
            </li>
            <li>Hai bên sẽ không thể bình luận trên video của nhau hoặc nhận thông báo từ nhau.</li>
            <li>Người này sẽ không được thông báo rằng họ đã bị chặn.</li>
          </ul>
        </div>

        {errorMessage && (
          <div className="flex items-center gap-2 p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-xs text-red-400">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>{errorMessage}</span>
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="px-4 py-2 rounded-xl text-sm font-medium text-zinc-300 hover:bg-zinc-800 transition"
          >
            Huỷ
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={isSubmitting}
            className="flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-semibold bg-red-600 hover:bg-red-700 text-white transition disabled:opacity-50"
          >
            {isSubmitting ? (
              <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
            ) : (
              <UserX className="w-4 h-4" />
            )}
            <span>Chặn người này</span>
          </button>
        </div>
      </div>
    </div>
  );
}
