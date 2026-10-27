'use client';

import React, { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter, usePathname } from '../../i18n/routing';
import { useAuth } from '../../lib/auth/auth-context';
import { api } from '../../lib/api-client';

export interface SubscribeButtonProps {
  channelId: string;
  initialSubscriberCount?: number;
  initialRequested?: boolean;
  isBlocked?: boolean;
  mode?: 'subscribe' | 'follow';
  className?: string;
  onSubscriberCountChange?: (newCount: number) => void;
  onStatusChange?: (status: { subscribed: boolean; requested: boolean }) => void;
}

export function SubscribeButton({
  channelId,
  initialSubscriberCount = 0,
  initialRequested = false,
  isBlocked = false,
  mode = 'subscribe',
  className = '',
  onSubscriberCountChange,
  onStatusChange,
}: SubscribeButtonProps) {
  const t = useTranslations('social');
  const router = useRouter();
  const pathname = usePathname();
  const { user, isAuthenticated } = useAuth();
  let queryClient: ReturnType<typeof useQueryClient> | null = null;
  try {
    queryClient = useQueryClient();
  } catch {
    queryClient = null;
  }

  const [subscribed, setSubscribed] = useState<boolean>(false);
  const [requested, setRequested] = useState<boolean>(initialRequested);
  const [subscriberCount, setSubscriberCount] = useState<number>(initialSubscriberCount);
  const [isPending, setIsPending] = useState<boolean>(false);

  // Hide the follow button if viewing own channel or blocked
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
          setRequested(Boolean(data.requested));
          setSubscriberCount(data.subscriber_count);
          if (onSubscriberCountChange) {
            onSubscriberCountChange(data.subscriber_count);
          }
          if (onStatusChange) {
            onStatusChange({
              subscribed: data.subscribed,
              requested: Boolean(data.requested),
            });
          }
        }
      } catch {
        // Keep initial fallback state
      }
    }

    if (channelId && !isBlocked && !isOwnChannel) {
      fetchSubscriptionState();
    }
    return () => {
      isMounted = false;
    };
  }, [channelId, isBlocked, isOwnChannel, onSubscriberCountChange, onStatusChange]);

  if (isOwnChannel || isBlocked) {
    return null;
  }

  const handleToggleSubscribe = async () => {
    if (!isAuthenticated) {
      router.push(`/login?returnTo=${encodeURIComponent(pathname)}`);
      return;
    }

    if (isPending) return;

    const prevSubscribed = subscribed;
    const prevRequested = requested;
    const prevCount = subscriberCount;

    setIsPending(true);

    if (subscribed || requested) {
      // Unsubscribe or cancel pending request
      setSubscribed(false);
      setRequested(false);
      if (prevSubscribed) {
        setSubscriberCount(Math.max(0, prevCount - 1));
        if (onSubscriberCountChange) onSubscriberCountChange(Math.max(0, prevCount - 1));
      }
      if (onStatusChange) onStatusChange({ subscribed: false, requested: false });

      try {
        const { response } = await api.social.DELETE('/v1/channels/{channel_id}/subscription', {
          params: { path: { channel_id: channelId } },
        });
        if (!response.ok) {
          // Rollback
          setSubscribed(prevSubscribed);
          setRequested(prevRequested);
          setSubscriberCount(prevCount);
          if (onSubscriberCountChange) onSubscriberCountChange(prevCount);
          if (onStatusChange)
            onStatusChange({ subscribed: prevSubscribed, requested: prevRequested });
        } else {
          queryClient?.invalidateQueries({ queryKey: ['feed', 'subscriptions'] });
        }
      } catch {
        setSubscribed(prevSubscribed);
        setRequested(prevRequested);
        setSubscriberCount(prevCount);
        if (onSubscriberCountChange) onSubscriberCountChange(prevCount);
        if (onStatusChange)
          onStatusChange({ subscribed: prevSubscribed, requested: prevRequested });
      } finally {
        setIsPending(false);
      }
    } else {
      // Optimistic subscribe
      setSubscribed(true);
      setSubscriberCount(prevCount + 1);
      if (onSubscriberCountChange) onSubscriberCountChange(prevCount + 1);
      if (onStatusChange) onStatusChange({ subscribed: true, requested: false });

      // Subscribe / Follow
      try {
        const { data, response } = await api.social.PUT('/v1/channels/{channel_id}/subscription', {
          params: { path: { channel_id: channelId } },
        });

        if (response.ok && data) {
          setSubscribed(data.subscribed);
          setRequested(Boolean(data.requested));
          setSubscriberCount(data.subscriber_count);
          if (onSubscriberCountChange) onSubscriberCountChange(data.subscriber_count);
          if (onStatusChange) {
            onStatusChange({
              subscribed: data.subscribed,
              requested: Boolean(data.requested),
            });
          }
          queryClient?.invalidateQueries({ queryKey: ['feed', 'subscriptions'] });
        } else {
          // Rollback
          setSubscribed(prevSubscribed);
          setRequested(prevRequested);
          setSubscriberCount(prevCount);
          if (onSubscriberCountChange) onSubscriberCountChange(prevCount);
          if (onStatusChange)
            onStatusChange({ subscribed: prevSubscribed, requested: prevRequested });
        }
      } catch {
        setSubscribed(prevSubscribed);
        setRequested(prevRequested);
        setSubscriberCount(prevCount);
        if (onSubscriberCountChange) onSubscriberCountChange(prevCount);
        if (onStatusChange)
          onStatusChange({ subscribed: prevSubscribed, requested: prevRequested });
      } finally {
        setIsPending(false);
      }
    }
  };

  // Button label according to mode and state
  const buttonLabel =
    mode === 'follow'
      ? subscribed
        ? 'Đang theo dõi'
        : requested
          ? 'Đã yêu cầu'
          : 'Theo dõi'
      : subscribed
        ? t('subscribed')
        : requested
          ? 'Đã yêu cầu'
          : t('subscribe');

  return (
    <button
      type="button"
      onClick={handleToggleSubscribe}
      aria-label={buttonLabel}
      aria-pressed={subscribed}
      className={`inline-flex h-10 shrink-0 whitespace-nowrap items-center justify-center rounded-full px-5 text-xs font-semibold transition active:scale-95 focus:outline-none focus:ring-2 focus:ring-red-600 ${
        subscribed
          ? 'bg-[#272727] dark:bg-[#272727] bg-gray-200 text-gray-800 dark:text-gray-300 hover:bg-[#383838]'
          : requested
            ? 'bg-amber-600/20 text-amber-500 border border-amber-500/40 hover:bg-amber-600/30'
            : 'bg-[#D9002B] text-white hover:bg-[#B80024]'
      } ${className}`}
    >
      {buttonLabel}
    </button>
  );
}
