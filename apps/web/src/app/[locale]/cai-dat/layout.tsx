'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { Settings, ShieldCheck } from 'lucide-react';
import { Link, usePathname } from '../../../i18n/routing';

const TABS = [
  { href: '/cai-dat/tai-khoan', key: 'account', icon: Settings },
  { href: '/cai-dat/bao-mat', key: 'security', icon: ShieldCheck },
] as const;

/** One settings area with Vietnamese URLs and shared tabs (#554). Each page keeps its own heading. */
export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const t = useTranslations('settings.tabs');
  const pathname = usePathname();

  return (
    <>
      <nav
        aria-label={t('label')}
        className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 pt-6 flex gap-1 border-b border-zinc-200 dark:border-[#272727]"
      >
        {TABS.map(({ href, key, icon: Icon }) => {
          const active = pathname === href;
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? 'page' : undefined}
              className={`-mb-px inline-flex min-h-11 items-center gap-2 border-b-2 px-3 text-sm font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 rounded-t-lg ${
                active
                  ? 'border-red-600 text-zinc-900 dark:text-white'
                  : 'border-transparent text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white'
              }`}
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
              {t(key)}
            </Link>
          );
        })}
      </nav>
      {children}
    </>
  );
}
