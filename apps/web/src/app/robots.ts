import type { MetadataRoute } from 'next';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: [
        '/studio',
        '/admin',
        '/upload',
        '/thu-vien',
        '/settings',
        '/notifications',
        '/login',
        '/register',
      ],
    },
    sitemap: 'https://winkey.vn/sitemap.xml',
  };
}
