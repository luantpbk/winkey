import React from 'react';
import type { Metadata } from 'next';
import { setRequestLocale } from 'next-intl/server';
import { CinemaView } from '../../../components/cinema/cinema-view';

// Read process.env at request time, not at build time
export const dynamic = 'force-dynamic';

interface CinemaPageProps {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ v?: string }>;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const isEn = locale === 'en';
  return {
    title: isEn ? 'Movies — Winkey' : 'Phim — Winkey',
    description: isEn
      ? 'Watch featured movies and top videos on Winkey VN'
      : 'Trang phim điện ảnh và video tuyển chọn hấp dẫn trên Winkey VN',
  };
}

export default async function CinemaPage({ params, searchParams }: CinemaPageProps) {
  const { locale } = await params;
  setRequestLocale(locale);

  const { v: initialVideoId } = await searchParams;
  const curatorHandle = process.env.CINEMA_CURATOR_HANDLE || '';

  return <CinemaView curatorHandle={curatorHandle} initialVideoId={initialVideoId} />;
}
