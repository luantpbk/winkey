import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Notifications - Winkey',
  robots: {
    index: false,
    follow: false,
  },
};

export default function NotificationsLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
