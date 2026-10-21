'use client';

import React, { useState, type ReactNode } from 'react';
import { usePathname } from '../../i18n/routing';
import { TopBar } from './top-bar';
import { Sidebar } from './sidebar';
import { CinemaShell } from './cinema-shell';
import { Footer } from './footer';
import { BottomNav } from './bottom-nav';
import { EmailVerificationBanner } from '../auth/email-verification-banner';
import { useSpatialNavigation } from '../../hooks/use-spatial-navigation';
import { useTvMode } from '../../lib/tv-mode';

export function Shell({
  children,
  feedbackUrl,
}: {
  children: ReactNode;
  feedbackUrl?: string | null;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const pathname = usePathname();

  const { isTvMode } = useTvMode();
  useSpatialNavigation(isTvMode);

  const isCinemaHome = pathname === '/' || pathname === '';

  // Cinema home uses CinemaShell without sidebar
  if (isCinemaHome) {
    return <CinemaShell feedbackUrl={feedbackUrl}>{children}</CinemaShell>;
  }

  const toggleSidebar = () => {
    // On small screen toggle mobile drawer; on desktop toggle collapsed rail
    if (typeof window !== 'undefined' && window.innerWidth < 768) {
      setMobileOpen((prev) => !prev);
    } else {
      setCollapsed((prev) => !prev);
    }
  };

  return (
    <div className="min-h-screen bg-[#0f0f0f] dark:bg-[#0f0f0f] bg-white text-gray-900 dark:text-gray-100 flex flex-col transition-colors">
      <TopBar onToggleSidebar={toggleSidebar} />
      <EmailVerificationBanner />
      <div className="flex flex-1">
        <Sidebar
          collapsed={collapsed}
          mobileOpen={mobileOpen}
          onCloseMobile={() => setMobileOpen(false)}
          feedbackUrl={feedbackUrl}
        />
        <main
          className={`flex-1 flex flex-col transition-all duration-200 min-h-[calc(100vh-56px)] overflow-x-hidden pb-16 md:pb-0 ${
            collapsed ? 'md:ml-[72px]' : 'md:ml-60'
          }`}
        >
          <div className="flex-1 p-4 sm:p-6">{children}</div>
          <Footer feedbackUrl={feedbackUrl} />
        </main>
      </div>
      <BottomNav />
    </div>
  );
}
