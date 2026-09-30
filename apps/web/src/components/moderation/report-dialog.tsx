'use client';

import React, { useState, useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { X, AlertTriangle, CheckCircle, Flag } from 'lucide-react';
import type { ReportReason, ReportTargetType } from '@winkey/api-client';
import { api } from '../../lib/api-client';
import { useAuth } from '../../lib/auth/auth-context';
import { useRouter, usePathname } from '../../i18n/routing';
import { useSafeTimeout } from '../../lib/hooks/use-safe-timeout';

export interface ReportDialogProps {
  isOpen: boolean;
  onClose: () => void;
  targetType: ReportTargetType;
  targetId: string;
  targetTitle?: string;
}

const REPORT_REASONS: ReportReason[] = [
  'SPAM',
  'HARASSMENT',
  'HATE',
  'SEXUAL',
  'VIOLENCE',
  'COPYRIGHT',
  'MISINFORMATION',
  'OTHER',
];

export function ReportDialog({
  isOpen,
  onClose,
  targetType,
  targetId,
  targetTitle,
}: ReportDialogProps) {
  const safeTimeout = useSafeTimeout();
  const t = useTranslations('reports');
  const { isAuthenticated } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  const [selectedReason, setSelectedReason] = useState<ReportReason | null>(null);
  const [note, setNote] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [feedback, setFeedback] = useState<{
    type: 'success' | 'warning' | 'error';
    message: string;
  } | null>(null);

  const dialogRef = useRef<HTMLDivElement>(null);
  const initialFocusRef = useRef<HTMLButtonElement>(null);

  // Reset state when opening
  useEffect(() => {
    if (isOpen) {
      setSelectedReason(null);
      setNote('');
      setFeedback(null);
      setIsSubmitting(false);
      safeTimeout(() => {
        initialFocusRef.current?.focus();
      }, 50);
    }
  }, [isOpen]);

  // Handle ESC key to close
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!isAuthenticated) {
      router.push(`/login?returnTo=${encodeURIComponent(pathname)}`);
      return;
    }

    if (!selectedReason) {
      setFeedback({ type: 'warning', message: t('reasonRequired') });
      return;
    }

    setIsSubmitting(true);
    setFeedback(null);

    try {
      const { error, response } = await api.social.POST('/v1/reports', {
        body: {
          target_type: targetType,
          target_id: targetId,
          reason: selectedReason,
          note: note.trim(),
        },
      });

      if (response.status === 201) {
        setFeedback({ type: 'success', message: t('success') });
        safeTimeout(() => {
          onClose();
        }, 1800);
      } else if (response.status === 200 || response.status === 409) {
        setFeedback({ type: 'warning', message: t('alreadyReported') });
        safeTimeout(() => {
          onClose();
        }, 2500);
      } else if (response.status === 400) {
        setFeedback({ type: 'error', message: t('cannotReportSelf') });
      } else if (response.status === 429) {
        setFeedback({ type: 'error', message: t('rateLimited') });
      } else {
        const problem = error as { detail?: string } | undefined;
        setFeedback({
          type: 'error',
          message: problem?.detail || t('error'),
        });
      }
    } catch {
      setFeedback({ type: 'error', message: t('error') });
    } finally {
      setIsSubmitting(false);
    }
  };

  const getTitle = () => {
    switch (targetType) {
      case 'VIDEO':
        return t('titleVideo');
      case 'COMMENT':
        return t('titleComment');
      case 'USER':
        return t('titleUser');
      default:
        return t('reportAction');
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-fade-in"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="report-dialog-title"
        className="w-full max-w-md rounded-2xl border border-[#333] bg-[#1a1a1a] p-6 shadow-2xl text-gray-100 animate-scale-in"
      >
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-[#2e2e2e]">
          <div className="flex items-center gap-2 text-red-500">
            <Flag className="h-5 w-5" />
            <h2 id="report-dialog-title" className="text-lg font-bold text-white">
              {getTitle()}
            </h2>
          </div>
          <button
            ref={initialFocusRef}
            type="button"
            onClick={onClose}
            aria-label={t('cancel')}
            className="rounded-lg p-1 text-gray-400 hover:text-white hover:bg-[#2c2c2c] transition"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {targetTitle && (
          <p className="mt-3 text-xs text-gray-400 line-clamp-2 italic">
            &ldquo;{targetTitle}&rdquo;
          </p>
        )}

        {/* Feedback Alert */}
        {feedback && (
          <div
            className={`mt-4 flex items-start gap-2.5 rounded-xl p-3.5 text-xs font-medium ${
              feedback.type === 'success'
                ? 'bg-green-500/10 border border-green-500/30 text-green-400'
                : feedback.type === 'warning'
                  ? 'bg-yellow-500/10 border border-yellow-500/30 text-yellow-400'
                  : 'bg-red-500/10 border border-red-500/30 text-red-400'
            }`}
          >
            {feedback.type === 'success' ? (
              <CheckCircle className="h-4 w-4 shrink-0 text-green-400 mt-0.5" />
            ) : (
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            )}
            <span>{feedback.message}</span>
          </div>
        )}

        {/* Form */}
        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          <div>
            <label className="block text-xs font-semibold text-gray-300 mb-2">
              {t('selectReason')} <span className="text-red-500">*</span>
            </label>
            <div className="space-y-1.5 max-h-52 overflow-y-auto pr-1">
              {REPORT_REASONS.map((reason) => {
                const isSelected = selectedReason === reason;
                return (
                  <label
                    key={reason}
                    className={`flex items-center gap-2.5 p-2 rounded-xl border text-xs cursor-pointer transition ${
                      isSelected
                        ? 'border-red-500/80 bg-red-500/10 text-white font-medium'
                        : 'border-[#2d2d2d] bg-[#222] text-gray-300 hover:bg-[#272727]'
                    }`}
                  >
                    <input
                      type="radio"
                      name="reportReason"
                      value={reason}
                      checked={isSelected}
                      onChange={() => setSelectedReason(reason)}
                      className="h-3.5 w-3.5 text-red-600 focus:ring-red-500 border-gray-600 bg-gray-700"
                    />
                    <span>{t(`reasons.${reason}`)}</span>
                  </label>
                );
              })}
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label htmlFor="report-note" className="text-xs font-semibold text-gray-300">
                {t('optionalNote')}
              </label>
              <span className="text-[11px] text-gray-500">{note.length}/500</span>
            </div>
            <textarea
              id="report-note"
              rows={3}
              maxLength={500}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t('notePlaceholder')}
              className="w-full rounded-xl border border-[#333] bg-[#222] p-3 text-xs text-white placeholder-gray-500 focus:border-red-500 focus:outline-none focus:ring-1 focus:ring-red-500 resize-none"
            />
          </div>

          {/* Actions */}
          <div className="flex items-center justify-end gap-2.5 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="rounded-xl px-4 py-2 text-xs font-semibold text-gray-400 hover:text-white hover:bg-[#2c2c2c] transition"
            >
              {t('cancel')}
            </button>
            <button
              type="submit"
              disabled={isSubmitting || !selectedReason}
              className="flex items-center gap-1.5 rounded-xl bg-red-600 px-5 py-2 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition"
            >
              {isSubmitting ? (
                <>
                  <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white border-t-transparent" />
                  <span>{t('submitting')}</span>
                </>
              ) : (
                <span>{t('submit')}</span>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
