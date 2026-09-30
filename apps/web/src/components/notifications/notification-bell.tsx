'use client';

import React, { useState, useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { Bell } from 'lucide-react';
import type { UnreadCount } from '@winkey/api-client';
import { api } from '../../lib/api-client';
import { useAuth } from '../../lib/auth/auth-context';
import { NotificationDropdown } from './notification-dropdown';

export function NotificationBell() {
  const t = useTranslations('notifications');
  const { isAuthenticated } = useAuth();
  const [isOpen, setIsOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Poll unread count every 60s only when the tab is visible (ADR-023)
  const { data } = useQuery<UnreadCount>({
    queryKey: ['notifications', 'unread-count'],
    queryFn: async () => {
      const { data, response } = await api.social.GET('/v1/notifications/unread-count');
      if (!response.ok || !data) {
        // Return 0 on error or unauthorized without throwing
        return { count: 0, capped: false };
      }
      return data;
    },
    enabled: isAuthenticated && mounted,
    refetchInterval: 60000,
    refetchIntervalInBackground: false, // Stop polling when tab is hidden
    refetchOnWindowFocus: true,
    staleTime: 30000,
  });

  if (!isAuthenticated) return null;

  const count = mounted ? (data?.count ?? 0) : 0;
  const isCapped = mounted ? (data?.capped ?? false) : false;
  const showBadge = count > 0;
  const badgeLabel = isCapped || count >= 100 ? '99+' : `${count}`;

  const handleClose = () => {
    setIsOpen(false);
    triggerRef.current?.focus();
  };

  const handleToggle = () => {
    setIsOpen((prev) => !prev);
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={handleToggle}
        aria-label={t('bellAriaLabel')}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        data-testid="notification-bell-button"
        className="relative rounded-full p-2 text-gray-400 hover:bg-[#272727] dark:hover:bg-[#272727] hover:bg-gray-100 hover:text-white transition focus:outline-none focus:ring-2 focus:ring-red-600 cursor-pointer"
      >
        <Bell className="h-5 w-5" />
        {showBadge && (
          <span
            data-testid="notification-badge"
            className="absolute top-0.5 right-0.5 flex min-w-4 h-4 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-bold text-white shadow ring-2 ring-[#0f0f0f] dark:ring-[#0f0f0f]"
          >
            {badgeLabel}
          </span>
        )}
      </button>

      <NotificationDropdown
        isOpen={isOpen}
        onClose={handleClose}
        containerRef={containerRef}
        triggerRef={triggerRef}
      />
    </div>
  );
}
