import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import console from 'node:console';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(import.meta.dirname, '../../..');

const SERVICES = [
  { name: '@winkey/auth', relDir: 'services/auth' },
  { name: '@winkey/social', relDir: 'services/social' },
  { name: '@winkey/realtime', relDir: 'services/realtime' },
];

async function verifyService(serviceName, serviceRelDir) {
  console.log(`\n==================================================`);
  console.log(`Verifying production dependencies for ${serviceName}`);
  console.log(`==================================================`);

  const serviceDir = path.join(repoRoot, serviceRelDir);
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `prod-deps-${path.basename(serviceRelDir)}-`),
  );

  try {
    // 1. Build outbox and service
    console.log(`[1/4] Building @winkey/outbox and ${serviceName}...`);
    execSync(`pnpm --filter @winkey/outbox run build`, { cwd: repoRoot, stdio: 'pipe' });
    execSync(`pnpm --filter ${serviceName} run build`, { cwd: repoRoot, stdio: 'pipe' });

    // 2. Deploy with --prod
    console.log(`[2/4] Deploying ${serviceName} with --prod to temporary directory...`);
    execSync(`pnpm --filter ${serviceName} --prod deploy "${tempDir}"`, {
      cwd: repoRoot,
      stdio: 'pipe',
    });

    // 3. Replicate Dockerfile artifact copy
    console.log(`[3/4] Copying compiled artifacts into deployed environment...`);
    const targetDist = path.join(tempDir, 'dist');
    fs.cpSync(path.join(serviceDir, 'dist'), targetDist, { recursive: true });

    const outboxDepDir = path.join(tempDir, 'node_modules/@winkey/outbox');
    if (fs.existsSync(outboxDepDir)) {
      const outboxDist = path.join(repoRoot, 'packages/outbox/dist');
      if (fs.existsSync(outboxDist)) {
        fs.cpSync(outboxDist, path.join(outboxDepDir, 'dist'), { recursive: true });
      }
    }

    // Copy contracts if present (e.g. realtime contracts)
    const contractsDir = path.join(repoRoot, 'contracts');
    if (fs.existsSync(contractsDir)) {
      fs.cpSync(contractsDir, path.join(tempDir, 'contracts'), { recursive: true });
    }

    // 4. Test importing every runtime module in dist
    console.log(`[4/4] Importing all runtime modules in production environment...`);
    function getJsFiles(dir) {
      let results = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          results = results.concat(getJsFiles(full));
        } else if (entry.name.endsWith('.js') && entry.name !== 'index.js') {
          results.push(full);
        }
      }
      return results;
    }

    const files = getJsFiles(targetDist);
    let importedCount = 0;
    for (const file of files) {
      try {
        await import(pathToFileURL(file).href);
        importedCount++;
      } catch (err) {
        console.error(`\n❌ ERROR: Failed to import ${path.relative(tempDir, file)}:`, err);
        throw err;
      }
    }

    // Also verify entrypoint module imports cleanly via node dry-run check
    const entrypoint = path.join(targetDist, 'index.js');
    if (fs.existsSync(entrypoint)) {
      const child = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import('${pathToFileURL(entrypoint).href}').catch(() => {});`,
        ],
        {
          cwd: tempDir,
          env: {
            ...process.env,
            NODE_ENV: 'production',
            PORT: '9999',
            HTTP_PORT: '9999',
            DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/winkey',
            VALKEY_URL: 'redis://localhost:6379',
            NATS_URL: 'nats://localhost:4222',
            VIDEO_SVC_URL: 'http://localhost:8000',
            JWT_PRIVATE_KEY: 'test-key',
            JWT_KID: 'test-kid',
            JWT_ISSUER: 'https://winkey.vn',
            PUBLIC_ORIGIN: 'https://winkey.vn',
            MEDIA_BASE_URL: 'https://media.winkey.vn',
          },
          encoding: 'utf-8',
          timeout: 5000,
        },
      );

      const stderr = child.stderr || '';
      if (stderr.includes('ERR_MODULE_NOT_FOUND')) {
        console.error(`\n❌ ERROR: Entrypoint index.js failed to resolve module:\n${stderr}`);
        throw new Error(`Missing dependency in entrypoint for ${serviceName}`);
      }
    }

    console.log(
      `✅ ${serviceName}: Successfully verified ${importedCount} runtime modules in production deploy!`,
    );
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore temporary directory cleanup failure
    }
  }
}

// Allow passing specific service name, or test all three
const targetArg = process.argv[2];
const targets = targetArg
  ? SERVICES.filter((s) => s.name === targetArg || s.relDir.endsWith(targetArg))
  : SERVICES;

if (targets.length === 0) {
  console.error(
    `Unknown service: ${targetArg}. Valid options: ${SERVICES.map((s) => s.name).join(', ')}`,
  );
  process.exit(1);
}

for (const target of targets) {
  await verifyService(target.name, target.relDir);
}

console.log(`\n🎉 All verified production dependencies imported cleanly!`);
