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
const SEED_CHAT_JSON_PATH = path.resolve(__dirname, 'seed-chat.json');

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
  console.log('[loadtest:seed-chat] Starting bulk seed for SOC-3a E2EE Chat Load Testing...');
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

  // 2. Execute SQL bulk insert directly in winkey-postgres
  console.log('[loadtest:seed-chat] Seeding 200 users, devices, OTKs, and groups in PostgreSQL...');

  const sqlScript = `
BEGIN;

-- 1. Create 200 users in auth.users
INSERT INTO auth.users (
    id, handle, email, password_hash, display_name, status, roles, is_private, created_at, updated_at
)
SELECT
    gen_random_uuid(),
    'chat_u_' || lpad(i::text, 4, '0'),
    'chat_u_' || lpad(i::text, 4, '0') || '@winkey.test',
    '$argon2id$v=19$m=65536,t=3,p=4$dummyhashforloadtestusers1234567890abcdef',
    'Chat User ' || i,
    'ACTIVE',
    '{viewer}',
    false,
    now() - (random() * interval '7 days'),
    now()
FROM generate_series(1, 200) AS i
ON CONFLICT (email) DO NOTHING;

-- 2. Create 1 E2EE device per user in chat.devices
WITH user_list AS (
    SELECT id, row_number() OVER (ORDER BY id) as rn
    FROM auth.users
    WHERE handle LIKE 'chat_u_%'
)
INSERT INTO chat.devices (
    id, user_id, display_name, curve25519_key, ed25519_key, signature,
    fallback_key_id, fallback_key, fallback_signature, created_at, last_seen_at
)
SELECT
    gen_random_uuid(),
    u.id,
    'Chrome on LoadTest Edge ' || u.rn,
    rpad('c25519_load_' || lpad(u.rn::text, 6, '0') || '_', 43, 'A'),
    rpad('ed25519_load_' || lpad(u.rn::text, 6, '0') || '_', 43, 'B'),
    rpad('sig_device_load_' || lpad(u.rn::text, 6, '0') || '_', 86, 'C'),
    'fb_key_' || u.rn,
    rpad('fb_c25519_' || lpad(u.rn::text, 6, '0') || '_', 43, 'D'),
    rpad('fb_sig_' || lpad(u.rn::text, 6, '0') || '_', 86, 'E'),
    now() - interval '1 day',
    now()
FROM user_list u
ON CONFLICT DO NOTHING;

-- 3. Create 10 one-time keys per device in chat.one_time_keys
INSERT INTO chat.one_time_keys (device_id, key_id, public_key, signature, created_at)
SELECT
    d.id,
    'otk_' || k,
    rpad('otk_key_' || k || '_dev_' || substr(d.id::text, 1, 8), 43, 'X'),
    rpad('otk_sig_' || k || '_dev_' || substr(d.id::text, 1, 8), 86, 'Y'),
    now()
FROM chat.devices d
JOIN auth.users u ON d.user_id = u.id AND u.handle LIKE 'chat_u_%'
CROSS JOIN generate_series(1, 10) AS k
ON CONFLICT DO NOTHING;

-- 4. Create 10 Group Conversations (10 to 50 members each)
-- Group sizes: [15, 25, 40, 50, 30, 20, 45, 10, 35, 50]
WITH user_numbered AS (
    SELECT id, row_number() OVER (ORDER BY id) as rn
    FROM auth.users
    WHERE handle LIKE 'chat_u_%'
),
group_defs (gid, title, target_size) AS (
    VALUES
        (1, 'Nhóm Tải Trọng Alpha (15)', 15),
        (2, 'Nhóm Tải Trọng Beta (25)', 25),
        (3, 'Nhóm Tải Trọng Gamma (40)', 40),
        (4, 'Nhóm Tải Trọng Delta (50 max)', 50),
        (5, 'Nhóm Tải Trọng Epsilon (30)', 30),
        (6, 'Nhóm Tải Trọng Zeta (20)', 20),
        (7, 'Nhóm Tải Trọng Eta (45)', 45),
        (8, 'Nhóm Tải Trọng Theta (10 min)', 10),
        (9, 'Nhóm Tải Trọng Iota (35)', 35),
        (10, 'Nhóm Tải Trọng Kappa (50 max)', 50)
),
inserted_convs AS (
    INSERT INTO chat.conversations (id, kind, title, created_by, last_seq, created_at)
    SELECT
        gen_random_uuid(),
        'GROUP',
        gd.title,
        (SELECT id FROM user_numbered WHERE rn = gd.gid),
        0,
        now() - interval '2 days'
    FROM group_defs gd
    RETURNING id, title
)
SELECT id, title FROM inserted_convs;

COMMIT;
`;

  try {
    execSync(`docker exec -i winkey-postgres psql -U postgres -d winkey`, {
      input: sqlScript,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    console.log('[loadtest:seed-chat] SQL base insertion completed.');
  } catch (err) {
    console.error('[loadtest:seed-chat] SQL insertion error:', err?.message || err);
    throw err;
  }

  // 3. Assign members to each group in chat.members
  const assignMembersSql = `
DO $$
DECLARE
    v_conv RECORD;
    v_users uuid[];
    v_target_size int;
    v_idx int := 1;
    v_sizes int[] := ARRAY[15, 25, 40, 50, 30, 20, 45, 10, 35, 50];
    u uuid;
    i int;
BEGIN
    SELECT array_agg(id ORDER BY id) INTO v_users FROM auth.users WHERE handle LIKE 'chat_u_%';

    FOR v_conv IN SELECT id, title FROM chat.conversations WHERE kind = 'GROUP' AND title LIKE 'Nhóm Tải Trọng%' ORDER BY title LOOP
        v_target_size := v_sizes[v_idx];
        v_idx := (v_idx % 10) + 1;

        FOR i IN 1..v_target_size LOOP
            u := v_users[((v_idx * 17 + i) % 200) + 1];
            INSERT INTO chat.members (conversation_id, user_id, role, state, joined_seq, last_read_seq, created_at, updated_at)
            VALUES (
                v_conv.id,
                u,
                CASE WHEN i = 1 THEN 'OWNER'::chat.member_role ELSE 'MEMBER'::chat.member_role END,
                'ACTIVE'::chat.member_state,
                1,
                0,
                now() - interval '2 days',
                now()
            )
            ON CONFLICT (conversation_id, user_id) DO UPDATE SET state = 'ACTIVE';
        END LOOP;
    END LOOP;
END
$$;
`;

  execSync(`docker exec -i winkey-postgres psql -U postgres -d winkey`, {
    input: assignMembersSql,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  console.log('[loadtest:seed-chat] Group members assigned.');

  // 4. Query seeded data to construct JSON manifest
  const usersQuery = `
    SELECT
      u.id::text AS user_id,
      u.handle,
      d.id::text AS device_id
    FROM auth.users u
    JOIN chat.devices d ON d.user_id = u.id AND d.deleted_at IS NULL
    WHERE u.handle LIKE 'chat_u_%'
    ORDER BY u.handle;
  `;

  const rawUsers = execSync(
    `docker exec -i winkey-postgres psql -U postgres -d winkey -t -A -F"," -c "${usersQuery}"`,
  )
    .toString()
    .trim()
    .split('\n')
    .filter(Boolean);

  const users = rawUsers.map((line) => {
    const [userId, handle, deviceId] = line.split(',');
    const token = createJwt(
      {
        roles: ['viewer'],
        sid: crypto.randomUUID(),
        sub: userId,
        iat: Math.floor(Date.now() / 1000) - 60,
        exp: Math.floor(Date.now() / 1000) + 86400 * 7,
        iss: 'https://winkey.vn',
        aud: 'winkey-api',
        jti: crypto.randomUUID(),
      },
      privateKeyPem,
    );
    return {
      id: userId,
      handle,
      deviceId,
      token,
    };
  });

  const groupsQuery = `
    SELECT
      c.id::text AS conv_id,
      c.title,
      array_to_string(array_agg(m.user_id::text), ',') AS member_ids
    FROM chat.conversations c
    JOIN chat.members m ON m.conversation_id = c.id AND m.state = 'ACTIVE'
    WHERE c.kind = 'GROUP' AND c.title LIKE 'Nhóm Tải Trọng%'
    GROUP BY c.id, c.title
    ORDER BY c.title;
  `;

  const rawGroups = execSync(
    `docker exec -i winkey-postgres psql -U postgres -d winkey -t -A -F"|" -c "${groupsQuery}"`,
  )
    .toString()
    .trim()
    .split('\n')
    .filter(Boolean);

  const groups = rawGroups.map((line) => {
    const [id, title, memberIdsStr] = line.split('|');
    return {
      id,
      title,
      memberUserIds: memberIdsStr.split(',').filter(Boolean),
    };
  });

  const manifestData = {
    users,
    groups,
    generatedAt: new Date().toISOString(),
  };

  fs.writeFileSync(SEED_CHAT_JSON_PATH, JSON.stringify(manifestData, null, 2), 'utf8');
  console.log(
    `[loadtest:seed-chat] Successfully seeded ${users.length} users and ${groups.length} groups in ${
      Date.now() - t0
    }ms. Manifest saved to ${SEED_CHAT_JSON_PATH}.`,
  );
}

main().catch((err) => {
  console.error('[loadtest:seed-chat] Fatal error:', err);
  process.exit(1);
});
