import React from 'react';
import type { Metadata } from 'next';
import { setRequestLocale } from 'next-intl/server';
import { routing } from '../../../i18n/routing';
import { LegalDoc } from '../../../components/legal/legal-doc';
import { getLegalContent } from '../../../lib/legal';

export const metadata: Metadata = {
  title: 'Điều khoản sử dụng – Winkey',
  description: 'Điều khoản sử dụng nền tảng chia sẻ và xem video Winkey (bản thử nghiệm beta).',
};

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

interface TermsPageProps {
  params: Promise<{ locale: string }>;
}

export default async function TermsPage({ params }: TermsPageProps) {
  const { locale } = await params;
  setRequestLocale(locale);

  const content = getLegalContent('terms.vi.md');

  return <LegalDoc content={content} locale={locale} />;
}
