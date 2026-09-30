'use client';

import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useRef,
  useMemo,
  type ReactNode,
} from 'react';
import { useTranslations } from 'next-intl';
import { useAuth } from '../auth/auth-context';
import { useToast } from '../../components/ui/toast';
import { api } from '../api-client';
import { RealtimeClient, type RoomEventHandler, type ReconnectHandler } from './realtime-client';
import type { ServerEventMessage } from './realtime-types';

interface RealtimeContextType {
  client: RealtimeClient;
  isConnected: boolean;
}

const RealtimeContext = createContext<RealtimeContextType | undefined>(undefined);

export interface RealtimeProviderProps {
  children: ReactNode;
  client?: RealtimeClient;
}

export function RealtimeProvider({ children, client: customClient }: RealtimeProviderProps) {
  const { isAuthenticated, user } = useAuth();
  const { showToast } = useToast();
  const t = useTranslations('social');

  // Maintain stable reference to isAuthenticated in ref
  const isAuthRef = useRef(isAuthenticated);
  isAuthRef.current = isAuthenticated;

  const client = useMemo(() => {
    if (customClient) return customClient;

    return new RealtimeClient({
      requestTicket: async () => {
        if (!isAuthRef.current) return null;
        try {
          const { data, response } = await api.realtime.POST('/v1/realtime/ticket');
          if (response.ok && data?.ticket) {
            return data.ticket;
          }
        } catch {
          return null;
        }
        return null;
      },
    });
  }, [customClient]);

  const [isConnected, setIsConnected] = useState<boolean>(client.getIsConnected());

  // Subscribe to connection status changes
  useEffect(() => {
    const unsubStatus = client.onStatusChange((connected) => {
      setIsConnected(connected);
    });
    return () => {
      unsubStatus();
    };
  }, [client]);

  // Handle session changes (sign-in / sign-out)
  const prevAuthRef = useRef<boolean>(isAuthenticated);
  useEffect(() => {
    if (prevAuthRef.current !== isAuthenticated) {
      prevAuthRef.current = isAuthenticated;
      client.handleAuthChange();
    }
  }, [isAuthenticated, client]);

  // Handle user:{me} notifications (video.ready, comment.reply)
  useEffect(() => {
    if (!isAuthenticated || !user) return;

    const unsubUserEvents = client.onUserEvent((event: ServerEventMessage) => {
      if (event.event === 'video.ready') {
        const videoId = event.data.video_id;
        showToast({
          title: t('videoReadyToastTitle') || 'Video của bạn đã sẵn sàng',
          description:
            t('videoReadyToastDesc') || 'Quá trình mã hóa hoàn tất. Bạn có thể xem ngay.',
          link: `/watch/${videoId}`,
          linkLabel: t('viewVideo') || 'Xem video',
          type: 'success',
        });
      } else if (event.event === 'comment.reply') {
        const videoId = event.data.video_id;
        showToast({
          title: t('commentReplyToastTitle') || 'Có phản hồi mới',
          description: t('commentReplyToastDesc') || 'Có người vừa trả lời bình luận của bạn.',
          link: `/watch/${videoId}`,
          linkLabel: t('viewVideo') || 'Xem ngay',
          type: 'info',
        });
      }
    });

    return () => {
      unsubUserEvents();
    };
  }, [client, isAuthenticated, user, showToast, t]);

  // Clean up client on unmount
  useEffect(() => {
    return () => {
      // Disconnect only if client was internally created
      if (!customClient) {
        client.disconnect();
      }
    };
  }, [client, customClient]);

  const contextValue = useMemo(() => ({ client, isConnected }), [client, isConnected]);

  return <RealtimeContext.Provider value={contextValue}>{children}</RealtimeContext.Provider>;
}

export function useRealtime() {
  const context = useContext(RealtimeContext);
  if (!context) {
    throw new Error('useRealtime must be used within a RealtimeProvider');
  }
  return context;
}

export function useOptionalRealtime() {
  return useContext(RealtimeContext);
}

/**
 * Hook to subscribe to a realtime room with ref-counting.
 * Calls onEvent when an event arrives for this room.
 * Calls onReconnect when the socket reconnects, prompting consumer to refetch REST state.
 */
export function useRealtimeRoom(
  room: string | null | undefined,
  onEvent: RoomEventHandler,
  onReconnect?: ReconnectHandler,
) {
  const context = useContext(RealtimeContext);
  const client = context?.client;
  const isConnected = context?.isConnected ?? false;

  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  const onReconnectRef = useRef(onReconnect);
  onReconnectRef.current = onReconnect;

  useEffect(() => {
    if (!client || !room) return;

    const eventHandler: RoomEventHandler = (evt) => {
      onEventRef.current?.(evt);
    };

    const reconnectHandler: ReconnectHandler = () => {
      onReconnectRef.current?.();
    };

    const unsubscribe = client.subscribe(room, eventHandler, reconnectHandler);

    return () => {
      unsubscribe();
    };
  }, [client, room]);

  return { isConnected };
}
