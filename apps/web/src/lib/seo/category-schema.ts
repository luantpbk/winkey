import type { VideoSummary } from '@winkey/api-client';
import type { CategoryDefinition } from './categories';

export interface CategoryCollectionPageSchema {
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

export interface CategoryBreadcrumbListSchema {
  '@context': 'https://schema.org';
  '@type': 'BreadcrumbList';
  itemListElement: Array<{
    '@type': 'ListItem';
    position: number;
    name: string;
    item: string;
  }>;
}

export function buildCategoryCollectionPageSchema(
  category: CategoryDefinition,
  videos: VideoSummary[],
  baseUrl = 'https://winkey.vn',
): CategoryCollectionPageSchema {
  return {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: category.name,
    url: `${baseUrl}/the-loai/${category.slug}`,
    description: category.description,
    mainEntity: {
      '@type': 'ItemList',
      itemListElement: videos.slice(0, 20).map((video, idx) => ({
        '@type': 'ListItem',
        position: idx + 1,
        url: `${baseUrl}/watch/${video.id}`,
      })),
    },
  };
}

export function buildCategoryBreadcrumbSchema(
  category: CategoryDefinition,
  baseUrl = 'https://winkey.vn',
): CategoryBreadcrumbListSchema {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      {
        '@type': 'ListItem',
        position: 1,
        name: 'Trang chủ',
        item: baseUrl,
      },
      {
        '@type': 'ListItem',
        position: 2,
        name: 'Thể loại',
        item: `${baseUrl}/the-loai`,
      },
      {
        '@type': 'ListItem',
        position: 3,
        name: category.name,
        item: `${baseUrl}/the-loai/${category.slug}`,
      },
    ],
  };
}
