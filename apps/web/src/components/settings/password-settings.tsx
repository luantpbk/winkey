'use client';

import React, { useState } from 'react';
import { useTranslations } from 'next-intl';
import type { User, ChangePasswordRequest, Problem } from '@winkey/api-client';
import { api } from '../../lib/api-client';
import { useAuth } from '../../lib/auth/auth-context';
import { useToast } from '../ui/toast';
import { KeyRound, AlertCircle } from 'lucide-react';

interface PasswordSettingsProps {
  user: User;
}

export function PasswordSettings({ user }: PasswordSettingsProps) {
  const t = useTranslations('settings.account');
  const { updateUser } = useAuth();
  const { showToast } = useToast();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [generalError, setGeneralError] = useState<string | null>(null);

  const hasPassword = user.has_password;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFieldErrors({});
    setGeneralError(null);

    // Client-side validation
    if (newPassword.length < 8 || newPassword.length > 128) {
      setFieldErrors({ newPassword: t('errors.passwordLength') });
      return;
    }

    if (newPassword !== confirmPassword) {
      setFieldErrors({ confirmPassword: t('errors.passwordMismatch') });
      return;
    }

    if (hasPassword && !currentPassword) {
      setFieldErrors({ currentPassword: t('errors.invalidCredentials') });
      return;
    }

    const payload: ChangePasswordRequest = {
      new_password: newPassword,
      ...(hasPassword ? { current_password: currentPassword } : {}),
    };

    setIsSubmitting(true);
    try {
      const res = await api.auth.PUT('/v1/auth/me/password', {
        body: payload,
      });

      if (res.response.ok) {
        setCurrentPassword('');
        setNewPassword('');
        setConfirmPassword('');
        if (!hasPassword) {
          updateUser({ ...user, has_password: true });
          showToast({ title: t('password.setSuccess'), type: 'success' });
        } else {
          showToast({ title: t('password.success'), type: 'success' });
        }
      } else {
        const error = res.error as Problem | undefined;
        if (
          res.response.status === 403 ||
          error?.code === 'INVALID_CREDENTIALS' ||
          error?.code === 'FORBIDDEN'
        ) {
          setFieldErrors({ currentPassword: t('errors.invalidCredentials') });
        } else if (res.response.status === 429) {
          setGeneralError(t('errors.rateLimit'));
        } else if (error?.errors && error.errors.length > 0) {
          const map: Record<string, string> = {};
          for (const fe of error.errors) {
            if (fe.field === 'current_password') {
              map.currentPassword = fe.message;
            } else if (fe.field === 'new_password') {
              map.newPassword = fe.message;
            } else {
              map[fe.field] = fe.message;
            }
          }
          setFieldErrors(map);
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
    <div className="rounded-2xl border border-zinc-200 dark:border-[#272727] bg-white dark:bg-[#141414] p-6 shadow-sm">
      <div className="flex items-center gap-3 mb-6 pb-4 border-b border-zinc-100 dark:border-[#202020]">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-zinc-100 dark:bg-[#1f1f1f] text-zinc-700 dark:text-zinc-200">
          <KeyRound className="h-5 w-5" />
        </div>
        <div>
          <h2 className="text-lg font-bold text-zinc-900 dark:text-white">
            {hasPassword ? t('password.title') : t('password.setTitle')}
          </h2>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            {hasPassword ? t('password.description') : t('password.setDescription')}
          </p>
        </div>
      </div>

      {generalError && (
        <div
          role="alert"
          aria-live="polite"
          className="mb-6 flex items-center gap-2 rounded-xl bg-red-500/10 border border-red-500/30 p-3 text-xs text-red-500"
        >
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{generalError}</span>
        </div>
      )}

      <form onSubmit={handleSubmit} className="flex flex-col gap-5 max-w-xl">
        {hasPassword && (
          <div>
            <label
              htmlFor="currentPassword"
              className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1.5"
            >
              {t('password.currentPassword')}
            </label>
            <input
              id="currentPassword"
              name="currentPassword"
              type="password"
              required
              autoComplete="current-password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              placeholder={t('password.currentPasswordPlaceholder')}
              className={`w-full h-10 rounded-xl border px-3.5 text-sm bg-zinc-50 dark:bg-[#1e1e1e] text-zinc-900 dark:text-white focus:outline-none focus:ring-2 ${
                fieldErrors.currentPassword
                  ? 'border-red-500 focus:ring-red-500'
                  : 'border-zinc-300 dark:border-[#383838] focus:border-red-500 focus:ring-red-500'
              }`}
            />
            {fieldErrors.currentPassword && (
              <p className="mt-1 text-xs text-red-500 font-medium">{fieldErrors.currentPassword}</p>
            )}
          </div>
        )}

        <div>
          <label
            htmlFor="newPassword"
            className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1.5"
          >
            {t('password.newPassword')}
          </label>
          <input
            id="newPassword"
            name="newPassword"
            type="password"
            required
            minLength={8}
            maxLength={128}
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder={t('password.newPasswordPlaceholder')}
            className={`w-full h-10 rounded-xl border px-3.5 text-sm bg-zinc-50 dark:bg-[#1e1e1e] text-zinc-900 dark:text-white focus:outline-none focus:ring-2 ${
              fieldErrors.newPassword
                ? 'border-red-500 focus:ring-red-500'
                : 'border-zinc-300 dark:border-[#383838] focus:border-red-500 focus:ring-red-500'
            }`}
          />
          {fieldErrors.newPassword && (
            <p className="mt-1 text-xs text-red-500 font-medium">{fieldErrors.newPassword}</p>
          )}
        </div>

        <div>
          <label
            htmlFor="confirmPassword"
            className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1.5"
          >
            {t('password.confirmPassword')}
          </label>
          <input
            id="confirmPassword"
            name="confirmPassword"
            type="password"
            required
            minLength={8}
            maxLength={128}
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            placeholder={t('password.confirmPasswordPlaceholder')}
            className={`w-full h-10 rounded-xl border px-3.5 text-sm bg-zinc-50 dark:bg-[#1e1e1e] text-zinc-900 dark:text-white focus:outline-none focus:ring-2 ${
              fieldErrors.confirmPassword
                ? 'border-red-500 focus:ring-red-500'
                : 'border-zinc-300 dark:border-[#383838] focus:border-red-500 focus:ring-red-500'
            }`}
          />
          {fieldErrors.confirmPassword && (
            <p className="mt-1 text-xs text-red-500 font-medium">{fieldErrors.confirmPassword}</p>
          )}
        </div>

        <div className="pt-2">
          <button
            type="submit"
            disabled={isSubmitting}
            className="flex h-10 px-5 items-center justify-center rounded-xl bg-red-600 font-semibold text-sm text-white hover:bg-red-700 transition disabled:opacity-50 shadow-sm"
          >
            {isSubmitting
              ? t('password.saving')
              : hasPassword
                ? t('password.save')
                : t('password.setSave')}
          </button>
        </div>
      </form>
    </div>
  );
}
