'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { Link, usePathname } from '../../i18n/routing';
import {
  Home,
  Clapperboard,
  LayoutDashboard,
  UploadCloud,
  Tv,
  FolderHeart,
  History,
  Flame,
  Music2,
  Gamepad2,
  Shield,
  Clock,
} from 'lucide-react';
import { useAuth } from '../../lib/auth/auth-context';

interface SidebarProps {
  collapsed: boolean;
  mobileOpen: boolean;
  onCloseMobile: () => void;
}

export function Sidebar({ collapsed, mobileOpen, onCloseMobile }: SidebarProps) {
  const t = useTranslations('nav');
  const pathname = usePathname();
  const { canAccessAdmin, isAuthenticated } = useAuth();

  const primaryItems = [
    { href: '/', label: t('home'), icon: Home },
    { href: '/phim', label: t('movies'), icon: Clapperboard },
    { href: '/studio', label: t('studio'), icon: LayoutDashboard },
    ...(canAccessAdmin ? [{ href: '/admin', label: 'Admin', icon: Shield }] : []),
    { href: '/upload', label: t('upload'), icon: UploadCloud },
    ...(isAuthenticated
      ? [{ href: '/feed/subscriptions', label: t('subscriptions'), icon: Tv }]
      : []),
  ];

  const secondaryItems = [
    ...(isAuthenticated
      ? [{ href: '/playlist/watch-later', label: t('watchLater'), icon: Clock }]
      : []),
    { href: '#library', label: t('library'), icon: FolderHeart },
    { href: '#history', label: t('history'), icon: History },
  ];

  const exploreItems = [
    { href: '/trending', label: t('trending'), icon: Flame },
    { href: '#music', label: 'Âm nhạc', icon: Music2 },
    { href: '#gaming', label: 'Trò chơi', icon: Gamepad2 },
  ];

  const isLinkActive = (href: string) => {
    if (href.startsWith('#')) return false;
    if (href === '/') return pathname === '/' || pathname === '';
    return pathname.startsWith(href);
  };

  return (
    <>
      {/* Mobile Backdrop */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 md:hidden"
          onClick={onCloseMobile}
          aria-hidden="true"
        />
      )}

      {/* Sidebar Container */}
      <aside
        className={`fixed top-14 bottom-0 left-0 z-40 flex flex-col border-r border-[#272727] dark:border-[#272727] border-gray-200 bg-[#0f0f0f] dark:bg-[#0f0f0f] bg-white transition-all duration-200 overflow-y-auto ${
          // Mobile state
          mobileOpen ? 'translate-x-0 w-64' : '-translate-x-full md:translate-x-0'
        } ${
          // Desktop collapsed vs expanded
          collapsed ? 'md:w-[72px]' : 'md:w-60'
        }`}
      >
        <div className="flex flex-col gap-1 p-2">
          {primaryItems.map((item) => {
            const Icon = item.icon;
            const active = isLinkActive(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onCloseMobile}
                className={`flex items-center gap-4 rounded-xl px-3 py-2.5 transition text-sm font-medium ${
                  collapsed ? 'flex-col gap-1 px-1 py-3 text-[10px]' : ''
                } ${
                  active
                    ? 'bg-[#272727] dark:bg-[#272727] bg-gray-100 text-red-500 dark:text-white font-semibold'
                    : 'text-gray-700 dark:text-gray-300 hover:bg-[#272727]/60 dark:hover:bg-[#272727]/60 hover:bg-gray-50'
                }`}
              >
                <Icon className={`h-5 w-5 shrink-0 ${active ? 'text-red-600' : ''}`} />
                <span className={`truncate ${collapsed ? 'text-center' : ''}`}>{item.label}</span>
              </Link>
            );
          })}
        </div>

        {/* Separator if expanded */}
        {!collapsed && (
          <>
            <hr className="my-2 border-[#272727] dark:border-[#272727] border-gray-200" />
            <div className="flex flex-col gap-1 p-2">
              <div className="px-3 py-1 text-xs font-bold uppercase tracking-wider text-gray-400">
                Bạn
              </div>
              {secondaryItems.map((item) => {
                const Icon = item.icon;
                const active = isLinkActive(item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={onCloseMobile}
                    className={`flex items-center gap-4 rounded-xl px-3 py-2.5 text-sm font-medium transition ${
                      active
                        ? 'bg-[#272727] dark:bg-[#272727] bg-gray-100 text-red-500 dark:text-white font-semibold'
                        : 'text-gray-700 dark:text-gray-300 hover:bg-[#272727]/60 dark:hover:bg-[#272727]/60 hover:bg-gray-50'
                    }`}
                  >
                    <Icon className={`h-5 w-5 shrink-0 ${active ? 'text-red-600' : ''}`} />
                    <span className="truncate">{item.label}</span>
                  </Link>
                );
              })}
            </div>

            <hr className="my-2 border-[#272727] dark:border-[#272727] border-gray-200" />
            <div className="flex flex-col gap-1 p-2">
              <div className="px-3 py-1 text-xs font-bold uppercase tracking-wider text-gray-400">
                Khám phá
              </div>
              {exploreItems.map((item) => {
                const Icon = item.icon;
                const active = isLinkActive(item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={onCloseMobile}
                    className={`flex items-center gap-4 rounded-xl px-3 py-2.5 transition text-sm font-medium ${
                      active
                        ? 'bg-[#272727] dark:bg-[#272727] bg-gray-100 text-red-500 dark:text-white font-semibold'
                        : 'text-gray-700 dark:text-gray-300 hover:bg-[#272727]/60 dark:hover:bg-[#272727]/60 hover:bg-gray-50'
                    }`}
                  >
                    <Icon className={`h-5 w-5 shrink-0 ${active ? 'text-red-600' : ''}`} />
                    <span className="truncate">{item.label}</span>
                  </Link>
                );
              })}
            </div>

            <div className="mt-auto p-4 text-[11px] text-gray-500 space-y-2">
              <p>© 2026 Winkey VN</p>
              <p>Nền tảng Video Streaming Việt Nam</p>
            </div>
          </>
        )}
      </aside>
    </>
  );
}
