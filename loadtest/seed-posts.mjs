/* global console, process */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Buffer } from 'node:buffer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const KEYS_DIR = path.resolve(REPO_ROOT, 'systest/.run/keys');
const SEED_JSON_PATH = path.resolve(__dirname, 'seed-feeds.json');

function base64Url(str) {
  return Buffer.from(str)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function createJwt(payload, privateKeyPem) {
  const header = {
    alg: 'RS256',
    typ: 'JWT',
    kid: 'winkey-auth-key-1',
  };
  const encodedHeader = base64Url(JSON.stringify(header));
  const encodedPayload = base64Url(JSON.stringify(payload));
  const data = `${encodedHeader}.${encodedPayload}`;

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(data);
  const signature = signer.sign(privateKeyPem, 'base64url');

  return `${data}.${signature}`;
}

async function main() {
  console.log(
    '[loadtest:seed] Starting high-performance bulk seed for SOC-2a feed load testing...',
  );
  const t0 = Date.now();

  // 1. Ensure private key exists for signing tokens
  const privKeyPath = path.join(KEYS_DIR, 'jwt_private.pem');
  if (!fs.existsSync(privKeyPath)) {
    fs.mkdirSync(KEYS_DIR, { recursive: true });
    execSync(`openssl genrsa -out "${privKeyPath}" 2048 2>/dev/null`);
    execSync(
      `openssl rsa -in "${privKeyPath}" -pubout -out "${path.join(KEYS_DIR, 'jwt_public.pem')}" 2>/dev/null`,
    );
  }
  const privateKeyPem = fs.readFileSync(privKeyPath, 'utf8');

  // 2. Execute PostgreSQL bulk inserts directly inside winkey-postgres container
  console.log(
    '[loadtest:seed] Seeding 2,000 users, 100,000 posts, and follow graph in PostgreSQL...',
  );

  const sqlScript = `
BEGIN;

-- 1. Create 2,000 users in auth.users
INSERT INTO auth.users (
    id, handle, email, password_hash, display_name, status, roles, is_private, created_at, updated_at
)
SELECT
    gen_random_uuid(),
    'soc2_u_' || lpad(i::text, 4, '0'),
    'soc2_u_' || lpad(i::text, 4, '0') || '@winkey.test',
    '$argon2id$v=19$m=65536,t=3,p=4$dummyhashforloadtestusers1234567890abcdef',
    'Feed User ' || i,
    'ACTIVE',
    '{viewer}',
    false,
    now() - (random() * interval '30 days'),
    now()
FROM generate_series(1, 2000) AS i
ON CONFLICT (email) DO NOTHING;

-- 2. Follow graph: each user follows between 50 and 200 other users (deterministic modulo ring)
WITH user_numbered AS (
    SELECT id, (row_number() OVER (ORDER BY id))::int AS rn
    FROM auth.users
    WHERE handle LIKE 'soc2_u_%'
)
INSERT INTO social.subscriptions (subscriber_id, channel_id, created_at)
SELECT
    u.id AS subscriber_id,
    t.id AS channel_id,
    now() - (random() * interval '30 days') AS created_at
FROM user_numbered u
CROSS JOIN LATERAL (
    SELECT id
    FROM user_numbered
    WHERE rn IN (
        SELECT ((u.rn + k - 1) % 2000) + 1
        FROM generate_series(1, 50 + (abs(hashtext(u.id::text)) % 151)) AS k
    )
) t
ON CONFLICT (subscriber_id, channel_id) DO NOTHING;

-- 3. 100,000 posts over 30 days (10% with media_count = 1)
WITH user_array AS (
    SELECT array_agg(id) AS ids
    FROM auth.users
    WHERE handle LIKE 'soc2_u_%'
),
generated_posts AS (
    SELECT
        gen_random_uuid() AS p_id,
        ids[1 + (abs(hashtext(i::text)) % array_length(ids, 1))] AS a_id,
        'Bài viết số ' || i || ' về du lịch và công nghệ #HàNội #winkey' AS p_body,
        'PUBLIC'::social.post_visibility AS p_vis,
        'VISIBLE'::social.post_status AS p_stat,
        CASE WHEN (i % 10 = 0) THEN 1 ELSE 0 END AS m_count,
        now() - (random() * interval '30 days') AS c_at
    FROM user_array, generate_series(1, 100000) AS i
)
INSERT INTO social.posts (
    id, author_id, body, visibility, status, media_count, created_at, updated_at
)
SELECT p_id, a_id, p_body, p_vis, p_stat, m_count, c_at, c_at
FROM generated_posts;

-- 4. 10,000 post_media rows for the posts with media_count = 1
INSERT INTO social.post_media (
    post_id, position, image_id, image_key, thumb_key, width, height
)
SELECT
    id AS post_id,
    0 AS position,
    gen_random_uuid() AS image_id,
    'i/load/' || id || '/img.webp' AS image_key,
    'i/load/' || id || '/thumb.webp' AS thumb_key,
    1200 AS width,
    800 AS height
FROM social.posts
WHERE media_count = 1
  AND author_id IN (SELECT id FROM auth.users WHERE handle LIKE 'soc2_u_%')
ON CONFLICT (post_id, position) DO NOTHING;

-- 5. Hashtags for searching / trending
INSERT INTO social.post_hashtags (post_id, tag, created_at)
SELECT id, 'HàNội', created_at
FROM social.posts
WHERE author_id IN (SELECT id FROM auth.users WHERE handle LIKE 'soc2_u_%')
LIMIT 40000
ON CONFLICT (post_id, slug) DO NOTHING;

-- 6. Precompute explore feed scores (social.post_scores)
INSERT INTO social.post_scores (post_id, score, computed_at)
SELECT
    id,
    ((reaction_count + 2 * comment_count + 3 * reshare_count + 1)::float / power(extract(epoch from now() - created_at) / 3600 + 2, 1.5)),
    now()
FROM social.posts
WHERE status = 'VISIBLE' AND visibility = 'PUBLIC' AND created_at >= now() - interval '7 days'
ON CONFLICT (post_id) DO UPDATE SET score = EXCLUDED.score, computed_at = EXCLUDED.computed_at;

COMMIT;

ANALYZE auth.users;
ANALYZE social.subscriptions;
ANALYZE social.posts;
ANALYZE social.post_media;
ANALYZE social.post_scores;
ANALYZE social.post_hashtags;
`;

  execSync(`docker exec -i winkey-postgres psql -U winkey_migrator -d winkey`, {
    input: sqlScript,
    stdio: ['pipe', 'inherit', 'inherit'],
  });

  // 3. Export users and pre-signed tokens for k6
  console.log('[loadtest:seed] Exporting users and pre-signed JWT tokens for k6...');

  const usersJsonRaw = execSync(
    `docker exec -i winkey-postgres psql -U winkey_migrator -d winkey -t -A -c "
      SELECT json_build_object('id', id, 'handle', handle, 'email', email)
      FROM auth.users
      WHERE handle LIKE 'soc2_u_%'
      ORDER BY handle ASC
      LIMIT 100;
    "`,
  )
    .toString()
    .trim()
    .split('\n')
    .filter(Boolean);

  const users = usersJsonRaw.map((line) => {
    const u = JSON.parse(line);
    const nowSec = Math.floor(Date.now() / 1000);
    const token = createJwt(
      {
        sub: u.id,
        iss: 'https://winkey.vn',
        aud: 'winkey-api',
        roles: ['viewer'],
        sid: crypto.randomUUID(),
        jti: crypto.randomUUID(),
        iat: nowSec,
        exp: nowSec + 86400 * 7, // 7 days
      },
      privateKeyPem,
    );
    return { ...u, token };
  });

  // Export 200 random post IDs
  const postsRaw = execSync(
    `docker exec -i winkey-postgres psql -U winkey_migrator -d winkey -t -A -c "
      SELECT id FROM social.posts WHERE visibility = 'PUBLIC' AND status = 'VISIBLE' LIMIT 200;
    "`,
  )
    .toString()
    .trim()
    .split('\n')
    .filter(Boolean);

  const seedData = {
    users,
    postIds: postsRaw,
    seededAt: new Date().toISOString(),
  };

  fs.writeFileSync(SEED_JSON_PATH, JSON.stringify(seedData, null, 2), 'utf8');
  console.log(
    `[loadtest:seed] Successfully seeded 2,000 users, subscriptions, 100,000 posts in ${((Date.now() - t0) / 1000).toFixed(1)}s! Exported ${users.length} authenticated users to ${SEED_JSON_PATH}`,
  );
}

main().catch((err) => {
  console.error('[loadtest:seed] Error:', err);
  process.exit(1);
});
