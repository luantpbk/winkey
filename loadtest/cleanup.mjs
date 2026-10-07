/* global fetch, console, process */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GATEWAY_URL = process.env.GATEWAY_URL || process.env.TARGET_URL || 'https://winkey.vn';

async function main() {
  console.log(`[cleanup] Starting data cleanup for target ${GATEWAY_URL}...`);

  // 1. Delete seeded videos if seed.json exists (local/dev seed mode)
  const seedPath = path.join(__dirname, 'seed.json');
  if (fs.existsSync(seedPath)) {
    try {
      const seedData = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
      const creatorToken = seedData.creatorToken;
      const videos = seedData.videos || [];

      if (creatorToken && videos.length > 0) {
        console.log(`[cleanup] Deleting ${videos.length} seeded videos...`);
        for (const vid of videos) {
          try {
            const res = await fetch(`${GATEWAY_URL}/v1/videos/${vid.id}`, {
              method: 'DELETE',
              headers: { Authorization: `Bearer ${creatorToken}` },
            });
            if (res.status === 204 || res.status === 404) {
              console.log(`[cleanup] Video ${vid.id} deleted.`);
            }
          } catch (e) {
            console.warn(`[cleanup] Failed to delete video ${vid.id}: ${e.message}`);
          }
        }
      }
    } catch (err) {
      console.warn(`[cleanup] Error reading seed.json: ${err.message}`);
    }
  }

  // 2. Delete any lt2_ accounts if lt2_accounts.json exists
  const lt2AccountsPath = path.join(__dirname, 'lt2_accounts.json');
  if (fs.existsSync(lt2AccountsPath)) {
    try {
      const accounts = JSON.parse(fs.readFileSync(lt2AccountsPath, 'utf8'));
      if (Array.isArray(accounts) && accounts.length > 0) {
        console.log(`[cleanup] Calling deleteMe for ${accounts.length} lt2_ accounts...`);
        for (const acc of accounts) {
          try {
            const res = await fetch(`${GATEWAY_URL}/v1/me`, {
              method: 'DELETE',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${acc.token}`,
              },
              body: JSON.stringify({
                confirm_handle: acc.handle,
                password: acc.password,
              }),
            });
            if (res.status === 204 || res.status === 404) {
              console.log(`[cleanup] Account ${acc.handle} deleted via deleteMe.`);
            }
          } catch (e) {
            console.warn(`[cleanup] Failed to deleteMe for ${acc.handle}: ${e.message}`);
          }
        }
      }
    } catch (err) {
      console.warn(`[cleanup] Error reading lt2_accounts.json: ${err.message}`);
    }
  }

  // Remove local temporary files
  const filesToRemove = ['seed.json', 'videos.json', 'users.json', 'lt2_accounts.json'];
  for (const file of filesToRemove) {
    const fp = path.join(__dirname, file);
    if (fs.existsSync(fp)) {
      fs.unlinkSync(fp);
      console.log(`[cleanup] Removed local file ${file}`);
    }
  }

  console.log('[cleanup] Data cleanup completed successfully.');
}

main().catch((err) => {
  console.error('[cleanup] Fatal error during cleanup:', err);
  process.exit(1);
});
