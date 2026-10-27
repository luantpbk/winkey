import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../db/types.js';

export type DbOrTrx = Kysely<Database> | Transaction<Database>;

/**
 * Checks whether user A and user B are in a block relationship in either direction.
 * (A blocks B OR B blocks A).
 */
export async function isBlockedEitherWay(
  db: DbOrTrx,
  userA: string,
  userB: string,
): Promise<boolean> {
  if (userA === userB) {
    return false;
  }

  const row = await db
    .selectFrom('social.blocks')
    .select(sql`1`.as('blocked'))
    .where((eb) =>
      eb.or([
        eb.and([eb('blocker_id', '=', userA), eb('blocked_id', '=', userB)]),
        eb.and([eb('blocker_id', '=', userB), eb('blocked_id', '=', userA)]),
      ]),
    )
    .executeTakeFirst();

  return !!row;
}

/**
 * Checks whether an in-app notification from actor to recipient should be suppressed.
 * Suppressed if:
 * 1. Actor is recipient (self-notification)
 * 2. Actor and recipient are in a block relationship (either direction)
 * 3. Recipient has muted the actor
 */
export async function shouldSuppressNotification(
  db: DbOrTrx,
  actorId: string,
  recipientId: string,
): Promise<boolean> {
  if (actorId === recipientId) {
    return true;
  }

  const blocked = await isBlockedEitherWay(db, actorId, recipientId);
  if (blocked) {
    return true;
  }

  const muteRow = await db
    .selectFrom('social.mutes')
    .select(sql`1`.as('muted'))
    .where('muter_id', '=', recipientId)
    .where('muted_id', '=', actorId)
    .executeTakeFirst();

  return !!muteRow;
}
