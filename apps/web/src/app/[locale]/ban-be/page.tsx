import React from 'react';
import type { Metadata } from 'next';
import { FriendsView } from '../../../components/social/friends-view';

// Private per-user page: never indexed (the root title template adds "| Winkey").
export const metadata: Metadata = {
  title: 'Bạn bè',
  description: 'Bạn bè, lời mời kết bạn và tìm người dùng trên Winkey.',
  robots: { index: false, follow: false },
};

export default async function BanBePage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab } = await searchParams;
  return <FriendsView initialTab={tab} />;
}
