import type { Conversation, Member } from '@winkey/api-client';
import type { DecryptedMessageItem } from '../e2ee/chat-service';
import type { AttachmentRef, ReplyRef } from '../e2ee/events';
import { previewOf } from './message-text';

/**
 * B3 2/6 — the conversation view as a timeline: day separators, sender headers in groups, delivery states and
 * "đã xem". Everything here runs on this device on decrypted items; nothing is sent anywhere.
 */

/** A message being sent from this device: shown at once, replaced by the stored message when chat-svc answers. */
export interface OutgoingMessage {
  localId: string;
  /** Reused by "Thử lại", so chat-svc returns the stored message instead of a duplicate (contract: safe retry). */
  clientMsgId: string;
  text: string;
  attachments: AttachmentRef[];
  replyTo?: ReplyRef;
  createdAt: string;
  state: 'sending' | 'failed';
  error?: string;
}

export type TimelineRow =
  | { kind: 'day'; key: string; label: string }
  | {
      kind: 'message';
      key: string;
      item: DecryptedMessageItem;
      isOwn: boolean;
      /** First message of a run from the same sender: show the avatar and name (groups only). */
      showSender: boolean;
      sender: Member['user'] | null;
    }
  | { kind: 'outgoing'; key: string; outgoing: OutgoingMessage };

