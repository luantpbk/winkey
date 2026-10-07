'use client';

import React, { useState, useEffect, useRef, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Link, usePathname, useRouter } from '../../i18n/routing';
import { useAuth } from '../../lib/auth/auth-context';
import { NotificationBell } from '../notifications/notification-bell';
import { EmailVerificationBanner } from '../auth/email-verification-banner';
import { beVietnamPro } from '../../lib/fonts';
import {
  Search,
  Upload,
  User as UserIcon,
  LogOut,
  LayoutDashboard,
  Shield,
  Settings,
  Home,
  Compass,
  Bell,
  X,
  Play,
} from 'lucide-react';

interface CinemaShellProps {
  children: ReactNode;
  feedbackUrl?: string | null;
}

export function CinemaShell({ children, feedbackUrl }: CinemaShellProps) {
  const tNav = useTranslations('nav');
  const tCin = useTranslations('cinema');
  const pathname = usePathname();
  const router = useRouter();
  const { user, isAuthenticated, logout, canAccessAdmin } = useAuth();

  const [isScrolled, setIsScrolled] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [searchOverlayOpen, setSearchOverlayOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Turn solid #0A0A0D after 64px of scroll
  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 64);
    };
    window.addEventListener('scroll', handleScroll, { passive: true });
    handleScroll();
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  // Autofocus search input when overlay opens
  useEffect(() => {
    if (searchOverlayOpen) {
      setTimeout(() => searchInputRef.current?.focus(), 50);
    }
  }, [searchOverlayOpen]);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchQuery.trim()) {
      setSearchOverlayOpen(false);
      router.push(`/kham-pha?tab=trending`);
    }
  };

  const isHomeActive = pathname === '/' || pathname === '';

  return (
    <div
      className={`${beVietnamPro.className} ${beVietnamPro.variable} min-h-screen bg-[#0A0A0D] text-[#F4F4F6] flex flex-col selection:bg-[#FF0033] selection:text-white`}
      style={
        {
          '--cin-bg': '#0A0A0D',
          '--cin-surface': '#14141A',
          '--cin-elevated': '#1D1D25',
          '--cin-text': '#F4F4F6',
          '--cin-muted': '#A3A3AD',
          '--cin-accent': '#FF0033',
          '--cin-positive': '#4ADE80',
          fontFamily: "var(--font-be-vietnam-pro), 'Be Vietnam Pro', system-ui, sans-serif",
        } as React.CSSProperties
      }
    >
      {/* 1. DESKTOP / TABLET TOP BAR (72px, hidden on small screens) */}
      <header
        data-testid="cinema-desktop-topbar"
        className={`fixed top-0 left-0 right-0 z-50 h-[72px] px-6 sm:px-12 items-center gap-8 transition-colors duration-300 hidden md:flex ${
          isScrolled
            ? 'bg-[#0A0A0D] border-b border-white/[0.08] shadow-lg'
            : 'bg-gradient-to-b from-[#0A0A0D]/90 via-[#0A0A0D]/60 to-transparent'
        }`}
      >
        {/* Brand Logo */}
        <Link
          href="/"
          aria-label="Winkey, trang chủ"
          className="flex items-center gap-2.5 shrink-0 focus:outline-none focus:ring-2 focus:ring-[#FF0033] rounded-lg"
        >
          <span className="w-8 h-8 rounded-lg bg-[#FF0033] flex items-center justify-center text-white shadow-md">
            <Play className="w-4 h-4 fill-current ml-0.5" />
          </span>
          <span className="text-[22px] font-extrabold tracking-tight text-[#F4F4F6]">Winkey</span>
        </Link>

        {/* Primary Nav Links */}
        <nav aria-label="Chính" className="flex items-center gap-7 flex-wrap">
          <Link
            href="/"
            aria-current={isHomeActive ? 'page' : undefined}
            className={`text-[15px] transition-colors py-2 border-b-2 ${
              isHomeActive
                ? 'text-white font-bold border-[#FF0033]'
                : 'text-[#B9B9C2] hover:text-white font-medium border-transparent'
            }`}
          >
            {tCin('home')}
          </Link>
          <Link
            href="/trending"
            className="text-[15px] font-medium text-[#B9B9C2] hover:text-white transition-colors py-2 border-b-2 border-transparent"
          >
            {tCin('trending')}
          </Link>
          <Link
            href="/kham-pha"
            className="text-[15px] font-medium text-[#B9B9C2] hover:text-white transition-colors py-2 border-b-2 border-transparent"
          >
            {tCin('explore')}
          </Link>
          {isAuthenticated && (
            <>
              <Link
                href="/feed/subscriptions"
                className="text-[15px] font-medium text-[#B9B9C2] hover:text-white transition-colors py-2 border-b-2 border-transparent"
              >
                {tCin('subscriptions')}
              </Link>
              <Link
                href="/playlist/watch-later"
                className="text-[15px] font-medium text-[#B9B9C2] hover:text-white transition-colors py-2 border-b-2 border-transparent"
              >
                {tCin('myList')}
              </Link>
            </>
          )}
        </nav>

        {/* Right Actions: Search, Upload, Bell, Account */}
        <div className="ml-auto flex items-center gap-2">
          {/* Search trigger button */}
          <button
            type="button"
            onClick={() => setSearchOverlayOpen(true)}
            aria-label="Tìm kiếm"
            data-testid="cinema-search-btn"
            className="w-11 h-11 rounded-full flex items-center justify-center text-[#F4F4F6] hover:bg-white/10 transition-colors"
          >
            <Search className="w-5 h-5" />
          </button>

          {/* Upload */}
          <Link
            href="/upload"
            aria-label="Tải video lên"
            data-testid="cinema-upload-btn"
            className="w-11 h-11 rounded-full flex items-center justify-center text-[#F4F4F6] hover:bg-white/10 transition-colors"
          >
            <Upload className="w-5 h-5" />
          </Link>

          {/* Notifications */}
          <NotificationBell />

          {/* Account Menu */}
          {isAuthenticated ? (
            <div className="relative ml-2">
              <button
                type="button"
                onClick={() => setShowUserMenu(!showUserMenu)}
                aria-label="Tài khoản"
                data-testid="cinema-account-btn"
                className="w-9 h-9 rounded-lg bg-[#3D5AFE] text-white font-bold text-sm flex items-center justify-center focus:outline-none focus:ring-2 focus:ring-[#FF0033] overflow-hidden"
              >
                {user?.avatar_url ? (
                  <img
                    src={user.avatar_url}
                    alt={user.display_name}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <span>{user?.display_name?.charAt(0) || 'U'}</span>
                )}
              </button>

              {showUserMenu && (
                <div
                  className="absolute right-0 mt-2 w-60 rounded-xl bg-[#1D1D25] border border-white/10 p-2 shadow-2xl z-50 text-sm animate-in fade-in zoom-in-95 duration-150"
                  onMouseLeave={() => setShowUserMenu(false)}
                >
                  <div className="px-3 py-2 border-b border-white/10">
                    <p className="font-semibold text-white truncate">{user?.display_name}</p>
                    <p className="text-xs text-[#A3A3AD] truncate">@{user?.handle}</p>
                  </div>

                  <Link
                    href={`/c/${user?.handle}`}
                    onClick={() => setShowUserMenu(false)}
                    className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-[#F4F4F6] hover:bg-white/10 transition"
                  >
                    <UserIcon className="h-4 w-4 text-[#A3A3AD]" />
                    <span>Kênh của bạn</span>
                  </Link>

                  <Link
                    href="/settings/account"
                    onClick={() => setShowUserMenu(false)}
                    className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-[#F4F4F6] hover:bg-white/10 transition"
                  >
                    <Settings className="h-4 w-4 text-[#A3A3AD]" />
                    <span>{tNav('accountSettings')}</span>
                  </Link>

                  <Link
                    href="/studio"
                    onClick={() => setShowUserMenu(false)}
                    className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-[#F4F4F6] hover:bg-white/10 transition"
                  >
                    <LayoutDashboard className="h-4 w-4 text-[#A3A3AD]" />
                    <span>Winkey Studio</span>
                  </Link>

                  {canAccessAdmin && (
                    <Link
                      href="/admin"
                      onClick={() => setShowUserMenu(false)}
                      className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-red-400 hover:bg-white/10 transition"
                    >
                      <Shield className="h-4 w-4" />
                      <span>Trang quản trị (Admin)</span>
                    </Link>
                  )}

                  <button
                    type="button"
                    onClick={async () => {
                      setShowUserMenu(false);
                      await logout();
                    }}
                    className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-red-400 hover:bg-white/10 transition text-left mt-1 border-t border-white/10 pt-2"
                  >
                    <LogOut className="h-4 w-4" />
                    <span>{tNav('signOut')}</span>
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-2 ml-2">
              <Link
                href="/login"
                className="px-4 py-2 text-sm font-semibold rounded-lg bg-white/10 hover:bg-white/20 text-white transition"
              >
                {tNav('signIn')}
              </Link>
              <Link
                href="/register"
                className="px-4 py-2 text-sm font-semibold rounded-lg bg-white text-[#0A0A0D] hover:bg-[#E4E4E8] transition"
              >
                {tNav('register')}
              </Link>
            </div>
          )}
        </div>
      </header>

      {/* 2. MOBILE TOP BAR & QUICK CHIPS (< 768px) */}
      <div className="md:hidden fixed top-0 left-0 right-0 z-50">
        <header
          data-testid="cinema-mobile-topbar"
          className={`h-14 px-4 flex items-center justify-between transition-colors duration-300 ${
            isScrolled
              ? 'bg-[#0A0A0D] border-b border-white/[0.08]'
              : 'bg-gradient-to-b from-[#0A0A0D]/90 to-transparent'
          }`}
        >
          <Link href="/" aria-label="Winkey, trang chủ" className="flex items-center gap-2">
            <span className="w-7 h-7 rounded-lg bg-[#FF0033] flex items-center justify-center text-white">
              <Play className="w-3.5 h-3.5 fill-current ml-0.5" />
            </span>
            <span className="text-[19px] font-extrabold tracking-tight text-white">Winkey</span>
          </Link>
          <button
            type="button"
            onClick={() => setSearchOverlayOpen(true)}
            aria-label="Tìm kiếm"
            className="w-11 h-11 flex items-center justify-center text-white"
          >
            <Search className="w-5 h-5" />
          </button>
        </header>

        {/* Quick Chips Nav */}
        <nav aria-label="Lọc nhanh" className="px-4 pb-2 flex gap-2 overflow-x-auto scrollbar-none">
          <Link
            href="/trending"
            className="h-8 px-3.5 rounded-full border border-white/45 text-[13px] font-semibold inline-flex items-center text-white whitespace-nowrap bg-black/40 backdrop-blur-sm"
          >
            {tCin('trending')}
          </Link>
          <Link
            href="/kham-pha"
            className="h-8 px-3.5 rounded-full border border-white/45 text-[13px] font-semibold inline-flex items-center text-white whitespace-nowrap bg-black/40 backdrop-blur-sm"
          >
            {tCin('explore')}
          </Link>
          <Link
            href={isAuthenticated ? '/playlist/watch-later' : '/login'}
            className="h-8 px-3.5 rounded-full border border-white/45 text-[13px] font-semibold inline-flex items-center text-white whitespace-nowrap bg-black/40 backdrop-blur-sm"
          >
            {tCin('my')}
          </Link>
        </nav>
      </div>

      {/* 3. SEARCH OVERLAY */}
      {searchOverlayOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Tìm kiếm"
          data-testid="cinema-search-overlay"
          className="fixed inset-0 z-50 bg-[#0A0A0D]/95 backdrop-blur-md flex flex-col p-4 sm:p-8"
        >
          <div className="flex items-center justify-between max-w-2xl mx-auto w-full mb-6">
            <span className="text-lg font-bold text-white">Tìm kiếm video</span>
            <button
              type="button"
              onClick={() => setSearchOverlayOpen(false)}
              aria-label="Đóng tìm kiếm"
              className="w-10 h-10 rounded-full flex items-center justify-center text-white hover:bg-white/10"
            >
              <X className="w-6 h-6" />
            </button>
          </div>

          <form onSubmit={handleSearchSubmit} className="max-w-2xl mx-auto w-full">
            <div className="relative flex items-center">
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Tìm phim, video, kênh..."
                className="w-full h-14 pl-5 pr-14 rounded-xl bg-[#14141A] border border-white/20 text-white placeholder-[#A3A3AD] text-lg focus:outline-none focus:border-[#FF0033]"
              />
              <button
                type="submit"
                aria-label="Thực hiện tìm kiếm"
                className="absolute right-3 w-10 h-10 rounded-lg bg-white text-[#0A0A0D] flex items-center justify-center hover:bg-[#E4E4E8]"
              >
                <Search className="w-5 h-5" />
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Email Verification Banner */}
      <div className="pt-[72px] md:pt-[72px]">
        <EmailVerificationBanner />
      </div>

      {/* Main Page Content */}
      <main className="flex-1 -mt-[72px] md:-mt-[72px]">{children}</main>

      {/* 4. BETA FOOTER */}
      <footer
        data-testid="cinema-footer"
        className="border-t border-white/[0.08] px-6 sm:px-12 py-8 pb-24 md:pb-12 flex flex-wrap items-center gap-6 text-sm"
      >
        <span className="text-[#8E8E99]">{tCin('copyright')}</span>
        <nav aria-label="Chân trang" className="flex flex-wrap gap-5 text-[#8E8E99]">
          <Link href="/dieu-khoan" className="hover:text-white transition hover:underline">
            {tCin('terms')}
          </Link>
          <Link href="/quyen-rieng-tu" className="hover:text-white transition hover:underline">
            {tCin('privacy')}
          </Link>
          <Link href="/quy-tac-cong-dong" className="hover:text-white transition hover:underline">
            {tCin('communityRules')}
          </Link>
          {feedbackUrl && (
            <a
              href={feedbackUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-white transition hover:underline"
            >
              {tCin('betaFeedback')}
            </a>
          )}
        </nav>
      </footer>

      {/* 5. MOBILE BOTTOM TAB BAR (< 768px) */}
      <nav
        aria-label="Điều hướng chính"
        data-testid="cinema-mobile-tabbar"
        className="md:hidden fixed left-0 right-0 bottom-0 z-50 h-16 pb-[env(safe-area-inset-bottom,4px)] flex bg-[#101015]/95 backdrop-blur-md border-t border-white/[0.08]"
      >
        <Link
          href="/"
          aria-current={isHomeActive ? 'page' : undefined}
          className={`flex-1 flex flex-col items-center justify-center gap-1 text-[11px] font-semibold ${
            isHomeActive ? 'text-white' : 'text-[#8E8E99]'
          }`}
        >
          <Home className="w-5 h-5" />
          <span>{tCin('home')}</span>
        </Link>
        <Link
          href="/kham-pha"
          className="flex-1 flex flex-col items-center justify-center gap-1 text-[11px] font-semibold text-[#8E8E99]"
        >
          <Compass className="w-5 h-5" />
          <span>{tCin('explore')}</span>
        </Link>
        <Link
          href="/upload"
          aria-label={tCin('upload')}
          className="flex-1 flex flex-col items-center justify-center text-[#8E8E99]"
        >
          <span className="w-10 h-7 rounded-lg border-[1.5px] border-current flex items-center justify-center">
            <Upload className="w-4 h-4" />
          </span>
        </Link>
        <Link
          href="/notifications"
          className="flex-1 flex flex-col items-center justify-center gap-1 text-[11px] font-semibold text-[#8E8E99]"
        >
          <Bell className="w-5 h-5" />
          <span>{tCin('notifications')}</span>
        </Link>
        <Link
          href={isAuthenticated ? `/c/${user?.handle}` : '/login'}
          className="flex-1 flex flex-col items-center justify-center gap-1 text-[11px] font-semibold text-[#8E8E99]"
        >
          {isAuthenticated && user?.avatar_url ? (
            <img src={user.avatar_url} alt="" className="w-5 h-5 rounded-full object-cover" />
          ) : (
            <UserIcon className="w-5 h-5" />
          )}
          <span>{tCin('me')}</span>
        </Link>
      </nav>
    </div>
  );
}
