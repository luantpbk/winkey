'use client';

import { useEffect, useState } from 'react';
import type { Conversation } from '@winkey/api-client';
import { getChatService } from '../e2ee/chat-service';
import { previewOf } from './message-text';

export interface ConversationPreview {
  seq: number;
  text: string;
  /** Sent by the current user ("Bạn: …"). */
  fromMe: boolean;
  senderId: string | null;
  /** The newest message still waits for its key; retried when keys arrive. */
  waiting: boolean;
  /** The `version` it was loaded at: a waiting preview is tried again only for a newer version. */
  version: number;
}

/**
 * Last-message previews for the conversation list (B3). Decrypted on this device and kept **in memory only** (never
 * written to storage, never sent to a server). A conversation is fetched again only when its `last_seq` changed, or
 * when its preview was waiting for a key and new keys may have arrived (`version` bumps on to-device hints).
 */
const cache = new Map<string, ConversationPreview>();
const inflight = new Map<string, Promise<ConversationPreview | null>>();
const CONCURRENCY = 3;

async function load(
  conversation: Conversation,
  userId: string,
  version: number,
): Promise<ConversationPreview | null> {
  const key = `${conversation.id}:${conversation.last_seq}`;
  const running = inflight.get(key);
  if (running) return running;
  const run = (async () => {
    try {
      const page = await getChatService().fetchMessages(conversation.id, { limit: 1 });
      const item = page.items[page.items.length - 1];
      if (!item) return null;
      const { text, waiting } = previewOf(item);
      const preview: ConversationPreview = {
        seq: Number(item.message.seq),
        text,
        waiting,
        senderId: item.message.sender_id ?? null,
        fromMe: item.message.sender_id === userId,
        version,
      };
      cache.set(conversation.id, preview);
      return preview;
    } catch {
      return null;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, run);
  return run;
}

function fresh(conversation: Conversation): ConversationPreview | undefined {
  const hit = cache.get(conversation.id);
  return hit && hit.seq >= conversation.last_seq ? hit : undefined;
}

/** Previews by conversation id for the given list; fills in as they decrypt. */
export function useConversationPreviews(
  conversations: Conversation[],
  userId: string,
  version: number,
): Map<string, ConversationPreview> {
  const [previews, setPreviews] = useState<Map<string, ConversationPreview>>(() => new Map());

  useEffect(() => {
    let live = true;
    const ready = new Map<string, ConversationPreview>();
    const todo: Conversation[] = [];
    for (const c of conversations) {
      if (c.last_seq <= 0) continue;
      const hit = fresh(c);
      if (hit) ready.set(c.id, hit);
      if (!hit || (hit.waiting && hit.version < version)) todo.push(c);
    }
    setPreviews(ready);

    const queue = [...todo];
    const worker = async () => {
      for (let c = queue.shift(); c; c = queue.shift()) {
        const p = await load(c, userId, version);
        if (!live || !p) continue;
        setPreviews((prev) => new Map(prev).set(c!.id, p));
      }
    };
    void Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
    return () => {
      live = false;
    };
  }, [conversations, userId, version]);

  return previews;
}

/** For tests and sign-out: forget every decrypted preview. */
export function clearConversationPreviews(): void {
  cache.clear();
  inflight.clear();
}
