import { sql, type Kysely } from 'kysely';
import type { Redis } from 'ioredis';
import { v7 as uuidv7 } from 'uuid';
import type { Database } from '../db/types.js';

export const SCORING_LOCK_KEY = 'social:locks:post_scoring_job';
export const SCORING_LOCK_TTL_MS = 9 * 60 * 1000; // 9 minutes

/**
 * Runs one execution of the explore ranking scoring job.
 * Formula per ADR-049:
 * For VISIBLE, PUBLIC posts of public accounts created in the last 7 days:
 * score = (reaction_count + 2*comment_count + 3*reshare_count + 1) / power(extract(epoch from now() - created_at)/3600 + 2, 1.5)
 *
 * Atomically replaces social.post_scores in one transaction.
 */
export async function runScoringJobOnce(
  db: Kysely<Database>,
  valkey?: Redis | null,
  force = false,
): Promise<boolean> {
  const lockToken = uuidv7();
  let acquired = false;

  if (valkey && !force) {
    try {
      const res = await valkey.set(SCORING_LOCK_KEY, lockToken, 'PX', SCORING_LOCK_TTL_MS, 'NX');
      acquired = res === 'OK';
      if (!acquired) {
        return false;
      }
    } catch {
      // If Valkey fails or is offline, proceed in local fallback if force or continue
      acquired = false;
    }
  } else {
    acquired = true;
  }

  try {
    await db.transaction().execute(async (trx) => {
      // 1. Delete rows in post_scores that are no longer eligible
      await sql`
        DELETE FROM social.post_scores ps
        WHERE NOT EXISTS (
          SELECT 1 FROM social.posts p
          INNER JOIN auth.public_profiles pr ON pr.id = p.author_id
          WHERE p.id = ps.post_id
            AND p.status = 'VISIBLE'
            AND p.visibility = 'PUBLIC'
            AND (pr.is_private IS NULL OR pr.is_private = false)
            AND p.created_at >= NOW() - INTERVAL '7 days'
        )
      `.execute(trx);

      // 2. Compute score and upsert into post_scores
      await sql`
        INSERT INTO social.post_scores (post_id, score, computed_at)
        SELECT
          p.id AS post_id,
          (
            (p.reaction_count + 2 * p.comment_count + 3 * p.reshare_count + 1)::double precision
            / POWER((EXTRACT(EPOCH FROM (NOW() - p.created_at)) / 3600.0) + 2.0, 1.5)
          ) AS score,
          NOW() AS computed_at
        FROM social.posts p
        INNER JOIN auth.public_profiles pr ON pr.id = p.author_id
        WHERE p.status = 'VISIBLE'
          AND p.visibility = 'PUBLIC'
          AND (pr.is_private IS NULL OR pr.is_private = false)
          AND p.created_at >= NOW() - INTERVAL '7 days'
        ON CONFLICT (post_id) DO UPDATE
        SET
          score = EXCLUDED.score,
          computed_at = EXCLUDED.computed_at
      `.execute(trx);
    });

    return true;
  } finally {
    if (valkey && acquired) {
      const releaseLua = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("del", KEYS[1])
        else
          return 0
        end
      `;
      try {
        await valkey.eval(releaseLua, 1, SCORING_LOCK_KEY, lockToken);
      } catch {
        // Ignore lock release errors on teardown
      }
    }
  }
}

/**
 * Starts the scoring periodic job in-process.
 */
export function startScoringJob(
  db: Kysely<Database>,
  valkey?: Redis | null,
  intervalMs = 10 * 60 * 1000,
): { stop: () => void } {
  let timer: NodeJS.Timeout | null = null;
  let running = true;

  const run = async () => {
    if (!running) return;
    try {
      await runScoringJobOnce(db, valkey);
    } catch {
      // Log / ignore background job errors
    }
    if (running) {
      timer = setTimeout(run, intervalMs);
    }
  };

  timer = setTimeout(run, 1000); // Initial run shortly after boot

  return {
    stop: () => {
      running = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
