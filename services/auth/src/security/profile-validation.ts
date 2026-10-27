import type { Kysely } from 'kysely';
import type { Database, ProfileLink } from '../db/types.js';
import { ProblemError } from '../errors/problem.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function normalizeBio(rawBio: string | null | undefined): string | null | undefined {
  if (rawBio === undefined) return undefined;
  if (rawBio === null) return null;
  if (typeof rawBio !== 'string') {
    throw ProblemError.badRequest('Bio must be a string or null', undefined, 'VALIDATION_FAILED');
  }
  const trimmed = rawBio.trim();
  if (trimmed.length === 0) return null;
  if (Array.from(trimmed).length > 300) {
    throw ProblemError.badRequest(
      'Bio must not exceed 300 characters',
      undefined,
      'VALIDATION_FAILED',
    );
  }
  return trimmed;
}

export function validateProfileLinks(rawLinks: unknown): ProfileLink[] {
  if (!Array.isArray(rawLinks) || rawLinks.length > 5) {
    throw ProblemError.badRequest(
      'Links must be an array of at most 5 items',
      undefined,
      'LINK_INVALID',
    );
  }

  return rawLinks.map((item, idx) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw ProblemError.badRequest(
        `Invalid link object at index ${idx}`,
        undefined,
        'LINK_INVALID',
      );
    }

    const obj = item as Record<string, unknown>;
    const rawUrl = typeof obj.url === 'string' ? obj.url.trim() : '';
    const rawLabel = typeof obj.label === 'string' ? obj.label.trim() : '';

    const urlCharLen = Array.from(rawUrl).length;
    const labelCharLen = Array.from(rawLabel).length;

    if (urlCharLen === 0 || urlCharLen > 200) {
      throw ProblemError.badRequest(
        `URL at index ${idx} must be between 1 and 200 characters`,
        undefined,
        'LINK_INVALID',
      );
    }

    if (labelCharLen < 1 || labelCharLen > 30) {
      throw ProblemError.badRequest(
        `Label at index ${idx} must be between 1 and 30 characters`,
        undefined,
        'LINK_INVALID',
      );
    }

    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw ProblemError.badRequest(`Malformed URL at index ${idx}`, undefined, 'LINK_INVALID');
    }

    if (
      parsed.protocol !== 'https:' ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      !parsed.hostname ||
      parsed.hostname.trim() === ''
    ) {
      throw ProblemError.badRequest(
        `URL at index ${idx} must use https://, contain a valid host, and omit credentials`,
        undefined,
        'LINK_INVALID',
      );
    }

    return { url: rawUrl, label: rawLabel };
  });
}

export async function resolveReadyImageKey(
  db: Kysely<Database>,
  imageId: string | null | undefined,
  callerId: string,
  purpose: 'AVATAR' | 'BANNER',
): Promise<string | null | undefined> {
  if (imageId === undefined) return undefined;
  if (imageId === null) return null;

  if (typeof imageId !== 'string' || !UUID_REGEX.test(imageId)) {
    throw ProblemError.badRequest(`Image ${imageId} is invalid`, undefined, 'IMAGE_INVALID');
  }

  const row = await db
    .selectFrom('media.ready_images')
    .select('image_key')
    .where('id', '=', imageId)
    .where('owner_id', '=', callerId)
    .where('purpose', '=', purpose)
    .executeTakeFirst();

  if (!row || !row.image_key) {
    throw ProblemError.badRequest(
      `Image ${imageId} is not ready, not owned by caller, or wrong purpose`,
      undefined,
      'IMAGE_INVALID',
    );
  }

  return row.image_key;
}

export function areLinksEqual(
  a: ProfileLink[] | null | undefined,
  b: ProfileLink[] | null | undefined,
): boolean {
  const listA = a ?? [];
  const listB = b ?? [];
  if (listA.length !== listB.length) return false;
  for (let i = 0; i < listA.length; i++) {
    if (listA[i].url !== listB[i].url || listA[i].label !== listB[i].label) {
      return false;
    }
  }
  return true;
}
