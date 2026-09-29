'use client';

import React, { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter, usePathname } from '../../i18n/routing';
import { useAuth } from '../../lib/auth/auth-context';
import { api } from '../../lib/api-client';

export interface SubscribeButtonProps {
  channelId: string;
  initialSubscriberCount?: number;
  className?: string;
  onSubscriberCountChange?: (newCount: number) => void;
}

export function SubscribeButton({
  channelId,
  initialSubscriberCount = 0,
  className = '',
  onSubscriberCountChange,
}: SubscribeButtonProps) {
  const t = useTranslations('social');
  const router = useRouter();
  const pathname = usePathname();
  const { user, isAuthenticated } = useAuth();

  const [subscribed, setSubscribed] = useState<boolean>(false);
  const [subscriberCount, setSubscriberCount] = useState<number>(initialSubscriberCount);
  const [isPending, setIsPending] = useState<boolean>(false);

  // Hide the subscribe button if viewing own channel
  const isOwnChannel = Boolean(user && user.id === channelId);

  useEffect(() => {
    let isMounted = true;
    async function fetchSubscriptionState() {
      try {
        const { data, response } = await api.social.GET('/v1/channels/{channel_id}/subscription', {
          params: { path: { channel_id: channelId } },
        });
        if (response.ok && data && isMounted) {
          setSubscribed(data.subscribed);
          setSubscriberCount(data.subscriber_count);
          if (onSubscriberCountChange) {
            onSubscriberCountChange(data.subscriber_count);
          }
        }
      } catch {
        // Keep initial fallback state
      }
    }

    if (channelId) {
      fetchSubscriptionState();
    }
    return () => {
      isMounted = false;
    };
  }, [channelId, onSubscriberCountChange]);

  if (isOwnChannel) {
    return null;
  }

  const handleToggleSubscribe = async () => {
    if (!isAuthenticated) {
      router.push(`/login?returnTo=${encodeURIComponent(pathname)}`);
      return;
    }

    if (isPending) return;

    const previousSubscribed = subscribed;
    const previousCount = subscriberCount;

    // Optimistic toggle
    const nextSubscribed = !subscribed;
    const nextCount = nextSubscribed ? previousCount + 1 : Math.max(0, previousCount - 1);
    setSubscribed(nextSubscribed);
    setSubscriberCount(nextCount);
    if (onSubscriberCountChange) {
      onSubscriberCountChange(nextCount);
    }
    setIsPending(true);

    try {
      if (nextSubscribed) {
        const { data, response } = await api.social.PUT('/v1/channels/{channel_id}/subscription', {
          params: { path: { channel_id: channelId } },
        });
        if (!response.ok || !data) {
          // Rollback
          setSubscribed(previousSubscribed);
          setSubscriberCount(previousCount);
          if (onSubscriberCountChange) onSubscriberCountChange(previousCount);
        } else {
          setSubscribed(data.subscribed);
          setSubscriberCount(data.subscriber_count);
          if (onSubscriberCountChange) onSubscriberCountChange(data.subscriber_count);
        }
      } else {
        const { data, response } = await api.social.DELETE(
          '/v1/channels/{channel_id}/subscription',
          {
            params: { path: { channel_id: channelId } },
          },
        );
        if (!response.ok || !data) {
          // Rollback
          setSubscribed(previousSubscribed);
          setSubscriberCount(previousCount);
          if (onSubscriberCountChange) onSubscriberCountChange(previousCount);
        } else {
          setSubscribed(data.subscribed);
          setSubscriberCount(data.subscriber_count);
          if (onSubscriberCountChange) onSubscriberCountChange(data.subscriber_count);
        }
      }
    } catch {
      // Rollback on exception
      setSubscribed(previousSubscribed);
      setSubscriberCount(previousCount);
      if (onSubscriberCountChange) onSubscriberCountChange(previousCount);
    } finally {
      setIsPending(false);
    }
  };

  return (
    <button
      type="button"
      onClick={handleToggleSubscribe}
      aria-label={subscribed ? t('subscribed') : t('subscribe')}
      aria-pressed={subscribed}
      className={`rounded-full px-4 py-2 text-xs font-semibold transition active:scale-95 focus:outline-none focus:ring-2 focus:ring-red-600 ${
        subscribed
          ? 'bg-[#272727] dark:bg-[#272727] bg-gray-200 text-gray-800 dark:text-gray-300 hover:bg-[#383838]'
          : 'bg-red-600 text-white hover:bg-red-700'
      } ${className}`}
    >
      {subscribed ? t('subscribed') : t('subscribe')}
    </button>
  );
}
