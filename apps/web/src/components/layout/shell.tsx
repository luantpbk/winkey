'use client';

import React, { useState, type ReactNode } from 'react';
import { usePathname } from '../../i18n/routing';
import { TopBar } from './top-bar';
import { Sidebar } from './sidebar';
import { EmailVerificationBanner } from '../auth/email-verification-banner';

export function Shell({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const pathname = usePathname();
  const isCinema = pathname === '/phim' || pathname?.endsWith('/phim');

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
        />
        <main
          className={`flex-1 transition-all duration-200 min-h-[calc(100vh-56px)] ${
            isCinema ? 'p-0 overflow-x-hidden' : 'p-4 sm:p-6 overflow-x-hidden'
          } ${collapsed ? 'md:ml-[72px]' : 'md:ml-60'}`}
        >
          {children}
        </main>
      </div>
    </div>
  );
}
