import type { ReactNode } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages, setRequestLocale } from 'next-intl/server';
import { routing } from '../../i18n/routing';
import { Providers } from '../../components/providers';
import { Shell } from '../../components/layout/shell';
import { sanitizeFeedbackUrl } from '../../lib/feedback';

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

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
  const feedbackUrl = sanitizeFeedbackUrl(process.env.FEEDBACK_URL);

  return (
    <html lang={locale} className="dark" suppressHydrationWarning>
      <body className="bg-[#0f0f0f] text-gray-100 antialiased min-h-screen">
        <NextIntlClientProvider locale={locale} messages={messages}>
          <Providers>
            <Shell feedbackUrl={feedbackUrl}>{children}</Shell>
          </Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
