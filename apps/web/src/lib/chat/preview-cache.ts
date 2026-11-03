/**
 * In-memory store of decrypted last-message previews (B3). Kept apart from the hook so the auth layer can clear it
 * on logout without loading the E2EE modules. Keys are `${userId}:${conversationId}`: a preview decrypted for one
 * account is never shown to another account signed in later in the same tab.
 */
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

export const previewCache = new Map<string, ConversationPreview>();
export const previewInflight = new Map<string, Promise<ConversationPreview | null>>();

export function previewKey(userId: string, conversationId: string): string {
  return `${userId}:${conversationId}`;
}

/** Forget every decrypted preview: on logout, session end and device removal. */
export function clearConversationPreviews(): void {
  previewCache.clear();
  previewInflight.clear();
}
