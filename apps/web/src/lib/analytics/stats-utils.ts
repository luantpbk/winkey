/**
 * Utility functions for studio creator analytics (task R1-b).
 * Timezone: Asia/Ho_Chi_Minh (UTC+7) per contracts/openapi/video.v1.yaml.
 */

export const STATS_TIMEZONE = 'Asia/Ho_Chi_Minh';

export type StatsRangeOption = 7 | 28 | 90;

/**
 * Returns date in Asia/Ho_Chi_Minh as YYYY-MM-DD.
 */
export function formatVietnamDate(date: Date = new Date()): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: STATS_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(date);
}

/**
 * Computes { from, to } date strings in Asia/Ho_Chi_Minh for 7, 28, or 90 days.
 *
 * Contract rules:
 * - `to` is today in Asia/Ho_Chi_Minh.
 * - 7 days: to minus 6 days.
 * - 28 days: to minus 27 days (contract default).
 * - 90 days: to minus 89 days (max range).
 */
export function getStatsDateRange(
  days: 7 | 28 | 90,
  now: Date = new Date(),
): { from: string; to: string } {
  const toStr = formatVietnamDate(now);
  const [toYear, toMonth, toDay] = toStr.split('-').map(Number);

  // Asia/Ho_Chi_Minh has no DST (UTC+7 permanently), so UTC day arithmetic maps 1:1 to calendar days.
  const toUtcMs = Date.UTC(toYear, toMonth - 1, toDay);
  const fromUtcMs = toUtcMs - (days - 1) * 86_400_000;
  const fromDate = new Date(fromUtcMs);

  const fromYear = fromDate.getUTCFullYear();
  const fromMonth = String(fromDate.getUTCMonth() + 1).padStart(2, '0');
  const fromDay = String(fromDate.getUTCDate()).padStart(2, '0');
  const fromStr = `${fromYear}-${fromMonth}-${fromDay}`;

  return { from: fromStr, to: toStr };
}

/**
 * Format total watch time (ms) as h:mm.
 * Returns '0:00' when null, undefined or 0.
 */
export function formatWatchTime(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || isNaN(ms)) return '0:00';
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const minutesStr = String(minutes).padStart(2, '0');
  return `${hours}:${minutesStr}`;
}

/**
 * Format average watch time (ms) as m:ss.
 * Returns '—' when null or undefined. Never returns NaN.
 */
export function formatAvgWatchTime(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || isNaN(ms)) return '—';
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const secondsStr = String(seconds).padStart(2, '0');
  return `${minutes}:${secondsStr}`;
}

/**
 * Format rebuffer ratio (0..1) as a percentage string (e.g. 1.5%).
 * Returns '—' when null or undefined. Never returns NaN.
 */
export function formatRebufferRatio(ratio: number | null | undefined): string {
  if (ratio === null || ratio === undefined || isNaN(ratio)) return '—';
  const pct = ratio * 100;
  return `${pct.toFixed(1)}%`;
}

/**
 * Format startup latency (ms) for p50/p95.
 * Returns '—' when null or undefined.
 */
export function formatStartupMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || isNaN(ms)) return '—';
  return `${Math.round(ms)} ms`;
}

/**
 * Format starts count with locale separators.
 */
export function formatStarts(starts: number | null | undefined): string {
  if (starts === null || starts === undefined || isNaN(starts)) return '0';
  return new Intl.NumberFormat('vi-VN').format(starts);
}

/**
 * Format refreshed_at timestamp in Asia/Ho_Chi_Minh.
 * Returns null when null, undefined, or invalid date.
 */
export function formatRefreshedAt(
  isoString: string | null | undefined,
  locale: string = 'vi',
): string | null {
  if (!isoString) return null;
  const date = new Date(isoString);
  if (isNaN(date.getTime())) return null;

  return new Intl.DateTimeFormat(locale === 'vi' ? 'vi-VN' : 'en-US', {
    timeZone: STATS_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}
