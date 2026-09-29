import type { PublicProfileDto } from '../db/types.js';

export function formatPublicProfile(
  profile:
    | {
        id: string;
        handle: string;
        display_name: string;
        avatar_key: string | null;
      }
    | null
    | undefined,
  mediaBaseUrl: string,
): PublicProfileDto | null {
  if (!profile) return null;
  const baseUrl = mediaBaseUrl.replace(/\/$/, '');
  const avatarKey = profile.avatar_key?.replace(/^\//, '');
  return {
    id: profile.id,
    handle: profile.handle,
    display_name: profile.display_name,
    avatar_url: avatarKey ? `${baseUrl}/${avatarKey}` : null,
  };
}
