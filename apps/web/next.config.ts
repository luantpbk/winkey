import createNextIntlPlugin from 'next-intl/plugin';
import type { NextConfig } from 'next';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const isWindows = process.platform === 'win32';
// In Docker (Linux) or when explicitly requested, use standalone output.
// On Windows without Developer Mode, symlinks in standalone trace fail with EPERM.
const nextConfig: NextConfig = {
  output: !isWindows || process.env.STANDALONE === '1' ? 'standalone' : undefined,
  images: {
    unoptimized: true,
  },
  htmlLimitedBots:
    /Googlebot|Google Favicon|Google-InspectionTool|Storebot-Google|bingbot|Bingbot|BingPreview|DuckDuckBot|YandexBot|Baiduspider|coccocbot|Applebot|facebookexternalhit|Twitterbot|LinkedInBot|Slackbot|Discordbot|Zalo|TelegramBot|WhatsApp/i,
  async rewrites() {
    return [
      {
        source: '/v1/:path*',
        destination: `${process.env.API_INTERNAL_URL ?? 'http://localhost:8080'}/v1/:path*`,
      },
    ];
  },
  async headers() {
    const isDev = process.env.NODE_ENV === 'development';
    const scriptSrc = isDev
      ? "script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' 'unsafe-inline' https://challenges.cloudflare.com; frame-src 'self' https://challenges.cloudflare.com; worker-src 'self' blob:;"
      : "script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline' https://challenges.cloudflare.com; frame-src 'self' https://challenges.cloudflare.com; worker-src 'self' blob:;";

    return [
      {
        source: '/embed/:path*',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: 'frame-ancestors *',
          },
        ],
      },
      {
        source: '/((?!embed).*)',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: scriptSrc,
          },
        ],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
