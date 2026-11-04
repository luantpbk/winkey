import { defineRouting } from 'next-intl/routing';
import { createNavigation } from 'next-intl/navigation';

export const routing = defineRouting({
  locales: ['vi', 'en'],
  defaultLocale: 'vi',
  localePrefix: 'as-needed',
  // Vietnamese is the product language: the browser language or a NEXT_LOCALE cookie never switches it (#548).
  // English only through an explicit /en URL.
  localeDetection: false,
});

export const { Link, redirect, usePathname, useRouter, getPathname } = createNavigation(routing);
