'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  ShieldCheck,
  MoreVertical,
  Send,
  ArrowLeft,
  AlertTriangle,
  RefreshCw,
  Trash2,
  Lock,
  Users,
  User,
} from 'lucide-react';
import { getChatService, type DecryptedMessageItem } from '../../lib/e2ee/chat-service';
import { SafetyNumberDialog } from './safety-number-dialog';
import { GroupSettingsDialog } from './group-settings-dialog';
import type { Conversation } from '@winkey/api-client';

interface ConversationViewProps {
  conversation: Conversation;
  currentUserId: string;
  realtimeVersion?: number;
  onBackMobile?: () => void;
  onConversationUpdated: (conversation: Conversation) => void;
  onConversationLeft: () => void;
}

export function ConversationView({
  conversation,
  currentUserId,
  realtimeVersion,
  onBackMobile,
  onConversationUpdated,
  onConversationLeft,
}: ConversationViewProps) {
  const [messages, setMessages] = useState<DecryptedMessageItem[]>([]);
  const [isLoadingMessages, setIsLoadingMessages] = useState(true);
  const [inputText, setInputText] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [warningBanner, _setWarningBanner] = useState<string | null>(null);

  const [safetyDialogOpen, setSafetyDialogOpen] = useState(false);
  const [groupSettingsOpen, setGroupSettingsOpen] = useState(false);

  const [peerEdKey, setPeerEdKey] = useState<string>('');
  const [myEdKey, setMyEdKey] = useState<string>('');

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const chatService = getChatService();

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView?.({ behavior: 'smooth' });
  };

  const loadMessages = useCallback(async () => {
    setIsLoadingMessages(true);
    setErrorMessage(null);
    try {
      const { items } = await chatService.fetchMessages(conversation.id, { limit: 100 });
      setMessages(items);

      // Mark as read
      if (conversation.last_seq > 0) {
        await chatService.markRead(conversation.id, conversation.last_seq);
      }
    } catch (err: any) {
      setErrorMessage(err?.message || 'Không thể tải tin nhắn.');
    } finally {
      setIsLoadingMessages(false);
    }
  }, [conversation.id, conversation.last_seq, chatService]);

  useEffect(() => {
    loadMessages();
  }, [loadMessages, realtimeVersion]);

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // Load identity keys for Safety Number
  useEffect(() => {
    (async () => {
      try {
        const { api } = await import('../../lib/api-client');
        const peer = conversation.members.find((m) => m.user_id !== currentUserId);
        const userIds = [currentUserId];
        if (peer) userIds.push(peer.user_id);

        const { data } = await api.chat.POST('/v1/chat/devices/query', {
          body: { user_ids: userIds },
        });

        if (data?.users) {
          const myUser = data.users.find((u) => u.user_id === currentUserId);
          const peerUser = peer ? data.users.find((u) => u.user_id === peer.user_id) : null;

          if (myUser?.devices[0]) {
            setMyEdKey(myUser.devices[0].ed25519_key);
          }
          if (peerUser?.devices[0]) {
            setPeerEdKey(peerUser.devices[0].ed25519_key);
          }
        }
      } catch (err) {
        console.warn('Failed to load device keys for safety number:', err);
      }
    })();
  }, [conversation, currentUserId]);

  const handleSendMessage = async (e?: React.FormEvent, retryClientMsgId?: string) => {
    if (e) e.preventDefault();
    const textToSend = inputText.trim();
    if (!textToSend || isSending) return;

    setIsSending(true);
    setErrorMessage(null);

    try {
      const sentItem = await chatService.sendMessage({
        conversation,
        text: textToSend,
        clientMsgId: retryClientMsgId,
      });

      setMessages((prev) => [...prev, sentItem]);
      setInputText('');

      // Update conversation last_seq in parent
      onConversationUpdated({
        ...conversation,
        last_seq: sentItem.message.seq,
        last_message_at: sentItem.message.created_at,
      });
    } catch (err: any) {
      setErrorMessage(err?.message || 'Không thể gửi tin nhắn.');
    } finally {
      setIsSending(false);
    }
  };

  const handleDeleteMessage = async (seq: number) => {
    if (!window.confirm('Bạn có chắc chắn muốn xoá tin nhắn này cho mọi người?')) {
      return;
    }

    try {
      await chatService.deleteMessage(conversation.id, seq);
      setMessages((prev) =>
        prev.map((item) =>
          item.message.seq === seq ? { ...item, status: 'DELETED', plaintext: null } : item,
        ),
      );
    } catch (err: any) {
      setErrorMessage(err?.message || 'Không thể xoá tin nhắn.');
    }
  };

  const handleAcceptRequest = async () => {
    try {
      const updated = await chatService.acceptConversation(conversation.id);
      onConversationUpdated(updated);
      await loadMessages();
    } catch (err: any) {
      setErrorMessage(err?.message || 'Không thể chấp nhận lời mời.');
    }
  };

  const handleDeclineRequest = async () => {
    if (!window.confirm('Bạn có chắc chắn muốn từ chối lời mời nhắn tin này?')) {
      return;
    }
    try {
      await chatService.leaveOrRemoveMember(conversation.id, currentUserId);
      onConversationLeft();
    } catch (err: any) {
      setErrorMessage(err?.message || 'Không thể từ chối lời mời.');
    }
  };

  const getTitle = () => {
    if (conversation.kind === 'GROUP') {
      return conversation.title || 'Nhóm không tên';
    }
    const peer = conversation.members.find((m) => m.user_id !== currentUserId);
    return peer?.user?.display_name || peer?.user?.handle || 'Người dùng Winkey';
  };

  const peer = conversation.members.find((m) => m.user_id !== currentUserId);
  const isRequested = conversation.my_state === 'REQUESTED';

  return (
    <div className="flex flex-col h-full bg-zinc-50 dark:bg-[#0f0f0f]">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-white dark:bg-[#141414] border-b border-zinc-200 dark:border-[#222222] shadow-sm shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          {onBackMobile && (
            <button
              type="button"
              onClick={onBackMobile}
              className="md:hidden p-1.5 -ml-1 rounded-lg text-zinc-500 hover:text-zinc-900 dark:hover:text-white"
            >
              <ArrowLeft className="h-5 w-5" />
            </button>
          )}

          <div className="relative shrink-0">
            {peer?.user?.avatar_url ? (
              <img
                src={peer.user.avatar_url}
                alt={getTitle()}
                className="h-9 w-9 rounded-full object-cover border border-zinc-200 dark:border-zinc-800"
              />
            ) : (
              <div className="h-9 w-9 rounded-full bg-zinc-200 dark:bg-zinc-800 flex items-center justify-center font-bold text-xs text-zinc-700 dark:text-zinc-300">
                {conversation.kind === 'GROUP' ? (
                  <Users className="h-4 w-4" />
                ) : (
                  <User className="h-4 w-4" />
                )}
              </div>
            )}
          </div>

          <div className="min-w-0">
            <h2 className="text-sm font-bold text-zinc-900 dark:text-white truncate">
              {getTitle()}
            </h2>
            <div className="flex items-center gap-1.5 text-[11px] text-emerald-600 dark:text-emerald-400">
              <Lock className="h-3 w-3" />
              <span>Được mã hoá đầu cuối</span>
            </div>
          </div>
        </div>

        {/* Header Actions */}
        <div className="flex items-center gap-1 shrink-0">
          {conversation.kind === 'DIRECT' && peerEdKey && myEdKey && (
            <button
              type="button"
              onClick={() => setSafetyDialogOpen(true)}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10 transition-colors"
              title="Xem mã số an toàn"
            >
              <ShieldCheck className="h-4 w-4" />
              <span className="hidden sm:inline">Mã an toàn</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => setGroupSettingsOpen(true)}
            className="p-2 rounded-lg text-zinc-500 hover:text-zinc-900 dark:hover:text-white hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
            title="Cài đặt trò chuyện"
          >
            <MoreVertical className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Warning banner for changed keys */}
      {warningBanner && (
        <div className="flex items-center gap-2 px-4 py-2 bg-amber-500/15 border-b border-amber-500/30 text-amber-700 dark:text-amber-300 text-xs shrink-0">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>{warningBanner}</span>
        </div>
      )}

      {/* Message Requests Banner */}
      {isRequested && (
        <div className="p-4 bg-red-50 dark:bg-red-950/20 border-b border-red-200 dark:border-red-900/30 flex flex-col sm:flex-row items-center justify-between gap-3 shrink-0">
          <div className="text-xs text-zinc-700 dark:text-zinc-300">
            <span className="font-semibold">{getTitle()}</span> muốn gửi tin nhắn cho bạn. Họ sẽ
            không biết bạn đã xem cho đến khi bạn chấp nhận.
          </div>
          <div className="flex items-center gap-2 self-end sm:self-auto shrink-0">
            <button
              type="button"
              onClick={handleDeclineRequest}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-800 transition-colors"
            >
              Từ chối
            </button>
            <button
              type="button"
              onClick={handleAcceptRequest}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-red-600 hover:bg-red-500 text-white transition-colors"
            >
              Chấp nhận
            </button>
          </div>
        </div>
      )}

      {/* Messages Scroll Area */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {isLoadingMessages ? (
          <div className="flex items-center justify-center py-16">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-red-500 border-t-transparent" />
          </div>
        ) : messages.length === 0 ? (
          <div className="text-center py-16 space-y-2">
            <div className="inline-flex p-3 rounded-full bg-emerald-500/10 text-emerald-500">
              <Lock className="h-6 w-6" />
            </div>
            <p className="text-xs font-semibold text-zinc-900 dark:text-white">
              Cuộc trò chuyện được mã hoá đầu cuối
            </p>
            <p className="text-[11px] text-zinc-500 max-w-sm mx-auto">
              Chỉ các thiết bị trong cuộc trò chuyện mới có khoá giải mã. Chưa có tin nhắn nào.
            </p>
          </div>
        ) : (
          messages.map((item) => {
            const isOwn = item.message.sender_id === currentUserId;
            const timeStr = new Date(item.message.created_at).toLocaleTimeString('vi-VN', {
              hour: '2-digit',
              minute: '2-digit',
            });

            // SYSTEM message
            if (item.status === 'SYSTEM') {
              let systemText = 'Thông báo hệ thống';
              const sys = item.message.system;
              if (sys?.type === 'conversation_created') systemText = 'Đoạn chat đã được tạo';
              else if (sys?.type === 'member_added')
                systemText = 'Thành viên mới đã được thêm vào nhóm';
              else if (sys?.type === 'member_left') systemText = 'Một thành viên đã rời khỏi nhóm';
              else if (sys?.type === 'member_removed')
                systemText = 'Một thành viên đã bị xoá khỏi nhóm';
              else if (sys?.type === 'request_accepted')
                systemText = 'Lời mời nhắn tin đã được chấp nhận';
              else if (sys?.type === 'title_changed')
                systemText = `Tên nhóm đã đổi thành "${sys.title}"`;
              else if (sys?.type === 'owner_changed') systemText = 'Chủ sở hữu nhóm đã thay đổi';

              return (
                <div key={item.message.id} className="flex justify-center my-2">
                  <span className="px-3 py-1 rounded-full bg-zinc-200/60 dark:bg-zinc-800/60 text-[11px] text-zinc-600 dark:text-zinc-400 font-medium">
                    {systemText}
                  </span>
                </div>
              );
            }

            // Deleted tombstone
            if (item.status === 'DELETED') {
              return (
                <div
                  key={item.message.id}
                  className={`flex ${isOwn ? 'justify-end' : 'justify-start'}`}
                >
                  <div className="max-w-[75%] px-3.5 py-2 rounded-2xl bg-zinc-100 dark:bg-[#1c1c1c] text-zinc-400 dark:text-zinc-500 text-xs italic border border-zinc-200/50 dark:border-zinc-800/50">
                    Tin nhắn đã bị thu hồi
                  </div>
                </div>
              );
            }

            // Waiting for key
            if (item.status === 'WAITING_FOR_KEY') {
              return (
                <div
                  key={item.message.id}
                  className={`flex ${isOwn ? 'justify-end' : 'justify-start'}`}
                >
                  <div className="max-w-[75%] px-3.5 py-2 rounded-2xl bg-amber-500/10 border border-amber-500/20 text-amber-600 dark:text-amber-400 text-xs flex items-center gap-2">
                    <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                    <span>Đang chờ khoá giải mã…</span>
                  </div>
                </div>
              );
            }

            // Normal decrypted message
            return (
              <div
                key={item.message.id}
                className={`flex flex-col ${isOwn ? 'items-end' : 'items-start'} group`}
              >
                <div
                  className={`relative max-w-[80%] sm:max-w-[70%] px-3.5 py-2.5 rounded-2xl text-sm leading-relaxed break-words shadow-sm ${
                    isOwn
                      ? 'bg-red-600 text-white rounded-br-xs'
                      : 'bg-white dark:bg-[#1e1e1e] text-zinc-900 dark:text-zinc-100 border border-zinc-200/60 dark:border-[#282828] rounded-bl-xs'
                  }`}
                >
                  {/* Text rendered strictly as text to prevent XSS */}
                  <div className="whitespace-pre-wrap select-text">
                    {item.status === 'UNSUPPORTED' ? 'Tin nhắn không hỗ trợ' : item.plaintext}
                  </div>

                  <div
                    className={`flex items-center justify-end gap-1.5 mt-1 text-[10px] ${
                      isOwn ? 'text-red-200' : 'text-zinc-400 dark:text-zinc-500'
                    }`}
                  >
                    <span>{timeStr}</span>
                    {isOwn && (
                      <button
                        type="button"
                        onClick={() => handleDeleteMessage(item.message.seq)}
                        className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 hover:text-white"
                        title="Thu hồi tin nhắn"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Error banner */}
      {errorMessage && (
        <div className="px-4 py-2 bg-red-500/10 border-t border-red-500/20 text-xs text-red-500 flex items-center justify-between shrink-0">
          <span>{errorMessage}</span>
          <button
            type="button"
            onClick={() => setErrorMessage(null)}
            className="text-red-400 hover:text-red-200"
          >
            ×
          </button>
        </div>
      )}

      {/* Composer */}
      <div className="p-3 bg-white dark:bg-[#141414] border-t border-zinc-200 dark:border-[#222222] shrink-0">
        <form onSubmit={handleSendMessage} className="flex items-end gap-2">
          <div className="flex-1 relative">
            <textarea
              rows={1}
              maxLength={4000}
              disabled={isRequested || isSending}
              placeholder={
                isRequested
                  ? 'Vui lòng chấp nhận lời mời để gửi tin nhắn'
                  : 'Nhập tin nhắn (Enter để gửi)...'
              }
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSendMessage();
                }
              }}
              className="w-full px-3.5 py-2.5 rounded-xl border border-zinc-200 dark:border-[#2c2c2c] bg-zinc-50 dark:bg-[#1a1a1a] text-sm text-zinc-900 dark:text-white placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-red-500 resize-none max-h-32 disabled:opacity-50 disabled:bg-zinc-100 dark:disabled:bg-zinc-900"
            />
          </div>

          <button
            type="submit"
            disabled={!inputText.trim() || isRequested || isSending}
            className="flex items-center justify-center p-2.5 rounded-xl bg-red-600 hover:bg-red-500 text-white transition-colors disabled:opacity-40 shrink-0"
          >
            {isSending ? (
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
            ) : (
              <Send className="h-4 w-4" />
            )}
          </button>
        </form>
      </div>

      {/* Safety Number Dialog */}
      <SafetyNumberDialog
        isOpen={safetyDialogOpen}
        onClose={() => setSafetyDialogOpen(false)}
        peerName={getTitle()}
        myEd25519Key={myEdKey}
        peerEd25519Key={peerEdKey}
      />

      {/* Group Settings Dialog */}
      <GroupSettingsDialog
        isOpen={groupSettingsOpen}
        onClose={() => setGroupSettingsOpen(false)}
        conversation={conversation}
        currentUserId={currentUserId}
        onUpdated={onConversationUpdated}
        onLeft={onConversationLeft}
      />
    </div>
  );
}
