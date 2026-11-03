import { api } from '../api-client';
import type { PickedUser } from '../../components/social/user-picker';

/**
 * SOC-6b: friends are mutual follows. "Kết bạn" is a follow; the other user accepts by following back.
 * - friends: both follow each other;
 * - sent: I follow them (or asked to follow a private account), they do not follow me;
 * - incoming: they follow me, I do not follow them ("Chấp nhận");
 * - none: neither.
 */
export type FriendState = 'friends' | 'sent' | 'incoming' | 'none';

export function friendState(rel: {
  following: boolean;
  follow_requested: boolean;
  followed_by: boolean;
}): FriendState {
  if (rel.following && rel.followed_by) return 'friends';
  if (rel.following || rel.follow_requested) return 'sent';
  if (rel.followed_by) return 'incoming';
  return 'none';
}

/** The caller's newest friends, for "friends first" suggestions (new chat). Empty when not available. */
export async function loadFriendSuggestions(limit = 20): Promise<PickedUser[]> {
  try {
    const { data } = await api.social.GET('/v1/me/friends', { params: { query: { limit } } });
    return data ? data.items.map((f) => f.user) : [];
  } catch {
    return [];
  }
}
