import React from 'react';
import { Link } from '../../i18n/routing';
import { A11Y_COLORS } from '../../lib/a11y-tokens';

export default function LocaleNotFound() {
  return (
    <main
      data-testid="locale-not-found"
      className="min-h-[70vh] w-full flex flex-col items-center justify-center px-4 text-center"
    >
      <p className={`text-sm font-bold uppercase tracking-widest ${A11Y_COLORS.brandText}`}>
        Lỗi 404
      </p>
      <h1 className="mt-2 text-2xl sm:text-3xl font-bold text-gray-900 dark:text-zinc-100">
        Không tìm thấy trang
      </h1>
      <p className={`mt-2 max-w-md text-sm sm:text-base ${A11Y_COLORS.textMuted}`}>
        Trang bạn đang tìm kiếm không tồn tại, đã bị xoá hoặc đường dẫn không chính xác.
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
  );
}
