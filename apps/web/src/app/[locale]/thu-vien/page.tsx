import React from 'react';
import { LibraryView } from '../../../components/library/library-view';

export const metadata = {
  title: 'Thư viện - Winkey',
  description: 'Quản lý danh sách phát và các bộ phim của bạn trên Winkey.',
};

export default function ThuVienPage() {
  return <LibraryView />;
}
