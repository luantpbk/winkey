'use client';

import React, { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Link, usePathname } from '../../i18n/routing';
import { useAuth } from '../../lib/auth/auth-context';
import { useTheme } from '../theme-provider';
import {
  Menu,
  Search,
  Video as VideoIcon,
  Sun,
  Moon,
  LayoutDashboard,
  User as UserIcon,
  LogOut,
  PlaySquare,
} from 'lucide-react';

interface TopBarProps {
  onToggleSidebar: () => void;
}

export function TopBar({ onToggleSidebar }: TopBarProps) {
  const t = useTranslations('nav');
  const { user, isAuthenticated, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchQuery.trim()) {
      // In Task U1, search query UI state
    }
  };

  return (
    <header className="sticky top-0 z-40 flex h-14 w-full items-center justify-between border-b border-[#272727] dark:border-[#272727] border-gray-200 bg-[#0f0f0f] dark:bg-[#0f0f0f] bg-white px-4 transition-colors">
      {/* Left: Menu + Logo */}
      <div className="flex items-center gap-4">
        <button
          onClick={onToggleSidebar}
          aria-label="Toggle navigation menu"
          className="rounded-full p-2 text-gray-400 hover:bg-[#272727] hover:text-white dark:hover:bg-[#272727] hover:bg-gray-100 transition"
        >
          <Menu className="h-5 w-5" />
        </button>

        <Link href="/" className="flex items-center gap-1.5 focus:outline-none focus:ring-2 focus:ring-red-600 rounded">
          <div className="flex h-7 w-8 items-center justify-center rounded-lg bg-red-600 text-white shadow">
            <PlaySquare className="h-5 w-5 fill-current" />
          </div>
          <span className="text-xl font-bold tracking-tight text-gray-900 dark:text-white flex items-center">
            Winkey
            <span className="ml-1 text-[10px] uppercase font-bold text-red-500 tracking-wider">VN</span>
          </span>
        </Link>
      </div>

      {/* Center: Search Box */}
      <form onSubmit={handleSearchSubmit} className="hidden sm:flex flex-1 max-w-[560px] mx-4">
        <div className="flex w-full items-center">
          <div className="relative w-full">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('searchPlaceholder')}
              className="w-full h-10 rounded-l-full border border-[#383838] dark:border-[#383838] border-gray-300 bg-[#121212] dark:bg-[#121212] bg-gray-50 px-4 text-sm text-gray-900 dark:text-white focus:border-blue-500 focus:outline-none placeholder-gray-500"
            />
          </div>
          <button
            type="submit"
            aria-label="Search"
            className="flex h-10 items-center justify-center rounded-r-full border border-l-0 border-[#383838] dark:border-[#383838] border-gray-300 bg-[#222222] dark:bg-[#222222] bg-gray-200 px-6 text-gray-400 hover:bg-[#2c2c2c] dark:hover:bg-[#2c2c2c] hover:bg-gray-300 transition"
          >
            <Search className="h-4 w-4" />
          </button>
        </div>
      </form>

      {/* Right: Actions */}
      <div className="flex items-center gap-2">
        {/* Light/Dark Toggle */}
        <button
          onClick={toggleTheme}
          aria-label={theme === 'dark' ? t('lightMode') : t('darkMode')}
          className="rounded-full p-2 text-gray-400 hover:bg-[#272727] dark:hover:bg-[#272727] hover:bg-gray-100 hover:text-white transition"
        >
          {theme === 'dark' ? <Sun className="h-5 w-5 text-yellow-400" /> : <Moon className="h-5 w-5 text-gray-700" />}
        </button>

        {isAuthenticated ? (
          <>
            {/* Upload Button */}
            <Link
              href="/upload"
              className="flex items-center gap-1.5 rounded-full bg-[#272727] dark:bg-[#272727] bg-gray-100 px-3.5 py-1.5 text-xs font-semibold text-gray-900 dark:text-white hover:bg-[#383838] dark:hover:bg-[#383838] hover:bg-gray-200 transition"
            >
              <VideoIcon className="h-4 w-4 text-red-500" />
              <span className="hidden md:inline">{t('upload')}</span>
            </Link>

            {/* Studio Link */}
            <Link
              href="/studio"
              className="rounded-full p-2 text-gray-400 hover:bg-[#272727] dark:hover:bg-[#272727] hover:bg-gray-100 hover:text-white transition"
              title={t('studio')}
            >
              <LayoutDashboard className="h-5 w-5" />
            </Link>

            {/* User Dropdown */}
            <div className="relative">
              <button
                onClick={() => setShowUserMenu(!showUserMenu)}
                className="flex items-center focus:outline-none focus:ring-2 focus:ring-red-600 rounded-full"
                aria-label="User profile menu"
              >
                {user?.avatar_url ? (
                  <img
                    src={user.avatar_url}
                    alt={user.display_name}
                    className="h-8 w-8 rounded-full object-cover ring-2 ring-transparent hover:ring-red-500"
                  />
                ) : (
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-red-700 text-white font-bold text-xs">
                    {user?.display_name?.charAt(0) || 'U'}
                  </div>
                )}
              </button>

              {showUserMenu && (
                <div
                  className="absolute right-0 mt-2 w-56 rounded-xl border border-[#383838] dark:border-[#383838] border-gray-200 bg-[#1f1f1f] dark:bg-[#1f1f1f] bg-white p-2 shadow-2xl z-50 text-sm"
                  onMouseLeave={() => setShowUserMenu(false)}
                >
                  <div className="px-3 py-2 border-b border-[#2e2e2e] dark:border-[#2e2e2e] border-gray-100">
                    <p className="font-semibold text-gray-900 dark:text-white truncate">{user?.display_name}</p>
                    <p className="text-xs text-gray-500 dark:text-gray-400 truncate">@{user?.handle}</p>
                  </div>

                  <Link
                    href={`/c/${user?.handle}`}
                    onClick={() => setShowUserMenu(false)}
                    className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-gray-700 dark:text-gray-300 hover:bg-[#2a2a2a] dark:hover:bg-[#2a2a2a] hover:bg-gray-100 transition"
                  >
                    <UserIcon className="h-4 w-4" />
                    <span>Kênh của bạn</span>
                  </Link>

                  <Link
                    href="/studio"
                    onClick={() => setShowUserMenu(false)}
                    className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-gray-700 dark:text-gray-300 hover:bg-[#2a2a2a] dark:hover:bg-[#2a2a2a] hover:bg-gray-100 transition"
                  >
                    <LayoutDashboard className="h-4 w-4" />
                    <span>Winkey Studio</span>
                  </Link>

                  <button
                    onClick={async () => {
                      setShowUserMenu(false);
                      await logout();
                    }}
                    className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-red-500 hover:bg-[#2a2a2a] dark:hover:bg-[#2a2a2a] hover:bg-gray-100 transition text-left"
                  >
                    <LogOut className="h-4 w-4" />
                    <span>{t('signOut')}</span>
                  </button>
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="flex items-center gap-2">
            <Link
              href="/login"
              className="rounded-full border border-blue-500/50 px-3.5 py-1.5 text-xs font-semibold text-blue-500 hover:bg-blue-500/10 transition"
            >
              {t('signIn')}
            </Link>
            <Link
              href="/register"
              className="hidden sm:inline-block rounded-full bg-red-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-red-700 transition"
            >
              {t('register')}
            </Link>
          </div>
        )}
      </div>
    </header>
  );
}
