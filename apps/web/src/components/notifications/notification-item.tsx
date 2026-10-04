'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import type { Notification } from '@winkey/api-client';
import { api } from '../../lib/api-client';
import { formatRelativeTime } from '../../lib/format';
import { Link } from '../../i18n/routing';
import { buildWatchUrl } from '../../lib/video/watch-url';

export interface NotificationItemProps {
  notification: Notification;
  onItemClick?: (notification: Notification) => void;
  className?: string;
}

export function getNotificationUrl(notification: Notification): string {
  switch (notification.kind) {
    case 'NEW_SUBSCRIBER':
      return `/c/${notification.actor.handle}`;
    case 'VIDEO_COMMENT':
    case 'COMMENT_REPLY':
      if (notification.video_id && notification.comment_id) {
        return buildWatchUrl(notification.video_id, 'other', { comment: notification.comment_id });
      }
      if (notification.video_id) {
        return buildWatchUrl(notification.video_id, 'other');
      }
      return '/';
    case 'VIDEO_PUBLISHED':
      return notification.video_id ? buildWatchUrl(notification.video_id, 'other') : '/';
    default:
      return '/';
  }
}

export function NotificationItem({
  notification,
  onItemClick,
  className = '',
}: NotificationItemProps) {
  const t = useTranslations('notifications');
  const isUnread = !notification.read_at;

  // Lazy-load video title for visible notifications with video_id (ADR-023)
  const { data: videoData } = useQuery({
    queryKey: ['video-title', notification.video_id],
    queryFn: async () => {
      if (!notification.video_id) return null;
      try {
        const { data, response } = await api.video.GET('/v1/videos/{video_id}', {
          params: { path: { video_id: notification.video_id } },
        });
        if (response.ok && data) {
          return data;
        }
        return null; // Gracefully handles 404/deleted videos without error state
      } catch {
        return null;
      }
    },
    enabled: !!notification.video_id,
    staleTime: 5 * 60 * 1000, // 5 min cache
    retry: false,
  });

  const targetUrl = getNotificationUrl(notification);

  const handleClick = () => {
    if (onItemClick) {
      onItemClick(notification);
    }
  };

  const actorName = notification.actor.display_name || notification.actor.handle;
  let notificationText = '';
  switch (notification.kind) {
    case 'VIDEO_PUBLISHED':
      notificationText = t('kinds.VIDEO_PUBLISHED', { actor: actorName });
      break;
    case 'VIDEO_COMMENT':
      notificationText = t('kinds.VIDEO_COMMENT', { actor: actorName });
      break;
    case 'COMMENT_REPLY':
      notificationText = t('kinds.COMMENT_REPLY', { actor: actorName });
      break;
    case 'NEW_SUBSCRIBER':
      notificationText = t('kinds.NEW_SUBSCRIBER', { actor: actorName });
      break;
    default:
      notificationText = actorName;
  }

  return (
    <Link
      href={targetUrl}
      onClick={handleClick}
      tabIndex={0}
      data-testid={`notification-item-${notification.id}`}
      data-unread={isUnread ? 'true' : 'false'}
      className={`flex items-start gap-3 p-3 rounded-xl transition cursor-pointer select-none ${
        isUnread
          ? 'bg-blue-50/70 dark:bg-blue-950/30 hover:bg-blue-100/70 dark:hover:bg-blue-900/40'
          : 'hover:bg-gray-100 dark:hover:bg-[#272727]'
      } ${className}`}
    >
      {/* Actor avatar */}
      <div className="shrink-0 relative">
        {notification.actor.avatar_url ? (
          <img
            src={notification.actor.avatar_url}
            alt={notification.actor.display_name}
            className="h-10 w-10 rounded-full object-cover"
          />
        ) : (
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-red-600 text-white font-bold text-sm">
            {notification.actor.display_name?.charAt(0) || 'U'}
          </div>
        )}
      </div>

      {/* Message content */}
      <div className="flex-1 min-w-0 pr-1">
        <p
          className={`text-xs sm:text-sm leading-snug line-clamp-2 ${
            isUnread
              ? 'font-semibold text-gray-900 dark:text-white'
              : 'font-normal text-gray-700 dark:text-gray-300'
          }`}
        >
          {notificationText}
        </p>

        {/* Video title snippet if available */}
        {videoData?.title && (
          <p
            className="text-xs text-gray-500 dark:text-gray-400 truncate mt-0.5 font-medium"
            title={videoData.title}
          >
            &quot;{videoData.title}&quot;
          </p>
        )}

        {/* Timestamp */}
        <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-1">
          {formatRelativeTime(notification.created_at)}
        </p>
      </div>

      {/* Unread indicator: not by color only (circle dot + aria-label) */}
      {isUnread && (
        <span
          className="h-2.5 w-2.5 rounded-full bg-blue-600 dark:bg-blue-400 shrink-0 mt-1.5"
          aria-label={t('unreadBadge')}
          title={t('unreadBadge')}
        />
      )}
    </Link>
  );
}
