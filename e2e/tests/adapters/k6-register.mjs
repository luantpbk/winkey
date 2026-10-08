import { register } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
register('./k6-loader.mjs', import.meta.url);

// Provide default k6 globals required by scripts
const loadtestDir = path.resolve(__dirname, '../../../loadtest');
globalThis.__ENV = globalThis.__ENV || {
  TARGET_URL: 'http://127.0.0.1:8080',
  EXECUTOR: 'constant-vus',
  VUS: '1',
  DURATION: '10s',
};
globalThis.__VU = 1;
globalThis.__ITER = 0;
globalThis.open = (filePath) => {
  const fullPath = path.resolve(loadtestDir, filePath);
  if (fs.existsSync(fullPath)) {
    return fs.readFileSync(fullPath, 'utf8');
  }
  return '{}';
};
