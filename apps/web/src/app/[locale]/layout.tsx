import type { ReactNode } from 'react';
import { headers } from 'next/headers';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages, setRequestLocale } from 'next-intl/server';
import { Providers } from '../../components/providers';
import { Shell } from '../../components/layout/shell';

export default async function LocaleLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const messages = await getMessages();

  const headersList = await headers();
  const nonce = headersList.get('x-nonce') ?? undefined;

  return (
    <html lang={locale} className="dark" suppressHydrationWarning>
      <body className="bg-[#0f0f0f] text-gray-100 antialiased min-h-screen">
        <NextIntlClientProvider locale={locale} messages={messages}>
          <Providers nonce={nonce}>
            <Shell>{children}</Shell>
          </Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
