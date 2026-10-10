export interface WebSiteSchema {
  '@context': 'https://schema.org';
  '@type': 'WebSite';
  name: string;
  url: string;
  potentialAction: {
    '@type': 'SearchAction';
    target: {
      '@type': 'EntryPoint';
      urlTemplate: string;
    };
    'query-input': string;
  };
}

/**
 * Builds Schema.org WebSite JSON-LD with SearchAction for the homepage.
 */
export function buildWebSiteSchema(baseUrl = 'https://winkey.vn'): WebSiteSchema {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: 'Winkey',
    url: baseUrl,
    potentialAction: {
      '@type': 'SearchAction',
      target: {
        '@type': 'EntryPoint',
        urlTemplate: `${baseUrl}/kham-pha?q={search_term_string}`,
      },
      'query-input': 'required name=search_term_string',
    },
  };
}
