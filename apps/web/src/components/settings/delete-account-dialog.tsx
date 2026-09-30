'use client';

import React, { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '../../i18n/routing';
import type { User, DeleteMeRequest, Problem } from '@winkey/api-client';
import { api } from '../../lib/api-client';
import { useAuth } from '../../lib/auth/auth-context';
import { useToast } from '../ui/toast';
import { AlertTriangle, X } from 'lucide-react';

interface DeleteAccountDialogProps {
  user: User;
  isOpen: boolean;
  onClose: () => void;
}

export function DeleteAccountDialog({ user, isOpen, onClose }: DeleteAccountDialogProps) {
  const t = useTranslations('settings.account');
  const router = useRouter();
  const { clearSession } = useAuth();
  const { showToast } = useToast();

  const [confirmHandle, setConfirmHandle] = useState('');
  const [password, setPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [generalError, setGeneralError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setConfirmHandle('');
      setPassword('');
      setFieldErrors({});
      setGeneralError(null);
      setIsSubmitting(false);
    }
  }, [isOpen]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleMatches = confirmHandle.trim().toLowerCase() === user.handle.toLowerCase();
  const passwordValid = !user.has_password || password.length > 0;
  const canConfirm = handleMatches && passwordValid;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canConfirm) return;

    setFieldErrors({});
    setGeneralError(null);

    const payload: DeleteMeRequest = {
      confirm_handle: confirmHandle.trim(),
      ...(user.has_password ? { password } : {}),
    };

    setIsSubmitting(true);
    try {
      const res = await api.auth.DELETE('/v1/auth/me', {
        body: payload,
      });

      if (res.response.ok) {
        if (typeof window !== 'undefined') {
          sessionStorage.setItem('wk_deleting', '1');
        }
        clearSession();
        onClose();
        showToast({ title: t('dangerZone.success'), type: 'success' });
        router.push('/');
      } else {
        const error = res.error as Problem | undefined;
        if (res.response.status === 400 || error?.code === 'CONFIRMATION_MISMATCH') {
          setFieldErrors({ confirmHandle: t('errors.confirmationMismatch') });
        } else if (
          res.response.status === 403 ||
          error?.code === 'INVALID_CREDENTIALS' ||
          error?.code === 'FORBIDDEN'
        ) {
          setFieldErrors({ password: t('errors.invalidCredentials') });
        } else if (res.response.status === 409 || error?.code === 'LAST_ADMIN') {
          setGeneralError(t('errors.lastAdmin'));
        } else if (res.response.status === 429) {
          setGeneralError(t('errors.rateLimit'));
        } else {
          setGeneralError(error?.detail || error?.title || t('errors.generic'));
        }
      }
    } catch {
      setGeneralError(t('errors.generic'));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-in fade-in duration-200"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-account-title"
        className="w-full max-w-lg rounded-2xl border border-red-500/30 bg-zinc-950 p-6 shadow-2xl text-white animate-in zoom-in-95 duration-200"
      >
        <div className="flex items-center justify-between pb-4 border-b border-zinc-800">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-red-500/10 text-red-400">
              <AlertTriangle className="h-5 w-5" />
            </div>
            <h2 id="delete-account-title" className="text-lg font-bold text-white">
              {t('dangerZone.modalTitle')}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className="text-zinc-400 hover:text-white p-1 rounded-lg hover:bg-zinc-800 transition"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="mt-4 p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-xs text-red-300 leading-relaxed">
          {t('dangerZone.modalWarning')}
        </div>

        {generalError && (
          <div
            role="alert"
            aria-live="polite"
            className="mt-4 p-3 rounded-xl bg-red-500/20 border border-red-500/40 text-xs text-red-200"
          >
            {generalError}
          </div>
        )}

        <form onSubmit={handleSubmit} className="mt-5 flex flex-col gap-4">
          <div>
            <label
              htmlFor="confirmHandle"
              className="block text-xs font-semibold text-zinc-300 mb-1.5"
            >
              {t('dangerZone.confirmHandleInstruction', { handle: user.handle })}
            </label>
            <input
              id="confirmHandle"
              name="confirmHandle"
              type="text"
              autoFocus
              required
              value={confirmHandle}
              onChange={(e) => setConfirmHandle(e.target.value)}
              placeholder={t('dangerZone.confirmHandlePlaceholder')}
              className={`w-full h-10 rounded-xl border px-3.5 text-sm bg-zinc-900 text-white focus:outline-none focus:ring-2 ${
                fieldErrors.confirmHandle
                  ? 'border-red-500 focus:ring-red-500'
                  : 'border-zinc-700 focus:border-red-500 focus:ring-red-500'
              }`}
            />
            {fieldErrors.confirmHandle && (
              <p className="mt-1 text-xs text-red-400 font-medium">{fieldErrors.confirmHandle}</p>
            )}
          </div>

          {user.has_password && (
            <div>
              <label
                htmlFor="deletePassword"
                className="block text-xs font-semibold text-zinc-300 mb-1.5"
              >
                {t('dangerZone.passwordLabel')}
              </label>
              <input
                id="deletePassword"
                name="deletePassword"
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t('dangerZone.passwordPlaceholder')}
                className={`w-full h-10 rounded-xl border px-3.5 text-sm bg-zinc-900 text-white focus:outline-none focus:ring-2 ${
                  fieldErrors.password
                    ? 'border-red-500 focus:ring-red-500'
                    : 'border-zinc-700 focus:border-red-500 focus:ring-red-500'
                }`}
              />
              {fieldErrors.password && (
                <p className="mt-1 text-xs text-red-400 font-medium">{fieldErrors.password}</p>
              )}
            </div>
          )}

          <div className="mt-4 flex items-center justify-end gap-3 pt-4 border-t border-zinc-800">
            <button
              type="button"
              onClick={onClose}
              className="h-10 px-4 rounded-xl border border-zinc-700 text-sm font-semibold text-zinc-300 hover:bg-zinc-800 transition"
            >
              {t('dangerZone.cancel')}
            </button>
            <button
              type="submit"
              disabled={!canConfirm || isSubmitting}
              className="h-10 px-5 rounded-xl bg-red-600 text-sm font-semibold text-white hover:bg-red-700 transition disabled:opacity-40 disabled:cursor-not-allowed shadow-sm"
            >
              {isSubmitting ? t('dangerZone.deleting') : t('dangerZone.confirm')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
