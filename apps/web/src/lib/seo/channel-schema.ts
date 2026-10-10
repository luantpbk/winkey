import type { PublicProfile } from '@winkey/api-client';

export interface PersonSchema {
  '@context': 'https://schema.org';
  '@type': 'Person';
  name: string;
  alternateName: string;
  url: string;
  image?: string;
}

/**
 * Builds Schema.org Person JSON-LD for a creator channel.
 */
export function buildPersonSchema(
  profile: PublicProfile,
  baseUrl = 'https://winkey.vn',
): PersonSchema {
  return {
    '@context': 'https://schema.org',
    '@type': 'Person',
    name: profile.display_name,
    alternateName: `@${profile.handle}`,
    url: `${baseUrl}/c/${profile.handle}`,
    image: profile.avatar_url || undefined,
  };
}
