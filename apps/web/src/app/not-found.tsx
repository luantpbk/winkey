import React from 'react';
import Link from 'next/link';
import { A11Y_COLORS } from '../lib/a11y-tokens';

export default function RootNotFound() {
  return (
    <html lang="vi" className="dark">
      <body className="min-h-screen bg-[#0f0f0f] text-gray-100 antialiased flex flex-col items-center justify-center px-4 text-center">
        <main data-testid="root-not-found" className="flex flex-col items-center justify-center">
          <p className={`text-sm font-bold uppercase tracking-widest ${A11Y_COLORS.brandText}`}>
            Lỗi 404
          </p>
          <h1 className="mt-2 text-2xl sm:text-3xl font-bold text-white">Không tìm thấy trang</h1>
          <p className={`mt-2 max-w-md text-sm sm:text-base ${A11Y_COLORS.textMuted}`}>
            Trang bạn đang tìm kiếm không tồn tại hoặc đã bị di chuyển.
          </p>
          <div className="mt-6">
            <Link
              href="/"
              className={`inline-flex items-center justify-center min-h-11 min-w-11 px-6 rounded-xl text-sm font-semibold transition-colors ${A11Y_COLORS.brandSolidBg}`}
            >
              Về trang chủ
            </Link>
          </div>
        </main>
      </body>
    </html>
  );
}
