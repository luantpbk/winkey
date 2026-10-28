import { sql, type Kysely } from 'kysely';
import type { Database } from '../db/types.js';

export interface ParsedMentionsAndHashtags {
  mentions: string[]; // Raw handle strings (lowercased), max 10
  hashtags: { tag: string; slug: string }[]; // First spelling of each slug, max 10
}

/**
 * Derives a tag slug matching public.winkey_tag_slug(tag) in PostgreSQL:
 * lower-case, unaccent (including Vietnamese đ/Đ -> d), replace non-a-z0-9 with '-', trim '-'.
 */
export function winkeyTagSlug(tag: string): string {
  if (!tag) return '';
  return tag
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // remove diacritics
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Token boundary: a token must start at the beginning of the body or after a character
 * that is not a letter, digit, '_', '@' or '#'.
 */
const TOKEN_PREFIX = '(?:^|[^\\p{L}\\p{N}_@#])';

// Mentions: @handle (3-30 chars).
// Negative lookbehind / boundary at the start, followed by @, followed by handle characters.
const MENTION_REGEX = new RegExp(
  `${TOKEN_PREFIX}@([A-Za-z0-9_.]{3,30})(?=[^\\p{L}\\p{N}_]|$)`,
  'gu',
);

// Hashtags: #tag (1-50 chars of Unicode letters, digits, and _).
const HASHTAG_REGEX = new RegExp(
  `${TOKEN_PREFIX}#([\\p{L}\\p{N}_]{1,50})(?=[^\\p{L}\\p{N}_]|$)`,
  'gu',
);

/**
 * Extracts candidate mentions and hashtags from raw text.
 */
export function extractCandidates(body: string): {
  rawHandles: string[];
  rawTags: string[];
} {
  if (!body) {
    return { rawHandles: [], rawTags: [] };
  }

  const rawHandles: string[] = [];
  const rawTags: string[] = [];

  for (const match of body.matchAll(MENTION_REGEX)) {
    let handle = match[1];
    // Strip trailing period if it was sentence-ending punctuation
    if (handle.endsWith('.') && handle.length > 3) {
      handle = handle.slice(0, -1);
    }
    rawHandles.push(handle);
  }

  for (const match of body.matchAll(HASHTAG_REGEX)) {
    const tag = match[1];
    rawTags.push(tag);
  }

  return { rawHandles, rawTags };
}

/**
 * Parses and resolves hashtags and mentions from body text:
 * - Mentions: lowercased, distinct, max 10.
 * - Hashtags: computed slugs, keep first spelling of each slug, drop empty slugs, max 10.
 */
export function parseBodyTokens(body: string): {
  handles: string[];
  hashtags: { tag: string; slug: string }[];
} {
  const { rawHandles, rawTags } = extractCandidates(body);

  // Distinct handles (case-insensitive), first 10
  const handles: string[] = [];
  const seenHandles = new Set<string>();
  for (const h of rawHandles) {
    const lower = h.toLowerCase();
    if (!seenHandles.has(lower)) {
      seenHandles.add(lower);
      handles.push(lower);
      if (handles.length >= 10) break;
    }
  }

  // Distinct hashtag slugs, keep first spelling, filter out empty slug, first 10
  const hashtags: { tag: string; slug: string }[] = [];
  const seenSlugs = new Set<string>();
  for (const tag of rawTags) {
    const slug = winkeyTagSlug(tag);
    if (slug.length > 0 && !seenSlugs.has(slug)) {
      seenSlugs.add(slug);
      hashtags.push({ tag, slug });
      if (hashtags.length >= 10) break;
    }
  }

  return { handles, hashtags };
}

export interface ResolvedMention {
  userId: string;
  handle: string;
}

/**
 * Resolves mentions against the database:
 * 1. Looks up handles in auth.public_profiles (case-insensitive).
 * 2. Filters out the author themselves.
 * 3. Filters out users in a block relationship with the author.
 * 4. Preserves the first 10 distinct valid mentions.
 */
export async function resolveMentions(
  db: Kysely<Database>,
  authorId: string,
  candidateHandles: string[],
): Promise<ResolvedMention[]> {
  if (candidateHandles.length === 0) {
    return [];
  }

  // Batch query public profiles for matching handles (case-insensitive)
  const lowerHandles = Array.from(new Set(candidateHandles.map((h) => h.toLowerCase())));

  const profiles = await db
    .selectFrom('auth.public_profiles')
    .select(['id', 'handle'])
    .where(sql`lower(handle)`, 'in', lowerHandles)
    .where('id', '!=', authorId)
    .execute();

  if (profiles.length === 0) {
    return [];
  }

  const profileUserIds = profiles.map((p) => p.id);

  // Check block relations between author and candidate profiles
  const blockedRows = await db
    .selectFrom('social.blocks')
    .select(['blocker_id', 'blocked_id'])
    .where((eb) =>
      eb.or([
        eb.and([eb('blocker_id', '=', authorId), eb('blocked_id', 'in', profileUserIds)]),
        eb.and([eb('blocker_id', 'in', profileUserIds), eb('blocked_id', '=', authorId)]),
      ]),
    )
    .execute();

  const blockedUserIds = new Set<string>();
  for (const b of blockedRows) {
    if (b.blocker_id === authorId) blockedUserIds.add(b.blocked_id);
    if (b.blocked_id === authorId) blockedUserIds.add(b.blocker_id);
  }

  const handleToProfile = new Map<string, { id: string; handle: string }>();
  for (const p of profiles) {
    if (!blockedUserIds.has(p.id)) {
      handleToProfile.set(p.handle.toLowerCase(), { id: p.id, handle: p.handle });
    }
  }

  const resolved: ResolvedMention[] = [];
  const seenUserIds = new Set<string>();

  for (const handle of candidateHandles) {
    const prof = handleToProfile.get(handle.toLowerCase());
    if (prof && !seenUserIds.has(prof.id)) {
      seenUserIds.add(prof.id);
      resolved.push({ userId: prof.id, handle: prof.handle });
      if (resolved.length >= 10) break;
    }
  }

  return resolved;
}
