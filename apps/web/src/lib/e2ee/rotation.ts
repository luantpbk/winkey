/**
 * Outbound Megolm Session Rotation Policy (ADR-049 / SOC-3a)
 *
 * Requirements:
 * - Rotate after 100 messages sent under the session
 * - Rotate after 7 days since session creation
 * - Rotate immediately on member changes (member_added, member_removed, member_left, request_accepted)
 * - Rotate immediately on device changes (chat.hint DEVICES)
 */

export const MAX_MEGOLM_MESSAGES_PER_SESSION = 100;
export const MAX_MEGOLM_SESSION_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days in ms

export type RotationReason =
  'MESSAGE_LIMIT' | 'AGE_LIMIT' | 'MEMBERSHIP_CHANGED' | 'DEVICES_CHANGED' | null;

export interface OutboundSessionMetadata {
  sessionId: string;
  messageIndex: number;
  createdAt: number; // Unix timestamp in ms
}

export function shouldRotateMegolmSession(
  session: OutboundSessionMetadata | null | undefined,
  options: {
    now?: number;
    membershipChanged?: boolean;
    devicesChanged?: boolean;
  } = {},
): { shouldRotate: boolean; reason: RotationReason } {
  if (!session) {
    return { shouldRotate: true, reason: null };
  }

  if (options.membershipChanged) {
    return { shouldRotate: true, reason: 'MEMBERSHIP_CHANGED' };
  }

  if (options.devicesChanged) {
    return { shouldRotate: true, reason: 'DEVICES_CHANGED' };
  }

  if (session.messageIndex >= MAX_MEGOLM_MESSAGES_PER_SESSION) {
    return { shouldRotate: true, reason: 'MESSAGE_LIMIT' };
  }

  const now = options.now ?? Date.now();
  if (now - session.createdAt >= MAX_MEGOLM_SESSION_AGE_MS) {
    return { shouldRotate: true, reason: 'AGE_LIMIT' };
  }

  return { shouldRotate: false, reason: null };
}
