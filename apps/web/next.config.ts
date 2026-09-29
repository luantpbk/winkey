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
  async rewrites() {
    return [
      {
        source: '/v1/:path*',
        destination: `${process.env.API_INTERNAL_URL ?? 'http://localhost:8080'}/v1/:path*`,
      },
    ];
  },
};

export default withNextIntl(nextConfig);
