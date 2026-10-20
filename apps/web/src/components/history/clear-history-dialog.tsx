'use client';

import React, { useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Trash2, X } from 'lucide-react';

export interface ClearHistoryDialogProps {
  isOpen: boolean;
  isClearing: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

export function ClearHistoryDialog({
  isOpen,
  isClearing,
  onClose,
  onConfirm,
}: ClearHistoryDialogProps) {
  const t = useTranslations('history');
  const confirmBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    // Autofocus confirm button for accessibility
    const timer = setTimeout(() => confirmBtnRef.current?.focus(), 50);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      clearTimeout(timer);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="clear-history-title"
      data-testid="clear-history-dialog"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200"
      onClick={(e) => {
        if (e.target === e.currentTarget && !isClearing) {
          onClose();
        }
      }}
    >
      <div className="relative w-full max-w-md rounded-2xl bg-[#1f1f1f] border border-[#2e2e2e] p-6 shadow-2xl text-white">
        {/* Close X Button */}
        <button
          type="button"
          onClick={onClose}
          disabled={isClearing}
          aria-label={t('cancel')}
          className="absolute top-4 right-4 text-gray-400 hover:text-white transition-colors rounded-lg p-1.5 focus:outline-none focus:ring-2 focus:ring-red-500 disabled:opacity-50"
        >
          <X className="h-5 w-5" />
        </button>

        {/* Warning Icon & Heading */}
        <div className="flex items-start gap-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-red-500/10 text-red-500">
            <AlertTriangle className="h-6 w-6" />
          </div>
          <div className="flex-1 pr-4">
            <h2 id="clear-history-title" className="text-lg font-bold text-white">
              {t('clearConfirmTitle')}
            </h2>
            <p className="mt-2 text-sm text-gray-400 leading-relaxed">{t('clearConfirmDesc')}</p>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="mt-6 flex flex-col-reverse sm:flex-row sm:justify-end gap-3">
          <button
            type="button"
            data-testid="cancel-clear-history-btn"
            onClick={onClose}
            disabled={isClearing}
            className="w-full sm:w-auto px-4 py-2.5 rounded-full text-sm font-semibold text-gray-300 hover:bg-[#2e2e2e] transition focus:outline-none focus:ring-2 focus:ring-gray-400 disabled:opacity-50"
          >
            {t('cancel')}
          </button>
          <button
            ref={confirmBtnRef}
            type="button"
            data-testid="confirm-clear-history-btn"
            onClick={onConfirm}
            disabled={isClearing}
            className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-full text-sm font-semibold text-white bg-red-600 hover:bg-red-700 transition shadow-lg focus:outline-none focus:ring-2 focus:ring-red-500 disabled:opacity-50"
          >
            <Trash2 className="h-4 w-4" />
            <span>{isClearing ? t('loading') : t('clearConfirmBtn')}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
