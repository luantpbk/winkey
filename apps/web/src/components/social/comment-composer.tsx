'use client';

import React, { useState, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { useAuth } from '../../lib/auth/auth-context';
import { useRouter, usePathname } from '../../i18n/routing';

export interface CommentComposerProps {
  placeholder?: string;
  submitLabel?: string;
  initialValue?: string;
  isReply?: boolean;
  autoFocus?: boolean;
  onCancel?: () => void;
  onSubmit: (text: string) => Promise<{ success: boolean; error?: string }>;
}

export function CommentComposer({
  placeholder,
  submitLabel,
  initialValue = '',
  isReply = false,
  autoFocus = false,
  onCancel,
  onSubmit,
}: CommentComposerProps) {
  const t = useTranslations('social');
  const router = useRouter();
  const pathname = usePathname();
  const { user, isAuthenticated } = useAuth();

  const [text, setText] = useState<string>(initialValue);
  const [isPending, setIsPending] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const trimmedText = text.trim();
  const isValidLength = trimmedText.length >= 1 && text.length <= 2000;
  const isOverLimit = text.length > 2000;

  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();

    if (!isAuthenticated) {
      router.push(`/login?returnTo=${encodeURIComponent(pathname)}`);
      return;
    }

    if (!isValidLength || isPending) return;

    setIsPending(true);
    setErrorMessage(null);

    try {
      const res = await onSubmit(trimmedText);
      if (res.success) {
        setText('');
        // Return focus to textarea after successful submission
        setTimeout(() => {
          textareaRef.current?.focus();
        }, 50);
      } else if (res.error) {
        setErrorMessage(res.error);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Đã có lỗi xảy ra. Vui lòng thử lại.';
      setErrorMessage(msg);
    } finally {
      setIsPending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Ctrl+Enter or Cmd+Enter to submit
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      void handleSubmit();
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex gap-3 w-full">
      {/* User avatar or placeholder */}
      {!isReply && (
        <div className="shrink-0">
          {user?.avatar_url ? (
            <img
              src={user.avatar_url}
              alt={user.display_name}
              className="h-10 w-10 rounded-full object-cover"
            />
          ) : (
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-red-600 font-bold text-white text-sm">
              {user ? user.display_name.charAt(0) : '?'}
            </div>
          )}
        </div>
      )}

      <div className="flex flex-col flex-1 min-w-0">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (errorMessage) setErrorMessage(null);
          }}
          onKeyDown={handleKeyDown}
          autoFocus={autoFocus}
          rows={isReply ? 2 : 3}
          maxLength={2100}
          placeholder={
            placeholder || (isReply ? t('replyPlaceholder') : t('addCommentPlaceholder'))
          }
          aria-label={placeholder || t('addCommentPlaceholder')}
          className="w-full rounded-xl bg-[#1e1e1e] dark:bg-[#1e1e1e] bg-gray-50 border border-[#333] dark:border-[#333] border-gray-300 p-3 text-sm text-gray-900 dark:text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-red-600 resize-none transition"
        />

        {/* Character counter & Errors */}
        <div className="flex items-center justify-between mt-1 px-1">
          <div>
            {errorMessage && (
              <span className="text-xs text-red-500 font-medium">{errorMessage}</span>
            )}
          </div>
          <div
            className={`text-xs ${
              isOverLimit
                ? 'text-red-500 font-bold'
                : text.length > 1800
                  ? 'text-amber-500'
                  : 'text-gray-500 dark:text-gray-400'
            }`}
          >
            {t('charCount', { current: text.length, max: 2000 })}
          </div>
        </div>

        {/* Actions bar */}
        <div className="flex items-center justify-end gap-2 mt-2">
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              disabled={isPending}
              className="rounded-full px-4 py-1.5 text-xs font-semibold text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-[#333] transition"
            >
              {t('cancel')}
            </button>
          )}

          <button
            type="submit"
            disabled={!isValidLength || isPending}
            className={`rounded-full px-5 py-1.5 text-xs font-semibold transition active:scale-95 ${
              !isValidLength || isPending
                ? 'bg-gray-300 dark:bg-gray-800 text-gray-500 cursor-not-allowed'
                : 'bg-red-600 text-white hover:bg-red-700'
            }`}
          >
            {isPending
              ? t('loading')
              : submitLabel || (isReply ? t('replySubmit') : t('commentSubmit'))}
          </button>
        </div>
      </div>
    </form>
  );
}
