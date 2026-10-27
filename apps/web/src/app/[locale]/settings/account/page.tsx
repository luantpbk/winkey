'use client';

import React, { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { Link, useRouter } from '../../../../i18n/routing';
import { useAuth } from '../../../../lib/auth/auth-context';
import { ProfileSettings } from '../../../../components/settings/profile-settings';
import { PasswordSettings } from '../../../../components/settings/password-settings';
import { TvModeSettings } from '../../../../components/settings/tv-mode-settings';
import { DangerZone } from '../../../../components/settings/danger-zone';
import { Settings, ShieldCheck, ArrowRight } from 'lucide-react';

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

        {/* Security & 2FA */}
        <div className="bg-white dark:bg-[#181818] border border-zinc-200 dark:border-[#272727] rounded-2xl p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-3 bg-red-500/10 rounded-xl text-red-500">
              <ShieldCheck className="w-6 h-6" />
            </div>
            <div>
              <h2 className="text-base font-bold text-zinc-900 dark:text-white">
                Bảo mật tài khoản & Xác thực hai lớp (2FA)
              </h2>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                Thiết lập ứng dụng xác thực TOTP, khóa Passkey, mã khôi phục và quản lý các thiết bị
                đã đăng nhập.
              </p>
            </div>
          </div>
          <Link
            href="/cai-dat/bao-mat"
            className="px-4 py-2 bg-red-600 hover:bg-red-500 text-white rounded-lg text-xs font-semibold transition-colors flex items-center justify-center gap-2 shrink-0"
          >
            <span>Cài đặt bảo mật</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        </div>

        <TvModeSettings />
        <DangerZone user={user} />
      </div>
    </div>
  );
}
