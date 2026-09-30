'use client';

import React, { useState, useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell } from 'lucide-react';
import type { UnreadCount } from '@winkey/api-client';
import { api } from '../../lib/api-client';
import { useAuth } from '../../lib/auth/auth-context';
import { useOptionalRealtime } from '../../lib/realtime/realtime-context';
import { usePathname } from '../../i18n/routing';
import type { ServerEventMessage } from '../../lib/realtime/realtime-types';
import { NotificationDropdown } from './notification-dropdown';

export function NotificationBell() {
  const t = useTranslations('notifications');
  const queryClient = useQueryClient();
  const { isAuthenticated, user } = useAuth();
  const pathname = usePathname();
  const realtime = useOptionalRealtime();
  const client = realtime?.client;

  const [isOpen, setIsOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Keep refs for callbacks and timers to avoid stale closures
  const isOpenRef = useRef(isOpen);
  isOpenRef.current = isOpen;

  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;

  const hintTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Track status ticks to re-render if standalone client changes connection status
  const [, setStatusTick] = useState(0);
  useEffect(() => {
    if (!client) return;
    return client.onStatusChange(() => {
      setStatusTick((prev) => prev + 1);
    });
  }, [client]);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Polling interval (ADR-023 addendum N2):
  // 5 min (300,000 ms) while realtime socket is connected & authenticated;
  // 60 s (60,000 ms) while disconnected or anonymous.
  const isRealtimeAuthenticated =
    (realtime?.isConnected ?? client?.getIsConnected() ?? false) && Boolean(client?.getUserId());
  const pollInterval = isRealtimeAuthenticated ? 5 * 60 * 1000 : 60 * 1000;

  // Poll unread count only when tab is visible
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
    refetchInterval: pollInterval,
    refetchIntervalInBackground: false, // Stop polling when tab is hidden
    refetchOnWindowFocus: true,
    staleTime: 30000,
  });

  const triggerNotificationInvalidation = () => {
    queryClient.invalidateQueries({ queryKey: ['notifications', 'unread-count'] });
    if (isOpenRef.current) {
      queryClient.invalidateQueries({ queryKey: ['notifications', 'latest-10'] });
      queryClient.invalidateQueries({ queryKey: ['notifications', 'dropdown'] });
    }
    if (
      pathnameRef.current?.includes('/notifications') ||
      queryClient
        .getQueryCache()
        .findAll({ queryKey: ['notifications', 'page'] })
        .some((q) => q.isActive())
    ) {
      queryClient.invalidateQueries({ queryKey: ['notifications', 'page'] });
    }
  };

  // Listen to realtime notification.hint events on user:{me} room (N2)
  useEffect(() => {
    if (!client || !isAuthenticated || !user) return;

    const unsubUserEvent = client.onUserEvent((event: ServerEventMessage) => {
      if (event.event !== 'notification.hint') return;
      if (event.room !== `user:${user.id}`) return;

      // Never render anything from the hint itself.
      // Coalesce bursts: at most one refetch per 2 s (trailing).
      if (hintTimeoutRef.current) return;

      hintTimeoutRef.current = setTimeout(() => {
        hintTimeoutRef.current = null;
        triggerNotificationInvalidation();
      }, 2000);
    });

    return () => {
      unsubUserEvent();
      if (hintTimeoutRef.current) {
        clearTimeout(hintTimeoutRef.current);
        hintTimeoutRef.current = null;
      }
    };
  }, [client, isAuthenticated, user, queryClient]);

  // On socket reconnect, refetch once (ADR-023 N2)
  useEffect(() => {
    if (!client || !isAuthenticated) return;

    const unsubReconnect = client.onReconnect(() => {
      triggerNotificationInvalidation();
    });

    return () => {
      unsubReconnect();
    };
  }, [client, isAuthenticated, queryClient]);

  // Connect realtime client when authenticated to receive user:{me} hints
  useEffect(() => {
    if (!client || !isAuthenticated) return;
    client.connect();
  }, [client, isAuthenticated]);

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
