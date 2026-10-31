'use client';

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react';
import type { Conversation } from '@winkey/api-client';
import { useAuth } from '../../lib/auth/auth-context';
import { useRealtimeRoom } from '../../lib/realtime/realtime-context';
import { getChatService } from '../../lib/e2ee/chat-service';
import { DB_NAME } from '../../lib/e2ee/storage';
import { CallManager, type CallSnapshot } from '../../lib/calls/call-manager';
import { CALL_LIFETIME_MS } from '../../lib/calls/events';
import { IncomingCallOverlay } from './incoming-call-overlay';
import { InCallScreen } from './in-call-screen';

interface CallContextValue {
  manager: CallManager | null;
  snapshot: CallSnapshot | null;
}

const CallContext = createContext<CallContextValue>({ manager: null, snapshot: null });

export function useCalls(): CallContextValue {
  return useContext(CallContext);
}

const EMPTY = (): (() => void) => () => {};

/** Only browsers that already have an E2EE device take part in calls: no page creates chat devices as a side effect. */
async function hasLocalChatDevice(): Promise<boolean> {
  try {
    const dbs = await indexedDB.databases?.();
    return Array.isArray(dbs) ? dbs.some((d) => d.name === DB_NAME) : false;
  } catch {
    return false;
  }
}

/**
 * SOC-4a: call signaling on every page while the tab is open. Listens to `chat.hint` on the user's room, reads new
 * call events of the conversation the hint names, and passes them (plus to-device call events) to the CallManager.
 */
export function CallProvider({ children }: { children: React.ReactNode }) {
  const { user, isAuthenticated } = useAuth();
  const manager = useMemo(() => (user?.id ? new CallManager(user.id) : null), [user?.id]);
  const snapshot = useSyncExternalStore(
    manager?.subscribe ?? EMPTY,
    () => manager?.getSnapshot() ?? null,
    () => null,
  );
  const ready = useRef(false);
  const lastSeq = useRef(new Map<string, number>());
  const conversations = useRef(new Map<string, Conversation>());

  useEffect(() => {
    if (!manager || !isAuthenticated || !user?.id) return;
    let live = true;
    const chat = getChatService();
    const unsubscribe = chat.onCallSignal((signal) => void manager.handleDeviceEvent(signal));
    void (async () => {
      if (!(await hasLocalChatDevice())) return;
      await chat.ensureReady(user.id);
      if (!live) return;
      ready.current = true;
      await chat.processToDeviceMessages();
    })().catch(() => {});
    return () => {
      live = false;
      unsubscribe();
    };
  }, [manager, isAuthenticated, user?.id]);

  const scanConversation = useCallback(
    async (conversationId: string) => {
      if (!manager || !ready.current) return;
      const chat = getChatService();
      let conversation = conversations.current.get(conversationId);
      if (!conversation) {
        conversation = await chat.getConversation(conversationId);
        conversations.current.set(conversationId, conversation);
      }
      if (conversation.kind !== 'DIRECT') return;
      const after = lastSeq.current.get(conversationId);
      const page = await chat.fetchMessages(
        conversationId,
        after !== undefined ? { after_seq: after, limit: 50 } : { limit: 10 },
      );
      for (const item of page.items) {
        lastSeq.current.set(
          conversationId,
          Math.max(lastSeq.current.get(conversationId) ?? 0, item.message.seq),
        );
        if (item.status !== 'CALL' || !item.callEvent || !item.message.sender_id) continue;
        const age = Date.now() - new Date(item.message.created_at).getTime();
        await manager.handleRoomEvent({
          event: item.callEvent,
          senderId: item.message.sender_id,
          senderDeviceId: item.message.sender_device_id ?? '',
          conversation,
          conversationId,
          sentAt: item.message.created_at,
          seq: item.message.seq,
          fresh: age < CALL_LIFETIME_MS,
        });
      }
    },
    [manager],
  );

  useRealtimeRoom(
    user?.id ? `user:${user.id}` : null,
    useCallback(
      (evt) => {
        if (evt.event !== 'chat.hint') return;
        const hint = evt.data as { kind?: string; conversation_id?: string };
        if (hint.kind === 'MESSAGE' && hint.conversation_id) {
          void scanConversation(hint.conversation_id).catch(() => {});
        } else if (hint.kind === 'TO_DEVICE' && ready.current) {
          void getChatService().processToDeviceMessages();
        } else if (hint.kind === 'CONVERSATION' && hint.conversation_id) {
          conversations.current.delete(hint.conversation_id);
        }
      },
      [scanConversation],
    ),
    useCallback(() => {
      if (ready.current) void getChatService().processToDeviceMessages();
    }, []),
  );

  const value = useMemo(() => ({ manager, snapshot }), [manager, snapshot]);

  return (
    <CallContext.Provider value={value}>
      {children}
      {manager && snapshot && snapshot.state.status === 'ringing' && (
        <IncomingCallOverlay manager={manager} snapshot={snapshot} />
      )}
      {manager &&
        snapshot &&
        (snapshot.state.status === 'calling' ||
          snapshot.state.status === 'connecting' ||
          snapshot.state.status === 'connected' ||
          snapshot.state.status === 'ended') && (
          <InCallScreen manager={manager} snapshot={snapshot} />
        )}
    </CallContext.Provider>
  );
}
