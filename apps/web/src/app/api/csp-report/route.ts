import { NextResponse } from 'next/server';
import {
  checkRateLimit,
  getClientIp,
  stripQueryAndFragment,
  extractViolations,
} from '../../../lib/security/csp-report';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const contentLength = request.headers.get('content-length');
  if (contentLength && parseInt(contentLength, 10) > 8192) {
    return new NextResponse('Payload Too Large', { status: 413 });
  }

  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody, 'utf8') > 8192) {
    return new NextResponse('Payload Too Large', { status: 413 });
  }

  const clientIp = getClientIp(request);
  const allowed = checkRateLimit(clientIp);
  if (!allowed) {
    // Exceeded rate limit: drop report and return 204
    return new NextResponse(null, { status: 204 });
  }

  if (rawBody.trim()) {
    try {
      const parsed = JSON.parse(rawBody);
      const violations = extractViolations(parsed);
      for (const v of violations) {
        const logEntry = {
          event: 'csp_violation',
          effective_directive: v.effectiveDirective,
          blocked_uri: stripQueryAndFragment(v.blockedUri),
          document_uri: stripQueryAndFragment(v.documentUri),
          disposition: v.disposition,
          status_code: v.statusCode,
        };
        console.warn(JSON.stringify(logEntry));
      }
    } catch {
      // Ignore JSON parse errors and return 204
    }
  }

  return new NextResponse(null, { status: 204 });
}
