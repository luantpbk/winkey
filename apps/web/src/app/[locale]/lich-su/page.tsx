import React from 'react';
import { HistoryView } from '../../../components/history/history-view';

export const metadata = {
  title: 'Lịch sử xem - Winkey',
  description: 'Quản lý và xem lại các video bạn đã xem trên Winkey.',
};

export default function LichSuPage() {
  return <HistoryView />;
}
