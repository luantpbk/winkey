import React from 'react';
import type { Metadata } from 'next';
import { setRequestLocale } from 'next-intl/server';
import { routing } from '../../../i18n/routing';
import { LegalDoc } from '../../../components/legal/legal-doc';
import { getLegalContent } from '../../../lib/legal';

export const metadata: Metadata = {
  title: 'Quy tắc cộng đồng – Winkey',
  description:
    'Quy tắc cộng đồng và tiêu chuẩn nội dung trên nền tảng Winkey (bản thử nghiệm beta).',
};

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

interface CommunityRulesPageProps {
  params: Promise<{ locale: string }>;
}

export default async function CommunityRulesPage({ params }: CommunityRulesPageProps) {
  const { locale } = await params;
  setRequestLocale(locale);

  const content = getLegalContent('community.vi.md');

  return <LegalDoc content={content} locale={locale} />;
}
