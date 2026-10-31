import { sql } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import { shouldSuppressNotification, type DbOrTrx } from './blocks.js';
import { notificationsCreatedCounter } from '../metrics.js';

/**
 * SOC-6b (friends = mutual follows). Call in the transaction that inserted the follow `followerId → followedId`.
 * - Following back clears the follower's dismissal of the other user's friend request.
 * - With `notifyFriendAccepted`, a pair that is now mutual gives the user who followed first a `FRIEND_ACCEPTED`
 *   (actor = the new friend; once per pair by notifications_dedup; suppressed across blocks and mutes).
 *   A follow-request approval passes false: it creates only `FOLLOW_REQUEST_APPROVED`.
 */
export async function onNewFollow(
  trx: DbOrTrx,
  followerId: string,
  followedId: string,
  options: { notifyFriendAccepted: boolean },
): Promise<void> {
  await trx
    .deleteFrom('social.friend_request_dismissals')
    .where('user_id', '=', followerId)
    .where('follower_id', '=', followedId)
    .execute();

  if (!options.notifyFriendAccepted) return;

  const followedBack = await trx
    .selectFrom('social.subscriptions')
    .select(sql`1`.as('one'))
    .where('subscriber_id', '=', followedId)
    .where('channel_id', '=', followerId)
    .executeTakeFirst();
  if (!followedBack) return;

  if (await shouldSuppressNotification(trx, followerId, followedId)) return;
  const inserted = await trx
    .insertInto('social.notifications')
    .values({
      id: uuidv7(),
      user_id: followedId,
      kind: 'FRIEND_ACCEPTED',
      actor_id: followerId,
      video_id: null,
      comment_id: null,
    })
    .onConflict((oc) => oc.doNothing())
    .returning('id')
    .execute();
  if (inserted.length > 0) {
    notificationsCreatedCounter.inc({ kind: 'FRIEND_ACCEPTED' });
  }
}
