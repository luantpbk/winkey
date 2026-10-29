export function encodeCursor<T extends object>(data: T): string {
  return Buffer.from(JSON.stringify(data), 'utf8').toString('base64url');
}

export function decodeCursor<T extends object>(cursor: string): T | null {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
