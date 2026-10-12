import './globals.css';
import type { ReactNode } from 'react';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  metadataBase: new URL('https://winkey.vn'),
  title: {
    default: 'Winkey – Xem phim, video, nhạc và game giải trí',
    template: '%s | Winkey',
  },
  description:
    'Winkey – Nền tảng xem phim, phim bộ, video, nhạc và game giải trí trực tuyến tốc độ cao, hoàn toàn miễn phí với chất lượng hình ảnh sắc nét tại Việt Nam.',
  applicationName: 'Winkey',
  manifest: '/manifest.webmanifest',
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: '48x48 32x32 16x16' },
      { url: '/icon.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [{ url: '/apple-icon.png', sizes: '180x180', type: 'image/png' }],
  },
  openGraph: {
    type: 'website',
    locale: 'vi_VN',
    url: 'https://winkey.vn',
    siteName: 'Winkey',
    title: 'Winkey – Xem phim, video, nhạc và game giải trí',
    description:
      'Winkey – Nền tảng xem phim, phim bộ, video, nhạc và game giải trí trực tuyến tốc độ cao, hoàn toàn miễn phí với chất lượng hình ảnh sắc nét tại Việt Nam.',
    images: [
      {
        url: '/opengraph-image.png',
        width: 1200,
        height: 630,
        alt: 'Winkey – Xem phim, video, nhạc và game giải trí',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Winkey – Xem phim, video, nhạc và game giải trí',
    description:
      'Winkey – Nền tảng xem phim, phim bộ, video, nhạc và game giải trí trực tuyến tốc độ cao, hoàn toàn miễn phí với chất lượng hình ảnh sắc nét tại Việt Nam.',
    images: ['/opengraph-image.png'],
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return children;
}
