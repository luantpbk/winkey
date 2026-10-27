import { NextRequest, NextResponse } from 'next/server';
import createMiddleware from 'next-intl/middleware';
import { routing } from './i18n/routing';

const intlMiddleware = createMiddleware(routing);

export default function middleware(request: NextRequest) {
  const { pathname, searchParams } = request.nextUrl;

  // 1. /phim or /<locale>/phim -> 308 redirect to / or /<locale>
  const phimMatch = pathname.match(/^(\/(?:vi|en))?\/phim\/?$/);
  if (phimMatch) {
    const localePrefix = phimMatch[1] || '';
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = localePrefix ? `${localePrefix}` : '/';
    return NextResponse.redirect(redirectUrl, 308);
  }

  // 2. / or /<locale> with ?tab=<x> -> 308 redirect to /kham-pha?tab=<x> or /<locale>/kham-pha?tab=<x>
  const homeMatch = pathname.match(/^(\/(?:vi|en))?\/?$/);
  if (homeMatch && searchParams.has('tab')) {
    const localePrefix = homeMatch[1] || '';
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = `${localePrefix}/kham-pha`;
    return NextResponse.redirect(redirectUrl, 308);
  }

  // 3. /<locale>/embed/... -> 308 redirect to /embed/...
  const embedLocaleMatch = pathname.match(/^\/(?:vi|en)(\/embed(?:\/.*)?)$/);
  if (embedLocaleMatch) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = embedLocaleMatch[1];
    return NextResponse.redirect(redirectUrl, 308);
  }

  // 4. /@handle or /<locale>/@handle -> 308 redirect to /c/handle or /<locale>/c/handle (SOC-1b)
  const handleMatch = pathname.match(/^(\/(?:vi|en))?\/@([A-Za-z0-9_.]{3,30})\/?$/);
  if (handleMatch) {
    const localePrefix = handleMatch[1] || '';
    const handle = handleMatch[2];
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = `${localePrefix}/c/${handle}`;
    return NextResponse.redirect(redirectUrl, 308);
  }

  return intlMiddleware(request);
}

export const config = {
  matcher: ['/((?!api|_next|_vercel|v1|embed|mockServiceWorker.js|healthz|readyz|.*\\..*).*)'],
};
