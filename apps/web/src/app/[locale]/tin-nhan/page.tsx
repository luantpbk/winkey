'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams } from 'next/navigation';
import { useRouter } from '../../../i18n/routing';
import { useAuth } from '../../../lib/auth/auth-context';
import { getChatService } from '../../../lib/e2ee/chat-service';
import { ConversationList } from '../../../components/chat/conversation-list';
import { ConversationView } from '../../../components/chat/conversation-view';
import { NewChatDialog } from '../../../components/chat/new-chat-dialog';
import { useRealtimeRoom } from '../../../lib/realtime/realtime-context';
import type { Conversation } from '@winkey/api-client';
import { MessageSquare, History } from 'lucide-react';
import { getKeyBackupService } from '../../../lib/e2ee/key-backup-service';
import { BackupRestoreDialog } from '../../../components/chat/key-backup-dialogs';

export default function ChatPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, isAuthenticated, isLoading: authLoading } = useAuth();
  // "Nhắn tin" on a profile links here with ?to=<user_id> (SOC-6a): open or create that DIRECT conversation.
  const directTarget = searchParams?.get('to') ?? null;
  const handledTarget = useRef<string | null>(null);
  const [directError, setDirectError] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<'ACTIVE' | 'REQUESTED'>('ACTIVE');
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [requestsCount, setRequestsCount] = useState<number>(0);
  const [activeConversation, setActiveConversation] = useState<Conversation | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isInitializingDevice, setIsInitializingDevice] = useState(false);
  const [newChatDialogOpen, setNewChatDialogOpen] = useState(false);
  const [realtimeVersion, setRealtimeVersion] = useState(0);
  // SOC-3b: a backup exists but this device has not unlocked it → offer "Khôi phục lịch sử".
  const [restoreOffered, setRestoreOffered] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);

  const chatService = getChatService();

  // Redirect if unauthenticated
  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      const returnTo = directTarget
        ? `/tin-nhan?to=${encodeURIComponent(directTarget)}`
        : '/tin-nhan';
      router.push(`/login?return_to=${encodeURIComponent(returnTo)}`);
    }
  }, [authLoading, isAuthenticated, router, directTarget]);

  // Ensure E2EE device registration
  useEffect(() => {
    if (isAuthenticated && user?.id) {
      setIsInitializingDevice(true);
      chatService
        .ensureReady(user.id)
        .then(() => {
          return chatService.processToDeviceMessages();
        })
        .then(() => {
          setRealtimeVersion((v) => v + 1);
          return checkBackupRestore();
        })
        .catch((err) => {
          console.warn('[ChatPage] Device initialization warning:', err);
        })
        .finally(() => {
          setIsInitializingDevice(false);
        });
    }
  }, [isAuthenticated, user?.id, chatService]);

  async function checkBackupRestore() {
    try {
      if (sessionStorage.getItem('wk_restore_dismissed') === '1') return;
    } catch {
      // storage unavailable: still offer
    }
    const service = getKeyBackupService();
    const [server, local] = await Promise.all([service.getServerBackup(), service.status()]);
    if (server && !(local.unlocked && local.version === server.version)) setRestoreOffered(true);
    else if (server) void service.uploadPending().catch(() => {});
  }

  useEffect(() => {
    if (!isAuthenticated || !user?.id || isInitializingDevice) return;
    if (!directTarget || handledTarget.current === directTarget) return;
    handledTarget.current = directTarget;
    if (
      directTarget === user.id ||
      !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(directTarget)
    ) {
      return;
    }
    chatService
      .createConversation({ kind: 'DIRECT', userIds: [directTarget] })
      .then((conv) => {
        setActiveTab(conv.my_state === 'REQUESTED' ? 'REQUESTED' : 'ACTIVE');
        setActiveConversation(conv);
        setDirectError(null);
        router.replace('/tin-nhan');
      })
      .catch((err: unknown) => {
        setDirectError(err instanceof Error ? err.message : 'Không thể mở cuộc trò chuyện.');
      });
  }, [isAuthenticated, user?.id, isInitializingDevice, directTarget, chatService, router]);

  const fetchConversationsList = useCallback(async () => {
    if (!isAuthenticated) return;
    setIsLoading(true);
    try {
      const [activePage, requestsPage] = await Promise.all([
        chatService.listConversations('ACTIVE'),
        chatService.listConversations('REQUESTED'),
      ]);

      setRequestsCount(requestsPage.items.length);
      setConversations(activeTab === 'ACTIVE' ? activePage.items : requestsPage.items);

      // If active conversation updated in list, update reference
      if (activeConversation) {
        const currentList = activeTab === 'ACTIVE' ? activePage.items : requestsPage.items;
        const matched = currentList.find((c) => c.id === activeConversation.id);
        if (matched) {
          setActiveConversation(matched);
        }
      }
    } catch (err) {
      console.error('[ChatPage] Failed to fetch conversations:', err);
    } finally {
      setIsLoading(false);
    }
  }, [isAuthenticated, activeTab, activeConversation, chatService]);

  useEffect(() => {
    fetchConversationsList();
  }, [activeTab, isAuthenticated]);

  // Realtime subscription to user room for chat.hint
  const userRoom = user?.id ? `user:${user.id}` : null;
  useRealtimeRoom(
    userRoom,
    useCallback(
      (evt) => {
        if (evt.event === 'chat.hint') {
          const hint = evt.data as any;
          if (hint.kind === 'TO_DEVICE') {
            chatService.processToDeviceMessages().then(() => {
              setRealtimeVersion((v) => v + 1);
            });
          } else if (hint.kind === 'MESSAGE') {
            fetchConversationsList();
            setRealtimeVersion((v) => v + 1);
          } else if (hint.kind === 'CONVERSATION' || hint.kind === 'DEVICES') {
            fetchConversationsList();
            setRealtimeVersion((v) => v + 1);
          }
        }
      },
      [chatService, fetchConversationsList],
    ),
    // On reconnect: refetch REST conversations and to-device messages
    useCallback(() => {
      fetchConversationsList();
      chatService.processToDeviceMessages().then(() => {
        setRealtimeVersion((v) => v + 1);
      });
    }, [fetchConversationsList, chatService]),
  );

  if (authLoading || !user) {
    return (
      <div className="min-h-[70vh] flex items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-red-500 border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="h-[calc(100vh-3.5rem)] max-w-7xl mx-auto flex overflow-hidden border-x border-zinc-200 dark:border-[#222222] bg-white dark:bg-[#121212]">
      {restoreOffered && (
        <div
          role="region"
          aria-label="Khôi phục lịch sử tin nhắn"
          className="fixed bottom-4 left-1/2 z-40 flex w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 items-center gap-3 rounded-2xl border border-zinc-200 bg-white p-3 text-xs shadow-xl dark:border-zinc-700 dark:bg-[#1c1c1c]"
        >
          <History className="h-5 w-5 shrink-0 text-red-500" aria-hidden="true" />
          <span className="flex-1 text-zinc-800 dark:text-zinc-200">
            Bạn có bản sao lưu tin nhắn. Khôi phục để đọc tin nhắn cũ trên thiết bị này.
          </span>
          <button
            type="button"
            onClick={() => setRestoreOpen(true)}
            className="shrink-0 rounded-lg bg-red-600 px-3 py-1.5 font-semibold text-white hover:bg-red-500"
          >
            Khôi phục lịch sử
          </button>
          <button
            type="button"
            onClick={() => {
              setRestoreOffered(false);
              try {
                sessionStorage.setItem('wk_restore_dismissed', '1');
              } catch {
                // ignore
              }
            }}
            className="shrink-0 rounded-lg px-2 py-1.5 text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
          >
            Để sau
          </button>
        </div>
      )}
      {restoreOpen && (
        <BackupRestoreDialog
          onClose={() => setRestoreOpen(false)}
          onRestored={() => {
            setRestoreOpen(false);
            setRestoreOffered(false);
            // Messages that waited for keys decrypt on the next load.
            fetchConversationsList();
            setRealtimeVersion((v) => v + 1);
          }}
        />
      )}

      {/* Sidebar: Conversation List */}
      <div
        className={`w-full md:w-80 lg:w-96 shrink-0 h-full ${
          activeConversation ? 'hidden md:flex md:flex-col' : 'flex flex-col'
        }`}
      >
        <ConversationList
          conversations={conversations}
          activeConversationId={activeConversation?.id || null}
          activeTab={activeTab}
          onTabChange={(tab) => {
            setActiveTab(tab);
            setActiveConversation(null);
          }}
          onSelectConversation={(conv) => setActiveConversation(conv)}
          onOpenNewChat={() => setNewChatDialogOpen(true)}
          currentUserId={user.id}
          requestsCount={requestsCount}
          isLoading={isLoading || isInitializingDevice}
        />
      </div>

      {/* Main Area: Conversation View */}
      <div
        className={`flex-1 h-full flex-col min-w-0 ${
          activeConversation ? 'flex' : 'hidden md:flex'
        }`}
      >
        {directError && !activeConversation && (
          <div
            role="alert"
            className="m-4 p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-xs text-red-600 dark:text-red-400"
          >
            {directError}
          </div>
        )}
        {activeConversation ? (
          <ConversationView
            conversation={activeConversation}
            currentUserId={user.id}
            realtimeVersion={realtimeVersion}
            onBackMobile={() => setActiveConversation(null)}
            onConversationUpdated={(updated) => {
              setActiveConversation(updated);
              setConversations((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
            }}
            onConversationLeft={() => {
              setActiveConversation(null);
              fetchConversationsList();
            }}
          />
        ) : (
          <div className="h-full flex flex-col items-center justify-center text-center p-8 space-y-3 bg-zinc-50 dark:bg-[#0d0d0d]">
            <div className="p-4 rounded-3xl bg-zinc-200/50 dark:bg-zinc-800/50 text-zinc-400">
              <MessageSquare className="h-10 w-10" />
            </div>
            <h3 className="text-base font-semibold text-zinc-900 dark:text-white">
              Chọn cuộc trò chuyện
            </h3>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 max-w-xs">
              Chọn một người liên hệ từ danh sách bên trái hoặc tạo cuộc trò chuyện mới để bắt đầu
              nhắn tin bảo mật.
            </p>
          </div>
        )}
      </div>

      {/* New Chat Dialog */}
      <NewChatDialog
        isOpen={newChatDialogOpen}
        onClose={() => setNewChatDialogOpen(false)}
        onCreated={(newConv) => {
          setActiveTab(newConv.my_state === 'REQUESTED' ? 'REQUESTED' : 'ACTIVE');
          setActiveConversation(newConv);
          fetchConversationsList();
        }}
      />
    </div>
  );
}
