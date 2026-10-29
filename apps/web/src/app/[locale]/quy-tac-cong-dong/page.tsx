import React from 'react';
import type { Metadata } from 'next';
import { setRequestLocale } from 'next-intl/server';
import { LegalDoc } from '../../../components/legal/legal-doc';
import { getLegalContent } from '../../../lib/legal';

export const metadata: Metadata = {
  title: 'Quy tắc cộng đồng',
  description:
    'Quy tắc cộng đồng và tiêu chuẩn nội dung trên nền tảng Winkey (bản thử nghiệm beta).',
};

interface CommunityRulesPageProps {
  params: Promise<{ locale: string }>;
}

export default async function CommunityRulesPage({ params }: CommunityRulesPageProps) {
  const { locale } = await params;
  setRequestLocale(locale);

  const content = getLegalContent('community.vi.md');

  return <LegalDoc content={content} locale={locale} />;
}