const WEEKDAY_NAMES = ['Chủ nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];
const pad = (n: number) => String(n).padStart(2, '0');
/** A new sender header after this much silence, even from the same person. */
const RUN_GAP_MS = 5 * 60_000;

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** "Hôm nay", "Hôm qua", "Thứ Hai, 26/10" this year, "26/10/2025" otherwise. */
export function formatDayLabel(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (days === 0) return 'Hôm nay';
  if (days === 1) return 'Hôm qua';
  const date = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
  if (d.getFullYear() === now.getFullYear()) return `${WEEKDAY_NAMES[d.getDay()]}, ${date}`;
  return `${date}/${d.getFullYear()}`;
}

export function formatMessageTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Merges a fetched page into what is loaded: one item per `seq`, the fetched copy wins (a message deleted since
 * keeps its tombstone), ascending by `seq`. An item that still waits for its key keeps a decrypted copy if one exists.
 */
export function mergeMessages(
  loaded: DecryptedMessageItem[],
  fetched: DecryptedMessageItem[],
): DecryptedMessageItem[] {
  const bySeq = new Map<number, DecryptedMessageItem>();
  for (const item of loaded) bySeq.set(item.message.seq, item);
  for (const item of fetched) {
    const prev = bySeq.get(item.message.seq);
    if (prev && item.status === 'WAITING_FOR_KEY' && prev.status === 'DECRYPTED') continue;
    bySeq.set(item.message.seq, item);
  }
  return [...bySeq.values()].sort((a, b) => a.message.seq - b.message.seq);
}

/** Timeline rows: a day separator whenever the local date changes, sender runs in groups, then the outgoing queue. */
export function buildTimeline(params: {
  items: DecryptedMessageItem[];
  outgoing: OutgoingMessage[];
  conversation: Pick<Conversation, 'kind' | 'members'>;
  currentUserId: string;
  now?: Date;
}): TimelineRow[] {
  const { items, outgoing, conversation, currentUserId, now = new Date() } = params;
  const isGroup = conversation.kind === 'GROUP';
  const members = new Map(conversation.members.map((m) => [m.user_id, m.user ?? null]));
  const rows: TimelineRow[] = [];
  let lastDay = '';
  let lastSender: string | null = null;
  let lastAt = 0;

  const addDay = (iso: string) => {
    const d = new Date(iso);
    const key = Number.isNaN(d.getTime()) ? '' : dayKey(d);
    if (key && key !== lastDay) {
      rows.push({ kind: 'day', key: `day-${key}`, label: formatDayLabel(iso, now) });
      lastDay = key;
      lastSender = null;
    }
  };

  for (const item of items) {
    const { message } = item;
    addDay(message.created_at);
    const at = new Date(message.created_at).getTime();
    const isOwn = message.sender_id === currentUserId;
    const inline = item.status === 'SYSTEM' || item.status === 'CALL';
    const showSender =
      isGroup &&
      !isOwn &&
      !inline &&
      (message.sender_id !== lastSender || at - lastAt > RUN_GAP_MS);
    rows.push({
      kind: 'message',
      key: message.id,
      item,
      isOwn,
      showSender,
      sender: (message.sender_id && members.get(message.sender_id)) || null,
    });
    lastSender = inline ? null : message.sender_id;
    lastAt = at;
  }
  for (const out of outgoing) {
    addDay(out.createdAt);
    rows.push({ kind: 'outgoing', key: out.localId, outgoing: out });
  }
  return rows;
}

/**
 * "Đã xem" for my newest message others could read: in a DIRECT chat when the other member's marker reached it, in a
 * group the members whose marker did (names, "và N người khác"). `last_read_seq` is `null` for a REQUESTED member, so
 * a message request never reports being read.
 */
export function readReceipt(params: {
  items: DecryptedMessageItem[];
  conversation: Pick<Conversation, 'kind' | 'members'>;
  currentUserId: string;
}): { seq: number; label: string; readers: string[] } | null {
  const { items, conversation, currentUserId } = params;
  const mine = [...items]
    .reverse()
    .find(
      (i) =>
        i.message.sender_id === currentUserId && i.status !== 'SYSTEM' && i.status !== 'DELETED',
    );
  if (!mine) return null;
  const seq = mine.message.seq;
  const others = conversation.members.filter(
    (m) => m.user_id !== currentUserId && m.state === 'ACTIVE',
  );
  const readers = others.filter((m) => (m.last_read_seq ?? -1) >= seq);
  if (readers.length === 0) return { seq, label: 'Đã gửi', readers: [] };
  if (conversation.kind === 'DIRECT')
    return { seq, label: 'Đã xem', readers: readers.map((m) => m.user_id) };
  if (readers.length === others.length)
    return { seq, label: 'Mọi người đã xem', readers: readers.map((m) => m.user_id) };
  const names = readers.map((m) => m.user?.display_name || m.user?.handle || 'Thành viên');
  const label =
    names.length <= 2
      ? `${names.join(', ')} đã xem`
      : `${names.slice(0, 2).join(', ')} và ${names.length - 2} người khác đã xem`;
  return { seq, label, readers: readers.map((m) => m.user_id) };
}

/** Applies a `chat.hint` `READ` to a conversation: the reader's marker only moves forward. */
export function applyReadHint<C extends Pick<Conversation, 'id' | 'members'>>(
  conversation: C,
  hint: { conversation_id: string; user_id: string; seq: number },
): C {
  if (conversation.id !== hint.conversation_id) return conversation;
  let changed = false;
  const members = conversation.members.map((m) => {
    if (m.user_id !== hint.user_id || (m.last_read_seq ?? -1) >= hint.seq) return m;
    changed = true;
    return { ...m, last_read_seq: hint.seq };
  });
  return changed ? { ...conversation, members } : conversation;
}

/** The reference a reply carries, built on this device. Only a readable message can be replied to. */
export function makeReplyRef(item: DecryptedMessageItem): ReplyRef | null {
  if (item.status !== 'DECRYPTED' || !item.message.sender_id) return null;
  return {
    seq: item.message.seq,
    sender_id: item.message.sender_id,
    preview: previewOf(item).text,
  };
}

export interface ResolvedQuote {
  name: string;
  text: string;
  state: 'loaded' | 'deleted' | 'unloaded';
}

/**
 * What a quote shows. The original on this device wins over the text in the event: the sender writes `preview`, so it
 * could misquote someone, and a deleted message must not come back through a reply to it. Only when the original is
 * not loaded does the quote fall back to `preview`.
 */
export function resolveQuote(
  reply: ReplyRef,
  items: DecryptedMessageItem[],
  members: Pick<Member, 'user_id' | 'user'>[],
): ResolvedQuote {
  const original = items.find((i) => i.message.seq === reply.seq);
  const senderId = original?.message.sender_id ?? reply.sender_id;
  const user = members.find((m) => m.user_id === senderId)?.user;
  const name = user?.display_name || user?.handle || 'Thành viên cũ';
  if (!original) return { name, text: reply.preview, state: 'unloaded' };
  if (original.status === 'DELETED') {
    return { name, text: 'Tin nhắn đã bị thu hồi', state: 'deleted' };
  }
  if (original.status === 'DECRYPTED') {
    return { name, text: previewOf(original).text, state: 'loaded' };
  }
  return { name, text: reply.preview, state: 'unloaded' };
}
