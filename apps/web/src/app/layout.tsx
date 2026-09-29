import './globals.css';
import type { ReactNode } from 'react';

export const metadata = {
  title: 'Winkey — Video Streaming Platform',
  description: 'Nền tảng chia sẻ và phát video trực tuyến tốc độ cao.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return children;
}
