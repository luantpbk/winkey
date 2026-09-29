import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateAll } from './generate.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../../..');

function normalize(str: string): string {
  return str.replace(/\r\n/g, '\n').trim();
}

async function checkStale() {
  console.log('Checking if generated OpenAPI types are up to date...');
  const generated = await generateAll();
  let hasStale = false;

  for (const [targetPath, freshContent] of generated.entries()) {
    const relPath = path.relative(rootDir, targetPath);
    if (!fs.existsSync(targetPath)) {
      console.error(`ERROR: Target file does not exist: ${relPath}`);
      hasStale = true;
      continue;
    }

    const existingContent = fs.readFileSync(targetPath, 'utf8');
    const normExisting = normalize(existingContent);
    const normFresh = normalize(freshContent);
    if (normExisting !== normFresh) {
      console.error(`ERROR: Generated file is stale: ${relPath}`);
      console.error(`Existing length: ${normExisting.length}, Fresh length: ${normFresh.length}`);
      for (let i = 0; i < Math.max(normExisting.length, normFresh.length); i++) {
        if (normExisting[i] !== normFresh[i]) {
          console.error(`Diff at index ${i}:`);
          console.error(
            `Existing: ${JSON.stringify(normExisting.slice(Math.max(0, i - 20), i + 40))}`,
          );
          console.error(
            `Fresh:    ${JSON.stringify(normFresh.slice(Math.max(0, i - 20), i + 40))}`,
          );
          break;
        }
      }
      hasStale = true;
    } else {
      console.log(`OK: ${relPath} is up to date.`);
    }
  }

  if (hasStale) {
    console.error('\nGenerated OpenAPI types are stale or missing.');
    console.error('Please run `pnpm --filter @winkey/api-client run generate` to update them.\n');
    process.exit(1);
  }

  console.log('\nAll generated OpenAPI types are fresh and match OpenAPI specs.');
}

checkStale().catch((err) => {
  console.error('Check failed:', err);
  process.exit(1);
});
