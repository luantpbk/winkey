/**
 * Sanitizes and validates the runtime FEEDBACK_URL environment variable.
 *
 * Rules (per ADR-034 and BETA1-web):
 * - Read in a server component / server context from `process.env.FEEDBACK_URL`.
 * - Empty, whitespace, or unset -> returns null (the feedback link will be hidden).
 * - Only 'https:' and 'mailto:' protocols are allowed; anything else -> returns null (hidden).
 * - Never fall back to '#feedback' and never use 'NEXT_PUBLIC_FEEDBACK_URL'.
 */
export function sanitizeFeedbackUrl(url: string | null | undefined): string | null {
  if (!url || typeof url !== 'string') {
    return null;
  }
  const trimmed = url.trim();
  if (!trimmed) {
    return null;
  }

  // Handle mailto: URLs explicitly in case parser variations exist
  if (trimmed.toLowerCase().startsWith('mailto:')) {
    // Must contain an address after 'mailto:'
    const address = trimmed.slice(7).trim();
    if (address.length > 0) {
      return trimmed;
    }
    return null;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'https:') {
      return trimmed;
    }
    return null;
  } catch {
    return null;
  }
}

export { useFeedbackUrl } from './use-feedback-url';
