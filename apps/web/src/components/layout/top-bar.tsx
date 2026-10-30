'use client';

import React, { useState, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '../../i18n/routing';
import { useAuth } from '../../lib/auth/auth-context';
import { computePermissions } from '../../lib/auth';
import { hasSessionIndicator } from '../../lib/auth/session-indicator';
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
  Shield,
  Settings,
  FolderHeart,
  Sparkles,
} from 'lucide-react';
import { NotificationBell } from '../notifications/notification-bell';
import { ChatBadgeButton } from '../chat/chat-badge-button';
import { BrandLogo } from '../brand/logo';

interface TopBarProps {
  onToggleSidebar: () => void;
}

export function TopBar({ onToggleSidebar }: TopBarProps) {
  const t = useTranslations('nav');
  const { user, isAuthenticated, isLoading, logout, can: rawCan } = useAuth();
  const can = rawCan ?? computePermissions(user, isAuthenticated);
  const { theme, toggleTheme } = useTheme();
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim()) {
      searchInputRef.current?.focus();
      return;
    }
  };

  return (
    <header className="sticky top-0 z-40 flex h-14 w-full items-center justify-between border-b border-[#272727] dark:border-[#272727] border-gray-200 bg-[#0f0f0f] dark:bg-[#0f0f0f] bg-white px-4 transition-colors">
      {/* Left: Menu + Logo */}
      <div className="flex items-center gap-2 sm:gap-4">
        <button
          onClick={onToggleSidebar}
          aria-label="Toggle navigation menu"
          data-testid="sidebar-toggle-btn"
          className="rounded-full min-w-11 min-h-11 flex items-center justify-center p-2 text-gray-400 hover:bg-[#272727] hover:text-white dark:hover:bg-[#272727] hover:bg-gray-100 transition"
        >
          <Menu className="h-5 w-5" />
        </button>

        <Link
          href="/"
          className="flex items-center gap-1.5 min-h-11 min-w-11 px-1 focus:outline-none focus:ring-2 focus:ring-red-600 rounded"
        >
          <BrandLogo />
        </Link>
      </div>

      {/* Center: Search Box */}
      <form onSubmit={handleSearchSubmit} className="hidden sm:flex flex-1 max-w-[560px] mx-4">
        <div className="flex w-full items-center">
          <div className="relative w-full">
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('searchPlaceholder')}
              className="w-full h-10 rounded-l-full border border-[#383838] dark:border-[#383838] border-gray-300 bg-[#121212] dark:bg-[#121212] bg-gray-50 px-4 text-sm text-gray-900 dark:text-white focus:outline-2 focus:outline-[#D9002B] focus:ring-2 focus:ring-[#D9002B] focus:border-transparent placeholder-gray-500"
            />
          </div>
          <button
            type="submit"
            aria-label="Search"
            data-testid="search-submit-btn"
            className="flex h-10 min-w-11 min-h-11 shrink-0 items-center justify-center rounded-r-full border border-l-0 border-[#383838] dark:border-[#383838] border-gray-300 bg-[#222222] dark:bg-[#222222] bg-gray-200 px-6 text-gray-400 hover:bg-[#2c2c2c] dark:hover:bg-[#2c2c2c] hover:bg-gray-300 transition"
          >
            <Search className="h-4 w-4" />
          </button>
        </div>
      </form>

      {/* Right: Actions */}
      <div className="flex items-center gap-1 sm:gap-2">
        {/* Light/Dark Toggle */}
        <button
          onClick={toggleTheme}
          aria-label={theme === 'dark' ? t('lightMode') : t('darkMode')}
          className="rounded-full min-w-11 min-h-11 shrink-0 flex items-center justify-center p-2 text-gray-400 hover:bg-[#272727] dark:hover:bg-[#272727] hover:bg-gray-100 hover:text-white transition"
        >
          {theme === 'dark' ? (
            <Sun className="h-5 w-5 text-yellow-400" />
          ) : (
            <Moon className="h-5 w-5 text-gray-700" />
          )}
        </button>

        {isAuthenticated ? (
          <>
            {/* Upload Button */}
            {can.upload && (
              <Link
                href="/upload"
                data-testid="topbar-upload-btn"
                className="flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-full bg-[#272727] dark:bg-[#272727] bg-gray-100 px-3.5 py-1.5 text-xs font-semibold text-gray-900 dark:text-white hover:bg-[#383838] dark:hover:bg-[#383838] hover:bg-gray-200 transition"
              >
                <VideoIcon className="h-4 w-4 text-red-500 shrink-0" />
                <span className="hidden md:inline">{t('upload')}</span>
              </Link>
            )}

            {/* Studio Link */}
            {can.studio && (
              <Link
                href="/studio"
                data-testid="topbar-studio-btn"
                className="rounded-full min-w-11 min-h-11 shrink-0 flex items-center justify-center p-2 text-gray-400 hover:bg-[#272727] dark:hover:bg-[#272727] hover:bg-gray-100 hover:text-white transition"
                title={t('studio')}
              >
                <LayoutDashboard className="h-5 w-5" />
              </Link>
            )}

            {/* E2EE Chat Icon */}
            <ChatBadgeButton />

            {/* Notification Bell */}
            <NotificationBell />

            {/* User Dropdown */}
            <div className="relative">
              <button
                onClick={() => setShowUserMenu(!showUserMenu)}
                className="flex min-w-11 min-h-11 shrink-0 items-center justify-center focus:outline-none focus:ring-2 focus:ring-red-600 rounded-full"
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
                    <p className="font-semibold text-gray-900 dark:text-white truncate">
                      {user?.display_name}
                    </p>
                    <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
                      @{user?.handle}
                    </p>
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
                    href="/thu-vien"
                    onClick={() => setShowUserMenu(false)}
                    className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-gray-700 dark:text-gray-300 hover:bg-[#2a2a2a] dark:hover:bg-[#2a2a2a] hover:bg-gray-100 transition"
                  >
                    <FolderHeart className="h-4 w-4" />
                    <span>{t('library')}</span>
                  </Link>

                  <Link
                    href="/settings/account"
                    onClick={() => setShowUserMenu(false)}
                    className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-gray-700 dark:text-gray-300 hover:bg-[#2a2a2a] dark:hover:bg-[#2a2a2a] hover:bg-gray-100 transition"
                  >
                    <Settings className="h-4 w-4" />
                    <span>{t('accountSettings')}</span>
                  </Link>

                  {can.studio && (
                    <Link
                      href="/studio"
                      data-testid="user-menu-studio-btn"
                      onClick={() => setShowUserMenu(false)}
                      className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-gray-700 dark:text-gray-300 hover:bg-[#2a2a2a] dark:hover:bg-[#2a2a2a] hover:bg-gray-100 transition"
                    >
                      <LayoutDashboard className="h-4 w-4" />
                      <span>Winkey Studio</span>
                    </Link>
                  )}

                  {can.requestCreator && (
                    <Link
                      href="/nang-cap"
                      data-testid="user-menu-upgrade-btn"
                      onClick={() => setShowUserMenu(false)}
                      className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-gray-700 dark:text-gray-300 hover:bg-[#2a2a2a] dark:hover:bg-[#2a2a2a] hover:bg-gray-100 transition"
                    >
                      <Sparkles className="h-4 w-4 text-amber-500" />
                      <span>Trở thành nhà sáng tạo</span>
                    </Link>
                  )}

                  {can.moderate && (
                    <Link
                      href="/admin"
                      data-testid="user-menu-admin-btn"
                      onClick={() => setShowUserMenu(false)}
                      className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-red-500 hover:bg-[#2a2a2a] dark:hover:bg-[#2a2a2a] hover:bg-gray-100 transition"
                    >
                      <Shield className="h-4 w-4" />
                      <span>Trang quản trị (Admin)</span>
                    </Link>
                  )}

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
        ) : isLoading && hasSessionIndicator() ? (
          <div className="flex items-center gap-2" aria-hidden="true">
            <div className="h-8 w-20 rounded-full bg-zinc-800 animate-pulse hidden md:block" />
            <div className="h-8 w-8 rounded-full bg-zinc-800 animate-pulse" />
            <div className="h-8 w-8 rounded-full bg-zinc-800 animate-pulse" />
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <Link
              href="/login"
              className="inline-flex items-center justify-center min-h-11 min-w-11 rounded-full border border-blue-500/50 px-3.5 py-1.5 text-xs font-semibold text-blue-500 hover:bg-blue-500/10 transition"
            >
              {t('signIn')}
            </Link>
            <Link
              href="/register"
              className="hidden sm:inline-flex items-center justify-center min-h-11 min-w-11 rounded-full bg-red-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-red-700 transition"
            >
              {t('register')}
            </Link>
          </div>
        )}
      </div>
    </header>
  );
}
