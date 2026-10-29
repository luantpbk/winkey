interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const ipLimits = new Map<string, RateLimitEntry>();

export function resetRateLimitsForTest(): void {
  ipLimits.clear();
}

export function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  if (ipLimits.size > 10_000) {
    for (const [k, v] of ipLimits.entries()) {
      if (now >= v.resetAt) {
        ipLimits.delete(k);
      }
    }
  }

  const entry = ipLimits.get(ip);
  if (!entry || now >= entry.resetAt) {
    ipLimits.set(ip, { count: 1, resetAt: now + 60_000 });
    return true;
  }

  if (entry.count >= 60) {
    return false;
  }

  entry.count += 1;
  return true;
}

export function getClientIp(request: Request): string {
  const xff = request.headers.get('x-forwarded-for');
  if (xff) {
    const firstHop = xff.split(',')[0].trim();
    if (firstHop) return firstHop;
  }
  return '127.0.0.1';
}

export function stripQueryAndFragment(uri: unknown): string {
  if (typeof uri !== 'string' || !uri) return '';
  return uri.split('?')[0].split('#')[0];
}

export interface ViolationData {
  effectiveDirective: string;
  blockedUri: string;
  documentUri: string;
  disposition: string;
  statusCode: number;
}

export function extractViolations(body: unknown): ViolationData[] {
  const violations: ViolationData[] = [];
  if (!body || typeof body !== 'object') return violations;

  if (Array.isArray(body)) {
    for (const item of body) {
      if (item && typeof item === 'object') {
        const itemRecord = item as Record<string, unknown>;
        const b = (
          typeof itemRecord.body === 'object' && itemRecord.body !== null
            ? itemRecord.body
            : itemRecord
        ) as Record<string, unknown>;

        const effectiveDirective =
          b.effectiveDirective ||
          b['effective-directive'] ||
          b.effective_directive ||
          b.violatedDirective ||
          '';
        const blockedUri = b.blockedURL || b['blocked-uri'] || b.blocked_uri || b.blockedURI || '';
        const documentUri =
          b.documentURL || b['document-uri'] || b.document_uri || itemRecord.url || '';
        const disposition = b.disposition || 'report';
        const rawCode = b.statusCode ?? b['status-code'] ?? b.status_code ?? 0;
        const statusCode =
          typeof rawCode === 'number' ? rawCode : parseInt(String(rawCode), 10) || 0;

        violations.push({
          effectiveDirective: String(effectiveDirective),
          blockedUri: String(blockedUri),
          documentUri: String(documentUri),
          disposition: String(disposition),
          statusCode,
        });
      }
    }
  } else {
    const record = body as Record<string, unknown>;
    const rep = (
      typeof record['csp-report'] === 'object' && record['csp-report'] !== null
        ? record['csp-report']
        : record
    ) as Record<string, unknown>;

    const effectiveDirective =
      rep['effective-directive'] ||
      rep.effective_directive ||
      rep.effectiveDirective ||
      rep['violated-directive'] ||
      '';
    const blockedUri = rep['blocked-uri'] || rep.blocked_uri || rep.blockedURI || '';
    const documentUri = rep['document-uri'] || rep.document_uri || rep.documentURI || '';
    const disposition = rep.disposition || 'report';
    const rawCode = rep['status-code'] ?? rep.status_code ?? rep.statusCode ?? 0;
    const statusCode = typeof rawCode === 'number' ? rawCode : parseInt(String(rawCode), 10) || 0;

    violations.push({
      effectiveDirective: String(effectiveDirective),
      blockedUri: String(blockedUri),
      documentUri: String(documentUri),
      disposition: String(disposition),
      statusCode,
    });
  }

  return violations;
}
