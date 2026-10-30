/**
 * CSP Policy Builder for Winkey (ADR-049 / CSP1)
 */

const warnedOrigins = new Set<string>();

export function resetWarnedOriginsForTest(): void {
  warnedOrigins.clear();
}

export interface BuildCspOptions {
  nonce: string;
  isDev?: boolean;
  embed?: boolean;
  mediaOrigin?: string;
  uploadOrigin?: string;
  upgradeInsecureRequests?: boolean;
}

export function isValidOrigin(val: unknown): val is string {
  if (typeof val !== 'string' || !val.trim()) return false;
  const trimmed = val.trim();
  if (trimmed === '*' || trimmed === "'*'") return false;
  try {
    const url = new URL(trimmed);
    return url.origin === trimmed;
  } catch {
    return false;
  }
}

export function validateOrigin(val: string | undefined | null, name: string): string | undefined {
  if (!val) return undefined;
  const trimmed = val.trim();
  if (!trimmed) return undefined;
  if (isValidOrigin(trimmed)) {
    return trimmed;
  }
  if (!warnedOrigins.has(trimmed)) {
    warnedOrigins.add(trimmed);
    console.warn(`[csp] ignoring invalid origin for ${name}: "${val}"`);
  }
  return undefined;
}

export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('base64');
}

export function buildCsp(options: BuildCspOptions): string {
  const {
    nonce,
    isDev = process.env.NODE_ENV === 'development',
    embed = false,
    mediaOrigin = process.env.CSP_MEDIA_ORIGIN,
    uploadOrigin = process.env.CSP_UPLOAD_ORIGIN,
    upgradeInsecureRequests = false,
  } = options;

  const validMedia = validateOrigin(mediaOrigin, 'CSP_MEDIA_ORIGIN');
  const validUpload = validateOrigin(uploadOrigin, 'CSP_UPLOAD_ORIGIN');

  const scriptSrc = ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'", "'wasm-unsafe-eval'"];
  if (isDev) {
    scriptSrc.push("'unsafe-eval'");
  }
  scriptSrc.push('https://challenges.cloudflare.com');

  const imgSrc = ["'self'", 'data:', 'blob:'];
  if (validMedia) {
    imgSrc.push(validMedia);
  }

  const mediaSrc = ["'self'", 'blob:'];
  if (validMedia) {
    mediaSrc.push(validMedia);
  }

  const connectSrc = ["'self'"];
  if (validMedia) {
    connectSrc.push(validMedia);
  }
  if (validUpload && validUpload !== validMedia) {
    connectSrc.push(validUpload);
  }
  connectSrc.push('https://challenges.cloudflare.com');

  const directives: string[] = [
    "default-src 'self'",
    `script-src ${scriptSrc.join(' ')}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src ${imgSrc.join(' ')}`,
    `media-src ${mediaSrc.join(' ')}`,
    `connect-src ${connectSrc.join(' ')}`,
    "worker-src 'self' blob:",
    'frame-src https://challenges.cloudflare.com',
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    `frame-ancestors ${embed ? '*' : "'self'"}`,
  ];

  if (upgradeInsecureRequests) {
    directives.push('upgrade-insecure-requests');
  }

  directives.push('report-uri /api/csp-report');

  return directives.join('; ');
}
