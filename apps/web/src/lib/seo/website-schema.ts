export interface WebSiteSchema {
  '@context': 'https://schema.org';
  '@type': 'WebSite';
  name: string;
  alternateName?: string[];
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

export interface OrganizationSchema {
  '@context': 'https://schema.org';
  '@type': 'Organization';
  name: string;
  url: string;
  logo: string;
  sameAs?: string[];
}

/**
 * Builds Schema.org WebSite JSON-LD with SearchAction and alternateName for the homepage.
 */
export function buildWebSiteSchema(baseUrl = 'https://winkey.vn'): WebSiteSchema {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: 'Winkey',
    alternateName: ['Winkey.vn', 'winkey'],
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

/**
 * Builds Schema.org Organization JSON-LD with official brand logo for Google Brand Recognition.
 */
export function buildOrganizationSchema(baseUrl = 'https://winkey.vn'): OrganizationSchema {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: 'Winkey',
    url: baseUrl,
    logo: `${baseUrl}/logo.png`,
  };
}
