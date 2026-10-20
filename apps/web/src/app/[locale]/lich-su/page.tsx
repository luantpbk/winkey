import React from 'react';
import type { Metadata } from 'next';
import { HistoryView } from '../../../components/history/history-view';

// Private per-user page: never indexed (the root title template adds "| Winkey").
export const metadata: Metadata = {
  title: 'Lịch sử xem',
  description: 'Quản lý và xem lại các video bạn đã xem trên Winkey.',
  robots: { index: false, follow: false },
};

export default function LichSuPage() {
  return <HistoryView />;
}
