import { NextRequest, NextResponse } from 'next/server';
import createMiddleware from 'next-intl/middleware';
import { routing } from './i18n/routing';
import { buildCsp, generateNonce } from './lib/security/csp';

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

  // API routes bypass intl middleware
  if (pathname.startsWith('/api/')) {
    return NextResponse.next();
  }

  // Generate per-request nonce (16 bytes base64)
  const nonce = generateNonce();
  const isEmbed = pathname === '/embed' || pathname.startsWith('/embed/');
  const csp = buildCsp({ nonce, embed: isEmbed });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('content-security-policy', csp);

  if (isEmbed) {
    const response = NextResponse.next({
      request: {
        headers: requestHeaders,
      },
    });
    response.headers.set('Content-Security-Policy-Report-Only', csp);
    return response;
  }

  const reqWithHeaders = new NextRequest(request, {
    headers: requestHeaders,
  });
  const response = intlMiddleware(reqWithHeaders);
  response.headers.set('Content-Security-Policy-Report-Only', csp);
  return response;
}

export const config = {
  runtime: 'nodejs',
  matcher: ['/((?!_next/static|_next/image|v1|healthz|readyz|api/csp-report|.*\\..*).*)'],
};
