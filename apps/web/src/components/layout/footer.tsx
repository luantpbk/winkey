'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '../../i18n/routing';
import { getAllCategories } from '../../lib/seo/categories';
import { useFeedbackUrl } from '../../lib/feedback';

export interface FooterProps {
  feedbackUrl?: string | null;
  testId?: string;
  className?: string;
}

export function Footer({
  feedbackUrl: propFeedbackUrl,
  testId = 'site-footer',
  className = '',
}: FooterProps) {
  const tCin = useTranslations('cinema');
  const tLegal = useTranslations('legal');
  const feedbackUrl = useFeedbackUrl(propFeedbackUrl);
  const categories = getAllCategories();

  return (
    <footer
      data-testid={testId}
      className={`border-t border-[#272727] dark:border-[#272727] border-gray-200 bg-[#0f0f0f] dark:bg-[#0f0f0f] bg-white text-gray-700 dark:text-gray-300 px-6 sm:px-12 py-10 flex flex-col gap-8 text-sm ${className}`}
    >
      <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
        {/* Về Winkey */}
        <div className="flex flex-col gap-2">
          <h3 className="font-bold text-base text-gray-900 dark:text-white">Về Winkey</h3>
          <p className="text-xs text-gray-500 dark:text-gray-400 leading-relaxed">
            Winkey là nền tảng chia sẻ video và xem phim trực tuyến hàng đầu tại Việt Nam. Thưởng
            thức hàng ngàn phim, phim bộ, video âm nhạc, highlights game và nội dung giải trí chất
            lượng cao miễn phí.
          </p>
        </div>

        {/* Thể loại */}
        <div className="flex flex-col gap-2">
          <h3 className="font-bold text-base text-gray-900 dark:text-white">Thể loại giải trí</h3>
          <div className="grid grid-cols-2 gap-x-2 gap-y-0 text-xs">
            {categories.map((cat) => (
              <Link
                key={cat.slug}
                href={`/the-loai/${cat.slug}`}
                className="inline-flex items-center min-h-11 min-w-11 py-2 text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition hover:underline"
              >
                {cat.name}
              </Link>
            ))}
          </div>
        </div>

        {/* Điều khoản & Pháp lý */}
        <div className="flex flex-col gap-2">
          <h3 className="font-bold text-base text-gray-900 dark:text-white">
            Điều khoản & Chính sách
          </h3>
          <nav aria-label={tLegal('legalNav')} className="flex flex-col gap-0 text-xs">
            <Link
              href="/dieu-khoan"
              className="inline-flex items-center min-h-11 min-w-11 py-2 text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition hover:underline"
            >
              {tCin('terms')}
            </Link>
            <Link
              href="/quyen-rieng-tu"
              className="inline-flex items-center min-h-11 min-w-11 py-2 text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition hover:underline"
            >
              {tCin('privacy')}
            </Link>
            <Link
              href="/quy-tac-cong-dong"
              className="inline-flex items-center min-h-11 min-w-11 py-2 text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition hover:underline"
            >
              {tCin('communityRules')}
            </Link>
            {feedbackUrl && (
              <a
                href={feedbackUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center min-h-11 min-w-11 py-2 text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition hover:underline"
              >
                {tCin('betaFeedback')}
              </a>
            )}
          </nav>
        </div>
      </div>

      <div className="pt-6 border-t border-[#272727] dark:border-[#272727] border-gray-200 flex flex-wrap items-center justify-between gap-4 text-xs text-gray-500 dark:text-gray-400">
        <span>{tCin('copyright')}</span>
        <span>Winkey VN – Nền tảng video giải trí Việt Nam</span>
      </div>
    </footer>
  );
}
