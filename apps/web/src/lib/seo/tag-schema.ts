import type { TagSummary, VideoSummary } from '@winkey/api-client';

export interface TagCollectionPageSchema {
  '@context': 'https://schema.org';
  '@type': 'CollectionPage';
  name: string;
  url: string;
  description: string;
  mainEntity: {
    '@type': 'ItemList';
    itemListElement: Array<{
      '@type': 'ListItem';
      position: number;
      url: string;
    }>;
  };
}

export interface TagBreadcrumbListSchema {
  '@context': 'https://schema.org';
  '@type': 'BreadcrumbList';
  itemListElement: Array<{
    '@type': 'ListItem';
    position: number;
    name: string;
    item: string;
  }>;
}

export function buildTagCollectionPageSchema(
  tag: TagSummary,
  videos: VideoSummary[],
  description: string,
  baseUrl = 'https://winkey.vn',
): TagCollectionPageSchema {
  return {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: `#${tag.name}`,
    url: `${baseUrl}/tag/${tag.slug}`,
    description,
    mainEntity: {
      '@type': 'ItemList',
      itemListElement: videos.map((video, idx) => ({
        '@type': 'ListItem',
        position: idx + 1,
        url: `${baseUrl}/watch/${video.id}`,
      })),
    },
  };
}

export function buildTagBreadcrumbSchema(
  tag: TagSummary,
  baseUrl = 'https://winkey.vn',
): TagBreadcrumbListSchema {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      {
        '@type': 'ListItem',
        position: 1,
        name: 'Winkey',
        item: baseUrl,
      },
      {
        '@type': 'ListItem',
        position: 2,
        name: `#${tag.name}`,
        item: `${baseUrl}/tag/${tag.slug}`,
      },
    ],
  };
}
