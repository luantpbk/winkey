'use client';

import React, { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from 'react';
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
  Paperclip,
  X,
  Phone,
  Video,
  PhoneCall,
  ArrowDown,
  Check,
  CheckCheck,
  Clock,
} from 'lucide-react';
import { useCalls } from '../calls/call-provider';
import { CallManager } from '../../lib/calls/call-manager';
import { describeCallEvent, type CallMedia } from '../../lib/calls/events';
import { getChatService, type DecryptedMessageItem } from '../../lib/e2ee/chat-service';
import { SafetyNumberDialog } from './safety-number-dialog';
import { GroupSettingsDialog } from './group-settings-dialog';
import type { Conversation } from '@winkey/api-client';
import { AttachmentList } from './attachment-view';
import type { AttachmentRef } from '../../lib/e2ee/events';
import { MAX_ATTACHMENTS_PER_MESSAGE } from '../../lib/e2ee/events';
import {
  AttachmentError,
  formatBytes,
  prepareFile,
  uploadAttachment,
} from '../../lib/e2ee/attachments';
import { systemMessageText } from '../../lib/chat/message-text';
import {
  buildTimeline,
  formatMessageTime,
  mergeMessages,
  readReceipt,
  type OutgoingMessage,
} from '../../lib/chat/timeline';

const errorText = (err: unknown, fallback: string) =>
  err instanceof Error && err.message ? err.message : fallback;

/** Messages per page, both for the newest page and for each older page loaded when scrolling up. */
export const PAGE_SIZE = 50;
/** Within this distance of the bottom the view follows new messages and marks them read. */
const BOTTOM_SLACK_PX = 80;
/** Scrolling this close to the top loads the previous page. */
const TOP_LOAD_PX = 120;

function SenderAvatar({
  user,
  name,
}: {
  user: { avatar_url: string | null } | null;
  name: string;
}) {
  if (user?.avatar_url) {
    return <img src={user.avatar_url} alt="" className="h-7 w-7 rounded-full object-cover" />;
  }
  return (
    <span
      aria-hidden="true"
      className="flex h-7 w-7 items-center justify-center rounded-full bg-zinc-200 text-[11px] font-bold text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
    >
      {name.trim().charAt(0).toUpperCase() || '?'}
    </span>
  );
}

