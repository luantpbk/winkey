'use client';

import React, { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import type { User, UpdateMeRequest, Problem } from '@winkey/api-client';
import { api } from '../../lib/api-client';
import { useAuth } from '../../lib/auth/auth-context';
import { useToast } from '../ui/toast';
import { UserCheck, AlertCircle } from 'lucide-react';

interface ProfileSettingsProps {
  user: User;
}

export function ProfileSettings({ user }: ProfileSettingsProps) {
  const t = useTranslations('settings.account');
  const { updateUser } = useAuth();
  const { showToast } = useToast();

  const [displayName, setDisplayName] = useState(user.display_name);
  const [handle, setHandle] = useState(user.handle);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [generalError, setGeneralError] = useState<string | null>(null);

  useEffect(() => {
    setDisplayName(user.display_name);
    setHandle(user.handle);
  }, [user.display_name, user.handle]);

  const isDirty = displayName.trim() !== user.display_name || handle.trim() !== user.handle;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFieldErrors({});
    setGeneralError(null);

    const trimmedDisplayName = displayName.trim();
    const trimmedHandle = handle.trim();

    if (!trimmedDisplayName || trimmedDisplayName.length > 50) {
      setFieldErrors({ displayName: t('errors.displayNameRequired') });
      return;
    }

    const handleRegex = /^[A-Za-z0-9_.]{3,30}$/;
    if (!handleRegex.test(trimmedHandle)) {
      setFieldErrors({ handle: t('errors.invalidHandle') });
      return;
    }

    const payload: UpdateMeRequest = {};
    if (trimmedDisplayName !== user.display_name) {
      payload.display_name = trimmedDisplayName;
    }
    if (trimmedHandle !== user.handle) {
      payload.handle = trimmedHandle;
    }

    if (Object.keys(payload).length === 0) {
      showToast({ title: t('profile.noChanges'), type: 'info' });
      return;
    }

    setIsSubmitting(true);
    try {
      const res = await api.auth.PATCH('/v1/auth/me', {
        body: payload,
      });

      if (res.response.ok && res.data) {
        updateUser(res.data);
        showToast({ title: t('profile.success'), type: 'success' });
      } else {
        const error = res.error as Problem | undefined;
        if (res.response.status === 409 || error?.code === 'HANDLE_TAKEN') {
          setFieldErrors({ handle: t('errors.handleTaken') });
        } else if (res.response.status === 429) {
          setGeneralError(t('errors.tooManyChanges'));
        } else if (error?.errors && error.errors.length > 0) {
          const map: Record<string, string> = {};
          for (const fe of error.errors) {
            map[fe.field] = fe.message;
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
          <UserCheck className="h-5 w-5" />
        </div>
        <div>
          <h2 className="text-lg font-bold text-zinc-900 dark:text-white">{t('profile.title')}</h2>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('profile.description')}</p>
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
        <div>
          <label
            htmlFor="displayName"
            className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1.5"
          >
            {t('profile.displayName')}
          </label>
          <input
            id="displayName"
            name="displayName"
            type="text"
            required
            maxLength={50}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder={t('profile.displayNamePlaceholder')}
            className={`w-full h-10 rounded-xl border px-3.5 text-sm bg-zinc-50 dark:bg-[#1e1e1e] text-zinc-900 dark:text-white focus:outline-none focus:ring-2 ${
              fieldErrors.displayName
                ? 'border-red-500 focus:ring-red-500'
                : 'border-zinc-300 dark:border-[#383838] focus:border-red-500 focus:ring-red-500'
            }`}
          />
          {fieldErrors.displayName && (
            <p className="mt-1 text-xs text-red-500 font-medium">{fieldErrors.displayName}</p>
          )}
        </div>

        <div>
          <label
            htmlFor="handle"
            className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1.5"
          >
            {t('profile.handle')}
          </label>
          <div className="relative">
            <span className="absolute left-3.5 top-2.5 text-sm text-zinc-400 select-none">@</span>
            <input
              id="handle"
              name="handle"
              type="text"
              required
              minLength={3}
              maxLength={30}
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
              placeholder={t('profile.handlePlaceholder')}
              className={`w-full h-10 rounded-xl border pl-8 pr-3.5 text-sm bg-zinc-50 dark:bg-[#1e1e1e] text-zinc-900 dark:text-white focus:outline-none focus:ring-2 ${
                fieldErrors.handle
                  ? 'border-red-500 focus:ring-red-500'
                  : 'border-zinc-300 dark:border-[#383838] focus:border-red-500 focus:ring-red-500'
              }`}
            />
          </div>
          {fieldErrors.handle ? (
            <p className="mt-1 text-xs text-red-500 font-medium">{fieldErrors.handle}</p>
          ) : (
            <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
              {t('profile.handleHelp')}
            </p>
          )}
        </div>

        <div>
          <label
            htmlFor="email"
            className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1.5"
          >
            {t('profile.email')}
          </label>
          <input
            id="email"
            type="email"
            disabled
            value={user.email}
            className="w-full h-10 rounded-xl border border-zinc-200 dark:border-[#2a2a2a] bg-zinc-100 dark:bg-[#181818] px-3.5 text-sm text-zinc-500 dark:text-zinc-400 cursor-not-allowed"
          />
          <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
            {t('profile.emailHelp')}
          </p>
        </div>

        <div className="pt-2">
          <button
            type="submit"
            disabled={!isDirty || isSubmitting}
            className="flex h-10 px-5 items-center justify-center rounded-xl bg-red-600 font-semibold text-sm text-white hover:bg-red-700 transition disabled:opacity-40 disabled:cursor-not-allowed shadow-sm"
          >
            {isSubmitting ? t('profile.saving') : t('profile.save')}
          </button>
        </div>
      </form>
    </div>
  );
}
