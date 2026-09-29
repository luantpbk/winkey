import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import openapiTS, { astToString } from 'openapi-typescript';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../../..');
const outDir = path.resolve(__dirname, '../src/types');

const contracts = [
  { name: 'auth', file: path.join(rootDir, 'contracts/openapi/auth.v1.yaml') },
  { name: 'upload', file: path.join(rootDir, 'contracts/openapi/upload.v1.yaml') },
  { name: 'video', file: path.join(rootDir, 'contracts/openapi/video.v1.yaml') },
];

export async function generateAll(): Promise<Map<string, string>> {
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const results = new Map<string, string>();

  for (const contract of contracts) {
    console.log(`Generating types for ${contract.name} from ${path.relative(rootDir, contract.file)}...`);
    const fileUrl = new URL(`file:///${contract.file.replace(/\\/g, '/')}`);
    const ast = await openapiTS(fileUrl);
    const content = astToString(ast);
    const targetPath = path.join(outDir, `${contract.name}.ts`);
    results.set(targetPath, content);
  }

  return results;
}

async function main() {
  const generated = await generateAll();
  for (const [targetPath, content] of generated.entries()) {
    fs.writeFileSync(targetPath, content, 'utf8');
    console.log(`Wrote ${path.relative(rootDir, targetPath)}`);
  }
  console.log('OpenAPI type generation complete.');
}

if (process.argv[1] === __filename) {
  main().catch((err) => {
    console.error('Generation failed:', err);
    process.exit(1);
  });
}
