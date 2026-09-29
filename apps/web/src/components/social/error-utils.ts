import type { useTranslations } from 'next-intl';

export type TranslateFn = ReturnType<typeof useTranslations>;

/**
 * Map RFC 9457 error statuses to localized messages.
 * Prevents displaying raw English or internal server details to users.
 */
export function mapSocialError(
  status: number | undefined,
  retryAfter: string | null | undefined,
  t: TranslateFn,
  defaultKey: string,
): string {
  if (status === 401) {
    return t('unauthorized');
  }
  if (status === 403) {
    return t('forbidden');
  }
  if (status === 404) {
    return t('notFound');
  }
  if (status === 409) {
    return t('conflict');
  }
  if (status === 429) {
    const seconds = retryAfter || '30';
    return t('rateLimited', { seconds });
  }
  if (status && status >= 500) {
    return t('serverError');
  }
  return t(defaultKey);
}
