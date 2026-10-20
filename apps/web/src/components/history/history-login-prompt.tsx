'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { History, LogIn } from 'lucide-react';
import { Link } from '../../i18n/routing';

export function HistoryLoginPrompt() {
  const t = useTranslations('history');

  return (
    <div
      data-testid="history-login-prompt"
      className="flex flex-col items-center justify-center py-24 px-4 text-center max-w-md mx-auto"
    >
      <div className="flex h-20 w-20 items-center justify-center rounded-3xl bg-zinc-800/80 text-zinc-400 mb-6 border border-zinc-700/50 shadow-inner">
        <History className="h-10 w-10 text-red-500" />
      </div>
      <h2 className="text-xl sm:text-2xl font-bold text-white mb-2 tracking-tight">
        {t('loginTitle')}
      </h2>
      <p className="text-gray-400 text-sm sm:text-base leading-relaxed mb-8 max-w-sm">
        {t('loginDesc')}
      </p>
      <Link
        href="/login?return_to=/lich-su"
        data-testid="history-login-btn"
        className="inline-flex items-center gap-2.5 rounded-full bg-red-600 hover:bg-red-700 active:scale-95 px-6 py-3 text-sm font-semibold text-white shadow-lg transition-all focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 focus:ring-offset-black"
      >
        <LogIn className="h-4 w-4" />
        <span>{t('loginBtn')}</span>
      </Link>
    </div>
  );
}
