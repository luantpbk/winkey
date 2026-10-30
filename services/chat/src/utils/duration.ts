/** Parses "500ms", "30s", "15m", "1h", "30d" (a bare number is milliseconds); `fallbackMs` when malformed. */
export function parseDurationMs(duration: string, fallbackMs = 3600_000): number {
  const match = duration.match(/^(\d+)(ms|s|m|h|d)?$/);
  if (!match) return fallbackMs;
  const val = parseInt(match[1]!, 10);
  switch (match[2] || 'ms') {
    case 's':
      return val * 1000;
    case 'm':
      return val * 60 * 1000;
    case 'h':
      return val * 60 * 60 * 1000;
    case 'd':
      return val * 24 * 60 * 60 * 1000;
    default:
      return val;
  }
}
