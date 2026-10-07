/* global fetch, console, process */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GATEWAY_URL = process.env.GATEWAY_URL || process.env.TARGET_URL || 'http://127.0.0.1:8080';

async function main() {
  console.log(`[cleanup] Starting data cleanup for target ${GATEWAY_URL}...`);

  const seedPath = path.join(__dirname, 'seed.json');
  if (!fs.existsSync(seedPath)) {
    console.log('[cleanup] No seed.json found. Nothing to delete.');
    return;
  }

  let seedData = null;
  try {
    seedData = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  } catch (err) {
    console.error(`[cleanup] Failed to parse seed.json: ${err.message}`);
    return;
  }

  const creatorToken = seedData.creatorToken;
  const videos = seedData.videos || [];

  if (creatorToken && videos.length > 0) {
    console.log(`[cleanup] Deleting ${videos.length} seeded videos...`);
    for (const vid of videos) {
      try {
        const res = await fetch(`${GATEWAY_URL}/v1/videos/${vid.id}`, {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${creatorToken}`,
          },
        });
        if (res.status === 204 || res.status === 404) {
          console.log(`[cleanup] Video ${vid.id} deleted (status ${res.status}).`);
        } else {
          console.warn(`[cleanup] Delete video ${vid.id} returned status ${res.status}.`);
        }
      } catch (e) {
        console.warn(`[cleanup] Failed to delete video ${vid.id}: ${e.message}`);
      }
    }
  }

  // Remove local seed JSON files
  const filesToRemove = ['seed.json', 'videos.json', 'users.json'];
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
