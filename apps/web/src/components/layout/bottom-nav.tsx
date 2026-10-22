'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { Link, usePathname } from '../../i18n/routing';
import { Home, Compass, History, FolderHeart, UploadCloud } from 'lucide-react';
import { useAuth } from '../../lib/auth/auth-context';
import { computePermissions } from '../../lib/auth';

export function BottomNav() {
  const t = useTranslations('nav');
  const pathname = usePathname();
  const { can: rawCan, user, isAuthenticated } = useAuth();
  const can = rawCan ?? computePermissions(user, isAuthenticated);

  const navItems = [
    {
      href: '/',
      label: t('home'),
      icon: Home,
      isActive: pathname === '/' || pathname === '',
    },
    {
      href: '/kham-pha',
      label: t('explore'),
      icon: Compass,
      isActive: pathname.startsWith('/kham-pha'),
    },
    {
      href: '/lich-su',
      label: t('history'),
      icon: History,
      isActive: pathname.startsWith('/lich-su'),
    },
    can.upload
      ? {
          href: '/upload',
          label: t('upload'),
          icon: UploadCloud,
          isActive: pathname.startsWith('/upload'),
        }
      : {
          href: '/thu-vien',
          label: t('library'),
          icon: FolderHeart,
          isActive: pathname.startsWith('/thu-vien'),
        },
  ];

  return (
    <nav
      aria-label="Điều hướng chính trên di động"
      data-testid="mobile-bottom-nav"
      className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-[#0f0f0f]/95 dark:bg-[#0f0f0f]/95 bg-white/95 backdrop-blur border-t border-gray-200 dark:border-zinc-800 transition-colors"
      style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
    >
      <div className="flex items-center justify-around h-14">
        {navItems.map((item) => {
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex flex-col items-center justify-center flex-1 min-h-11 min-w-11 py-1 text-[11px] font-medium transition-colors ${
                item.isActive
                  ? 'text-[#d9002b] dark:text-[#d9002b] font-semibold'
                  : 'text-gray-600 dark:text-zinc-400 hover:text-gray-900 dark:hover:text-white'
              }`}
            >
              <Icon className="h-5 w-5 mb-0.5" />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
