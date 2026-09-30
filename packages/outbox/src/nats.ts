import type { ConnectionOptions } from 'nats';

/**
 * Extracts NATS connection options from a raw NATS URL, properly parsing
 * and decoding URL-encoded credentials (username and password) if present.
 *
 * @param raw The raw NATS URL (e.g. nats://user:pass@host:4222 or nats://host:4222)
 * @returns ConnectionOptions suitable for nats.connect(...)
 */
export function natsOptionsFromUrl(raw: string): ConnectionOptions {
  const u = new URL(raw);
  const opts: ConnectionOptions = { servers: `${u.protocol}//${u.host}` };
  if (u.username) {
    opts.user = decodeURIComponent(u.username);
    opts.pass = decodeURIComponent(u.password);
  }
  return opts;
}
