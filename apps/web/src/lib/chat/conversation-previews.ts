'use client';

import { useEffect, useState } from 'react';
import type { Conversation } from '@winkey/api-client';
import { getChatService } from '../e2ee/chat-service';
import { previewOf } from './message-text';
import {
  previewCache,
  previewInflight,
  previewKey,
  type ConversationPreview,
} from './preview-cache';

export type { ConversationPreview } from './preview-cache';
export { clearConversationPreviews } from './preview-cache';

/**
 * Last-message previews for the conversation list (B3). Decrypted on this device and kept **in memory only** (never
 * written to storage, never sent to a server), per signed-in user. A conversation is fetched again only when its
 * `last_seq` changed, or when its preview was waiting for a key and new keys may have arrived (`version` bumps on
 * to-device hints).
 */
const CONCURRENCY = 3;

async function load(
  conversation: Conversation,
  userId: string,
  version: number,
): Promise<ConversationPreview | null> {
  const key = previewKey(userId, conversation.id);
  const flight = `${key}:${conversation.last_seq}`;
  const running = previewInflight.get(flight);
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
      previewCache.set(key, preview);
      return preview;
    } catch {
      return null;
    } finally {
      previewInflight.delete(flight);
    }
  })();
  previewInflight.set(flight, run);
  return run;
}

function fresh(conversation: Conversation, userId: string): ConversationPreview | undefined {
  const hit = previewCache.get(previewKey(userId, conversation.id));
  return hit && hit.seq >= conversation.last_seq ? hit : undefined;
}

/** Previews by conversation id for the given list; fills in as they decrypt. */
export function useConversationPreviews(
  conversations: Conversation[],
  userId: string,
  version: number,
  /** False until this browser's E2EE device is ready: decrypting earlier would race its set-up. */
  enabled = true,
): Map<string, ConversationPreview> {
  const [previews, setPreviews] = useState<Map<string, ConversationPreview>>(() => new Map());

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const ready = new Map<string, ConversationPreview>();
    const todo: Conversation[] = [];
    for (const c of conversations) {
      if (c.last_seq <= 0) continue;
      const hit = fresh(c, userId);
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
  }, [conversations, userId, version, enabled]);

  return previews;
}
