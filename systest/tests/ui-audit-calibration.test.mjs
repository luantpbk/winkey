// systest/tests/ui-audit-calibration.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('UI Audit Calibration Integration Wrapper', async () => {
  const auditDir = path.resolve(__dirname, '../ui-audit');
  const tsxBin = path.resolve(auditDir, 'node_modules/.bin/tsx');
  const testScript = path.resolve(auditDir, 'src/calibration.test.ts');

  await new Promise((resolve, reject) => {
    const child = spawn(tsxBin, ['--test', testScript], {
      cwd: auditDir,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve(code);
      } else {
        reject(new Error(`Calibration test suite exited with code ${code}`));
      }
    });

    child.on('error', (err) => {
      reject(err);
    });
  });

  assert.ok(true, 'UI audit calibration suite successfully verified.');
});
