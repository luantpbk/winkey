import fs from 'node:fs';
import path from 'node:path';

/**
 * Reads a legal markdown document verbatim from `content/legal/<filename>`.
 */
export function getLegalContent(filename: string): string {
  const candidates = [
    path.join(process.cwd(), 'content/legal', filename),
    path.join(process.cwd(), 'apps/web/content/legal', filename),
    path.resolve(__dirname, '../../content/legal', filename),
    path.resolve(__dirname, '../../../content/legal', filename),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return fs.readFileSync(candidate, 'utf-8');
    }
  }

  throw new Error(
    `Legal file not found: ${filename} (searched candidates: ${candidates.join(', ')})`,
  );
}
