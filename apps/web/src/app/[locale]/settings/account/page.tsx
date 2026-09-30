'use client';

import React, { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '../../../../i18n/routing';
import { useAuth } from '../../../../lib/auth/auth-context';
import { ProfileSettings } from '../../../../components/settings/profile-settings';
import { PasswordSettings } from '../../../../components/settings/password-settings';
import { DangerZone } from '../../../../components/settings/danger-zone';
import { Settings } from 'lucide-react';

export default function AccountSettingsPage() {
  const t = useTranslations('settings.account');
  const router = useRouter();
  const { user, isAuthenticated, isLoading } = useAuth();

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      if (typeof window !== 'undefined' && sessionStorage.getItem('wk_deleting')) {
        sessionStorage.removeItem('wk_deleting');
        return;
      }
      router.push('/login?return_to=/settings/account');
    }
  }, [isLoading, isAuthenticated, router]);

  if (isLoading || !isAuthenticated || !user) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-red-500 border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
      {/* Page Header */}
      <div className="flex items-center gap-3 pb-6 border-b border-zinc-200 dark:border-[#272727]">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-red-500/10 text-red-500">
          <Settings className="h-6 w-6" />
        </div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-white">
            {t('title')}
          </h1>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">{t('description')}</p>
        </div>
      </div>

      {/* Sections */}
      <div className="space-y-8">
        <ProfileSettings user={user} />
        <PasswordSettings user={user} />
        <DangerZone user={user} />
      </div>
    </div>
  );
}