interface PendingAttachment {
  localId: string;
  name: string;
  size: number;
  status: 'preparing' | 'uploading' | 'ready' | 'error';
  progress: number;
  ref?: AttachmentRef;
  error?: string;
  controller: AbortController;
}

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
  const [hasOlder, setHasOlder] = useState(false);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const [outgoing, setOutgoing] = useState<OutgoingMessage[]>([]);
  const [atBottom, setAtBottom] = useState(true);
  const [unseenCount, setUnseenCount] = useState(0);
  const [inputText, setInputText] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [warningBanner, _setWarningBanner] = useState<string | null>(null);

  const [safetyDialogOpen, setSafetyDialogOpen] = useState(false);
  const [groupSettingsOpen, setGroupSettingsOpen] = useState(false);

  const [peerEdKey, setPeerEdKey] = useState<string>('');
  const [myEdKey, setMyEdKey] = useState<string>('');

  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<DecryptedMessageItem[]>([]);
  messagesRef.current = messages;
  // What the next render does with the scroll position: follow to the bottom, or keep the reader where they were
  // after older messages were prepended above them.
  const scrollIntent = useRef<
    { kind: 'bottom' } | { kind: 'keep'; height: number; top: number } | null
  >(null);
  const lastMarkedSeq = useRef(0);
  // Results that arrive after the user opened another conversation are dropped.
  const generation = useRef(0);
  // Sends go out one at a time, in order (one outbound Megolm session per conversation).
  const sendChain = useRef<Promise<void>>(Promise.resolve());
  const { manager: callManager } = useCalls();
  const canCall = CallManager.canCall(conversation, currentUserId);
  const chatService = useMemo(() => getChatService(), []);
  const conversationRef = useRef(conversation);
  conversationRef.current = conversation;

  const isNearBottom = () => {
    const el = scrollRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK_PX;
  };

  const scrollToBottom = (smooth = false) => {
    const el = scrollRef.current;
    if (!el) return;
    if (smooth && typeof el.scrollTo === 'function')
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    else el.scrollTop = el.scrollHeight;
    setUnseenCount(0);
    setAtBottom(true);
  };

  // Marks the newest stored message read, only while the reader is at the bottom and the tab is visible.
  const markReadIfVisible = useCallback(() => {
    const newest = messagesRef.current[messagesRef.current.length - 1]?.message.seq ?? 0;
    if (newest <= lastMarkedSeq.current || conversationRef.current.my_state !== 'ACTIVE') return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    if (!isNearBottom()) return;
    lastMarkedSeq.current = newest;
    Promise.resolve(chatService.markRead(conversationRef.current.id, newest)).catch(() => {
      lastMarkedSeq.current = 0;
    });
  }, [chatService]);

  // Newest page when a conversation opens.
  useEffect(() => {
    const gen = ++generation.current;
    setMessages([]);
    setOutgoing([]);
    setHasOlder(false);
    setUnseenCount(0);
    setIsLoadingMessages(true);
    setErrorMessage(null);
    lastMarkedSeq.current = 0;
    void (async () => {
      try {
        const { items, has_more } = await chatService.fetchMessages(conversation.id, {
          limit: PAGE_SIZE,
        });
        if (gen !== generation.current) return;
        scrollIntent.current = { kind: 'bottom' };
        setMessages(items);
        setHasOlder(has_more);
      } catch (err) {
        if (gen === generation.current) setErrorMessage(errorText(err, 'Không thể tải tin nhắn.'));
      } finally {
        if (gen === generation.current) setIsLoadingMessages(false);
      }
    })();
  }, [conversation.id, chatService]);

  // chat.hint (MESSAGE, TO_DEVICE, …): fetch what is new, refresh the newest page (deletions), and decrypt again the
  // messages that waited for a key.
  const refresh = useCallback(async () => {
    const gen = generation.current;
    const conversationId = conversationRef.current.id;
    const before = messagesRef.current;
    const lastSeq = before[before.length - 1]?.message.seq ?? 0;
    try {
      const newest = await chatService.fetchMessages(conversationId, { limit: PAGE_SIZE });
      let fetched = newest.items;
      const firstNewest = fetched[0]?.message.seq ?? 0;
      if (lastSeq > 0 && firstNewest > lastSeq + 1) {
        // More than a page arrived: fill the gap after what is loaded.
        let after = lastSeq;
        for (let page = 0; page < 10; page++) {
          const next = await chatService.fetchMessages(conversationId, {
            after_seq: after,
            limit: 100,
          });
          fetched = [...fetched, ...next.items];
          const last = next.items[next.items.length - 1]?.message.seq;
          if (!next.has_more || !last || last >= firstNewest) break;
          after = last;
        }
      }
      const fetchedSeqs = new Set(fetched.map((i) => i.message.seq));
      const retried = await Promise.all(
        before
          .filter((i) => i.status === 'WAITING_FOR_KEY' && !fetchedSeqs.has(i.message.seq))
          .map((i) => chatService.decryptMessageItem(conversationId, i.message)),
      );
      if (gen !== generation.current) return;
      const follow = isNearBottom();
      const fresh = fetched.filter(
        (i) => i.message.seq > lastSeq && i.message.sender_id !== currentUserId,
      );
      scrollIntent.current = follow ? { kind: 'bottom' } : null;
      if (!follow && fresh.length > 0) setUnseenCount((n) => n + fresh.length);
      setMessages((prev) => mergeMessages(prev, [...fetched, ...retried]));
      if (lastSeq === 0) setHasOlder(newest.has_more);
    } catch {
      // The next hint or reconnect tries again.
    }
  }, [chatService, currentUserId]);

  const firstRealtime = useRef(realtimeVersion);
  useEffect(() => {
    if (realtimeVersion === firstRealtime.current) return;
    firstRealtime.current = realtimeVersion;
    void refresh();
  }, [realtimeVersion, refresh]);

  const loadOlder = useCallback(async () => {
    const first = messagesRef.current[0]?.message.seq;
    if (!first || first <= 1 || isLoadingOlder) return;
    const gen = generation.current;
    setIsLoadingOlder(true);
    try {
      const { items, has_more } = await chatService.fetchMessages(conversationRef.current.id, {
        before_seq: first,
        limit: PAGE_SIZE,
      });
      if (gen !== generation.current) return;
      const el = scrollRef.current;
      scrollIntent.current = el
        ? { kind: 'keep', height: el.scrollHeight, top: el.scrollTop }
        : null;
      setMessages((prev) => mergeMessages(prev, items));
      setHasOlder(has_more);
    } catch (err) {
      if (gen === generation.current)
        setErrorMessage(errorText(err, 'Không thể tải tin nhắn cũ hơn.'));
    } finally {
      if (gen === generation.current) setIsLoadingOlder(false);
    }
  }, [chatService, isLoadingOlder]);

  // Apply the scroll intent after the DOM has the new rows, before the browser paints.
  useLayoutEffect(() => {
    const intent = scrollIntent.current;
    scrollIntent.current = null;
    const el = scrollRef.current;
    if (!intent || !el) return;
    if (intent.kind === 'bottom') scrollToBottom();
    else el.scrollTop = el.scrollHeight - intent.height + intent.top;
  }, [messages, outgoing]);

  useEffect(() => {
    markReadIfVisible();
  }, [messages, markReadIfVisible]);

  useEffect(() => {
    const onVisible = () => markReadIfVisible();
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [markReadIfVisible]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const bottom = isNearBottom();
    setAtBottom(bottom);
    if (bottom) {
      setUnseenCount(0);
      markReadIfVisible();
    }
    if (el.scrollTop <= TOP_LOAD_PX && hasOlder && !isLoadingOlder && !isLoadingMessages)
      void loadOlder();
  };

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

  const updatePending = (localId: string, patch: Partial<PendingAttachment>) =>
    setPending((prev) => prev.map((p) => (p.localId === localId ? { ...p, ...patch } : p)));

  // SOC-3b: each picked file is prepared (images: WebP, at most 1600 px), encrypted and uploaded right away; the
  // message is sent once every file is ready.
  const handleFilesPicked = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const deviceId = chatService.getDeviceId();
    if (!deviceId) {
      setErrorMessage('Chưa thiết lập thiết bị nhắn tin bảo mật.');
      return;
    }
    const room = MAX_ATTACHMENTS_PER_MESSAGE - pending.length;
    const picked = Array.from(files).slice(0, Math.max(0, room));
    if (files.length > picked.length) {
      setErrorMessage(`Mỗi tin nhắn có tối đa ${MAX_ATTACHMENTS_PER_MESSAGE} tệp.`);
    }
    for (const file of picked) {
      const item: PendingAttachment = {
        localId: crypto.randomUUID(),
        name: file.name,
        size: file.size,
        status: 'preparing',
        progress: 0,
        controller: new AbortController(),
      };
      setPending((prev) => [...prev, item]);
      void (async () => {
        try {
          const prepared = await prepareFile(file);
          updatePending(item.localId, { status: 'uploading', size: prepared.bytes.length });
          const ref = await uploadAttachment({
            conversationId: conversation.id,
            deviceId,
            prepared,
            signal: item.controller.signal,
            onProgress: (progress) => updatePending(item.localId, { progress }),
          });
          updatePending(item.localId, { status: 'ready', progress: 1, ref });
        } catch (err) {
          if (err instanceof AttachmentError && err.code === 'CANCELLED') return;
          if (err instanceof DOMException && err.name === 'AbortError') return;
          updatePending(item.localId, {
            status: 'error',
            error: err instanceof Error ? err.message : 'Không gửi được tệp.',
          });
        }
      })();
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const removePending = (localId: string) => {
    setPending((prev) => {
      prev.find((p) => p.localId === localId)?.controller.abort();
      return prev.filter((p) => p.localId !== localId);
    });
  };

  const attachmentsBusy = pending.some((p) => p.status === 'preparing' || p.status === 'uploading');
  const readyAttachments = pending.filter((p) => p.status === 'ready' && p.ref).map((p) => p.ref!);

  // Shown at once as "Đang gửi…"; replaced by the stored message, or kept as "Không gửi được" with "Thử lại", which
  // sends again with the same client_msg_id (chat-svc answers the stored message if the first try did arrive).
  const deliver = (out: OutgoingMessage) => {
    setOutgoing((prev) =>
      prev.some((o) => o.localId === out.localId)
        ? prev.map((o) =>
            o.localId === out.localId ? { ...out, state: 'sending', error: undefined } : o,
          )
        : [...prev, out],
    );
    scrollIntent.current = { kind: 'bottom' };
    sendChain.current = sendChain.current.then(async () => {
      const gen = generation.current;
      try {
        const sentItem = await chatService.sendMessage({
          conversation: conversationRef.current,
          text: out.text,
          clientMsgId: out.clientMsgId,
          attachments: out.attachments,
        });
        if (gen !== generation.current) return;
        scrollIntent.current = isNearBottom() ? { kind: 'bottom' } : null;
        setMessages((prev) => mergeMessages(prev, [sentItem]));
        setOutgoing((prev) => prev.filter((o) => o.localId !== out.localId));
        onConversationUpdated({
          ...conversationRef.current,
          last_seq: Math.max(conversationRef.current.last_seq, sentItem.message.seq),
          last_message_at: sentItem.message.created_at,
        });
      } catch (err) {
        if (gen !== generation.current) return;
        setOutgoing((prev) =>
          prev.map((o) =>
            o.localId === out.localId
              ? { ...o, state: 'failed', error: errorText(err, 'Không thể gửi tin nhắn.') }
              : o,
          ),
        );
      }
    });
  };

  const handleSendMessage = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const textToSend = inputText.trim();
    if ((!textToSend && readyAttachments.length === 0) || attachmentsBusy || isRequested) return;
    setErrorMessage(null);
    deliver({
      localId: crypto.randomUUID(),
      clientMsgId: crypto.randomUUID(),
      text: textToSend,
      attachments: readyAttachments,
      createdAt: new Date().toISOString(),
      state: 'sending',
    });
    setInputText('');
    setPending((prev) => prev.filter((p) => p.status === 'error'));
  };

  const discardOutgoing = (localId: string) =>
    setOutgoing((prev) => prev.filter((o) => o.localId !== localId));

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
    } catch (err) {
      setErrorMessage(errorText(err, 'Không thể xoá tin nhắn.'));
    }
  };

  const handleAcceptRequest = async () => {
    try {
      const updated = await chatService.acceptConversation(conversation.id);
      onConversationUpdated(updated);
      await refresh();
    } catch (err) {
      setErrorMessage(errorText(err, 'Không thể chấp nhận lời mời.'));
    }
  };

  const handleDeclineRequest = async () => {
    if (!window.confirm('Bạn có chắc chắn muốn từ chối lời mời nhắn tin này?')) {
      return;
    }
    try {
      await chatService.leaveOrRemoveMember(conversation.id, currentUserId);
      onConversationLeft();
    } catch (err) {
      setErrorMessage(errorText(err, 'Không thể từ chối lời mời.'));
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

  const rows = useMemo(
    () => buildTimeline({ items: messages, outgoing, conversation, currentUserId }),
    [messages, outgoing, conversation, currentUserId],
  );
  const receipt = useMemo(
    () => readReceipt({ items: messages, conversation, currentUserId }),
    [messages, conversation, currentUserId],
  );

  const renderMessage = (item: DecryptedMessageItem, isOwn: boolean) => {
    const timeStr = formatMessageTime(item.message.created_at);

    // SOC-4a call events: one line per finished call, from the decrypted events (never on the server)
    if (item.status === 'CALL' && item.callEvent) {
      const ev = item.callEvent;
      const invite = messages.find(
        (m) => m.callEvent?.type === 'm.call.invite' && m.callEvent.call_id === ev.call_id,
      );
      const media: CallMedia | null =
        invite?.callEvent?.type === 'm.call.invite' ? invite.callEvent.media : null;
      const text = describeCallEvent(ev, media, isOwn);
      if (!text) return null;
      return (
        <div className="flex justify-center my-2">
          <span
            data-testid="call-history-line"
            className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-zinc-200/60 dark:bg-zinc-800/60 text-[11px] text-zinc-700 dark:text-zinc-300 font-medium"
          >
            <PhoneCall className="h-3 w-3" aria-hidden="true" />
            {text} · {timeStr}
          </span>
        </div>
      );
    }

    if (item.status === 'SYSTEM') {
      return (
        <div className="flex justify-center my-2">
          <span className="px-3 py-1 rounded-full bg-zinc-200/60 dark:bg-zinc-800/60 text-[11px] text-zinc-700 dark:text-zinc-300 font-medium">
            {systemMessageText(item.message.system)}
          </span>
        </div>
      );
    }

    if (item.status === 'DELETED') {
      return (
        <div className="max-w-[75%] px-3.5 py-2 rounded-2xl bg-zinc-100 dark:bg-[#1c1c1c] text-zinc-500 dark:text-zinc-400 text-xs italic border border-zinc-200/50 dark:border-zinc-800/50">
          Tin nhắn đã bị thu hồi
        </div>
      );
    }

    if (item.status === 'WAITING_FOR_KEY') {
      return (
        <div className="max-w-[75%] px-3.5 py-2 rounded-2xl bg-amber-500/10 border border-amber-500/20 text-amber-700 dark:text-amber-400 text-xs flex items-center gap-2">
          <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          <span>Đang chờ khoá giải mã…</span>
        </div>
      );
    }

    return (
      <div
        className={`relative max-w-[80%] sm:max-w-[70%] px-3.5 py-2.5 rounded-2xl text-sm leading-relaxed break-words shadow-sm ${
          isOwn
            ? 'bg-red-600 text-white rounded-br-xs'
            : 'bg-white dark:bg-[#1e1e1e] text-zinc-900 dark:text-zinc-100 border border-zinc-200/60 dark:border-[#282828] rounded-bl-xs'
        }`}
      >
        {/* Text rendered strictly as text to prevent XSS */}
        {(item.status === 'UNSUPPORTED' || item.plaintext) && (
          <div className="whitespace-pre-wrap select-text">
            {item.status === 'UNSUPPORTED' ? 'Tin nhắn không hỗ trợ' : item.plaintext}
          </div>
        )}
        {item.attachments && item.attachments.length > 0 && (
          <AttachmentList conversationId={conversation.id} attachments={item.attachments} />
        )}
        <div
          className={`flex items-center justify-end gap-1.5 mt-1 text-[10px] ${
            isOwn ? 'text-white' : 'text-zinc-500 dark:text-zinc-400'
          }`}
        >
          <span>{timeStr}</span>
          {isOwn && (
            <button
              type="button"
              onClick={() => handleDeleteMessage(item.message.seq)}
              className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity p-0.5 hover:text-white"
              title="Thu hồi tin nhắn"
              aria-label="Thu hồi tin nhắn"
            >
              <Trash2 className="h-3 w-3" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
    );
  };

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
          {conversation.kind === 'DIRECT' && callManager && (
            <>
              <button
                type="button"
                onClick={() => void callManager.startCall(conversation, 'audio')}
                disabled={!canCall}
                aria-label="Gọi thoại"
                title={
                  canCall
                    ? 'Gọi thoại (mã hoá đầu cuối)'
                    : 'Chỉ gọi được khi cả hai đã chấp nhận trò chuyện'
                }
                className="p-2 rounded-lg text-zinc-600 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-white hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors disabled:opacity-40"
              >
                <Phone className="h-4 w-4" aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => void callManager.startCall(conversation, 'video')}
                disabled={!canCall}
                aria-label="Gọi video"
                title={
                  canCall
                    ? 'Gọi video (mã hoá đầu cuối)'
                    : 'Chỉ gọi được khi cả hai đã chấp nhận trò chuyện'
                }
                className="p-2 rounded-lg text-zinc-600 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-white hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors disabled:opacity-40"
              >
                <Video className="h-4 w-4" aria-hidden="true" />
              </button>
            </>
          )}
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

      {/* Messages: day separators, sender runs in groups, delivery states; older pages load when scrolling up */}
      <div className="relative flex-1 min-h-0">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          role="log"
          aria-label="Tin nhắn"
          aria-busy={isLoadingMessages || isLoadingOlder}
          data-testid="message-scroll"
          className="h-full overflow-y-auto p-4 space-y-1.5"
        >
          {isLoadingOlder && (
            <div
              role="status"
              className="flex items-center justify-center gap-2 py-2 text-[11px] text-zinc-500 dark:text-zinc-400"
            >
              <div
                className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-red-500 border-t-transparent"
                aria-hidden="true"
              />
              Đang tải tin nhắn cũ hơn…
            </div>
          )}
          {!isLoadingMessages && !hasOlder && messages.length > 0 && (
            <p className="py-2 text-center text-[11px] text-zinc-500 dark:text-zinc-400">
              Bắt đầu cuộc trò chuyện
            </p>
          )}
          {isLoadingMessages ? (
            <div className="flex items-center justify-center py-16">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-red-500 border-t-transparent" />
            </div>
          ) : messages.length === 0 && outgoing.length === 0 ? (
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
            rows.map((row) => {
              if (row.kind === 'day') {
                return (
                  <div
                    key={row.key}
                    role="separator"
                    aria-label={row.label}
                    className="flex items-center gap-3 py-3"
                  >
                    <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" aria-hidden="true" />
                    <span className="text-[11px] font-semibold text-zinc-600 dark:text-zinc-400">
                      {row.label}
                    </span>
                    <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" aria-hidden="true" />
                  </div>
                );
              }

              if (row.kind === 'outgoing') {
                const out = row.outgoing;
                return (
                  <div
                    key={row.key}
                    className="flex flex-col items-end"
                    data-testid="outgoing-message"
                  >
                    <div
                      className={`max-w-[80%] sm:max-w-[70%] px-3.5 py-2.5 rounded-2xl rounded-br-xs text-sm leading-relaxed break-words shadow-sm text-white ${
                        out.state === 'failed' ? 'bg-red-700' : 'bg-red-600'
                      }`}
                    >
                      {out.text && <div className="whitespace-pre-wrap">{out.text}</div>}
                      {out.attachments.length > 0 && (
                        <div className="text-[11px] text-red-50">
                          {out.attachments.length} tệp đính kèm
                        </div>
                      )}
                    </div>
                    {out.state === 'sending' ? (
                      <span
                        role="status"
                        className="mt-0.5 flex items-center gap-1 text-[11px] text-zinc-500 dark:text-zinc-400"
                      >
                        <Clock className="h-3 w-3" aria-hidden="true" />
                        Đang gửi…
                      </span>
                    ) : (
                      <span
                        role="alert"
                        className="mt-0.5 flex flex-wrap items-center justify-end gap-x-2 text-[11px] text-red-700 dark:text-red-400"
                      >
                        <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                        <span>
                          Không gửi được
                          {out.error ? `: ${out.error}` : ''}
                        </span>
                        <button
                          type="button"
                          onClick={() => deliver(out)}
                          className="rounded font-semibold underline underline-offset-2 hover:no-underline focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
                        >
                          Thử lại
                        </button>
                        <button
                          type="button"
                          onClick={() => discardOutgoing(out.localId)}
                          className="rounded underline underline-offset-2 hover:no-underline focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
                        >
                          Bỏ
                        </button>
                      </span>
                    )}
                  </div>
                );
              }

              const { item, isOwn, showSender, sender } = row;
              const body = renderMessage(item, isOwn);
              if (!body) return null;
              if (item.status === 'SYSTEM' || item.status === 'CALL') {
                return <div key={row.key}>{body}</div>;
              }
              const senderName = sender?.display_name || sender?.handle || 'Thành viên cũ';
              const isGroup = conversation.kind === 'GROUP';
              const showReceipt = isOwn && receipt?.seq === item.message.seq;
              return (
                <div
                  key={row.key}
                  className={`flex flex-col ${isOwn ? 'items-end' : 'items-start'} group ${showSender ? 'pt-2' : ''}`}
                >
                  {showSender && (
                    <span className="mb-0.5 ml-9 text-[11px] font-semibold text-zinc-600 dark:text-zinc-400">
                      {senderName}
                    </span>
                  )}
                  <div
                    className={`flex w-full items-end gap-2 ${isOwn ? 'justify-end' : 'justify-start'}`}
                  >
                    {isGroup && !isOwn && (
                      <span className="w-7 shrink-0">
                        {showSender && <SenderAvatar user={sender} name={senderName} />}
                      </span>
                    )}
                    {body}
                  </div>
                  {showReceipt && receipt && (
                    <span
                      data-testid="read-receipt"
                      className="mt-0.5 flex items-center gap-1 text-[11px] text-zinc-500 dark:text-zinc-400"
                    >
                      {receipt.readers.length > 0 ? (
                        <CheckCheck
                          className="h-3 w-3 text-emerald-600 dark:text-emerald-400"
                          aria-hidden="true"
                        />
                      ) : (
                        <Check className="h-3 w-3" aria-hidden="true" />
                      )}
                      {receipt.label}
                    </span>
                  )}
                </div>
              );
            })
          )}
        </div>

        {!atBottom && !isLoadingMessages && (
          <button
            type="button"
            onClick={() => scrollToBottom(true)}
            aria-label={
              unseenCount > 0 ? `${unseenCount} tin mới, xuống tin mới nhất` : 'Xuống tin mới nhất'
            }
            className="absolute bottom-3 left-1/2 -translate-x-1/2 inline-flex items-center gap-1.5 rounded-full bg-zinc-900 px-3.5 py-1.5 text-xs font-semibold text-white shadow-lg hover:bg-zinc-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            {unseenCount > 0
              ? `Tin mới${unseenCount > 1 ? ` (${unseenCount})` : ''}`
              : 'Tin mới nhất'}
            <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
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
        {pending.length > 0 && (
          <ul className="mb-2 flex flex-wrap gap-1.5" aria-label="Tệp đính kèm">
            {pending.map((p) => (
              <li
                key={p.localId}
                className={`flex max-w-[14rem] items-center gap-2 rounded-lg border px-2 py-1 text-[11px] ${
                  p.status === 'error'
                    ? 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400'
                    : 'border-zinc-200 bg-zinc-50 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300'
                }`}
              >
                <Paperclip className="h-3 w-3 shrink-0" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{p.name}</span>
                  <span className="block">
                    {p.status === 'preparing'
                      ? 'Đang nén và mã hoá…'
                      : p.status === 'uploading'
                        ? `Đang tải lên ${Math.round(p.progress * 100)}%`
                        : p.status === 'ready'
                          ? `Sẵn sàng · ${formatBytes(p.size)}`
                          : p.error}
                  </span>
                  {p.status === 'uploading' && (
                    <progress
                      className="mt-0.5 block h-1 w-full accent-red-600"
                      max={1}
                      value={p.progress}
                      aria-label={`Tiến độ tải lên ${p.name}`}
                    />
                  )}
                </span>
                <button
                  type="button"
                  onClick={() => removePending(p.localId)}
                  aria-label={p.status === 'uploading' ? `Huỷ tải lên ${p.name}` : `Bỏ ${p.name}`}
                  className="shrink-0 rounded p-0.5 hover:bg-zinc-200 dark:hover:bg-zinc-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
                >
                  <X className="h-3 w-3" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <form onSubmit={handleSendMessage} className="flex items-end gap-2">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            data-testid="chat-file-input"
            onChange={(e) => handleFilesPicked(e.target.files)}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isRequested || pending.length >= MAX_ATTACHMENTS_PER_MESSAGE}
            aria-label="Đính kèm tệp"
            title="Đính kèm ảnh, video hoặc tệp (mã hoá đầu cuối)"
            className="flex shrink-0 items-center justify-center rounded-xl p-2.5 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 disabled:opacity-40 dark:hover:bg-zinc-800 dark:hover:text-white"
          >
            <Paperclip className="h-4 w-4" aria-hidden="true" />
          </button>
          <div className="flex-1 relative">
            <textarea
              rows={1}
              maxLength={4000}
              disabled={isRequested}
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
            disabled={
              (!inputText.trim() && readyAttachments.length === 0) || isRequested || attachmentsBusy
            }
            aria-label="Gửi"
            className="flex items-center justify-center p-2.5 rounded-xl bg-red-600 hover:bg-red-500 text-white transition-colors disabled:opacity-40 shrink-0"
          >
            <Send className="h-4 w-4" aria-hidden="true" />
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
