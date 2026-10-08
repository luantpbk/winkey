import React from 'react';
import type { Metadata } from 'next';
import { setRequestLocale } from 'next-intl/server';
import { routing } from '../../../i18n/routing';
import { LegalDoc } from '../../../components/legal/legal-doc';
import { getLegalContent } from '../../../lib/legal';

export const metadata: Metadata = {
  title: 'Chính sách quyền riêng tư – Winkey',
  description:
    'Chính sách quyền riêng tư và bảo vệ dữ liệu cá nhân theo Nghị định 13/2023/NĐ-CP của Winkey.',
};

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

interface PrivacyPageProps {
  params: Promise<{ locale: string }>;
}

export default async function PrivacyPage({ params }: PrivacyPageProps) {
  const { locale } = await params;
  setRequestLocale(locale);

  const content = getLegalContent('privacy.vi.md');

  return <LegalDoc content={content} locale={locale} />;
}
