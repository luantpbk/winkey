/* global fetch, console, process, setTimeout */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const RESET_SCRIPT = path.resolve(SCRIPT_DIR, '..', 'reset-ratelimits.sh');

let regCounter = 0;

function resetRateLimits() {
  if (fs.existsSync(RESET_SCRIPT)) {
    try {
      execSync(`"${RESET_SCRIPT}"`, { stdio: 'pipe' });
    } catch (err) {
      console.warn(`[seed] reset-ratelimits.sh warning: ${err.message}`);
    }
  }
}

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://127.0.0.1:8080';
const SEED_NUM = parseInt(process.env.SEED || '42', 10);
const RUN_DIR = path.resolve(process.env.RUN_DIR || path.join(process.cwd(), 'systest/.run'));
const KEYS_DIR = path.join(RUN_DIR, 'keys');
const MANIFEST_PATH = path.join(RUN_DIR, 'seed-manifest.json');

// Read or generate invite code
function getInviteCode() {
  if (process.env.INVITE_CODE) return process.env.INVITE_CODE;
  const invitePath = path.join(KEYS_DIR, 'invite_code.txt');
  if (fs.existsSync(invitePath)) {
    return fs.readFileSync(invitePath, 'utf8').trim();
  }
  return 'sim-invite-2026-auth-ok';
}

const INVITE_CODE = getInviteCode();
const PASSWORD = 'Password123!';

// Simple deterministic PRNG
function createPrng(seed) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return function () {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}
const _rng = createPrng(SEED_NUM);

async function request(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* ignore */
  }
  return { status: res.status, ok: res.ok, headers: res.headers, text, json };
}

// Register or login user
async function ensureUser(handle, email, displayName, inviteCode = INVITE_CODE) {
  // Rate limit avoidance: auth-svc allows 5 registrations/hour per IP
  regCounter++;
  if (regCounter % 4 === 1) {
    resetRateLimits();
  }

  // 1. Try register
  let regRes = await request(`${GATEWAY_URL}/v1/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      handle,
      email,
      display_name: displayName,
      password: PASSWORD,
      invite_code: inviteCode,
    }),
  });

  if (regRes.status === 429) {
    console.warn(
      `[seed] Registration rate-limited (429) for ${handle}, resetting rate limits and retrying...`,
    );
    resetRateLimits();
    regRes = await request(`${GATEWAY_URL}/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        handle,
        email,
        display_name: displayName,
        password: PASSWORD,
        invite_code: inviteCode,
      }),
    });
  }

  if (regRes.status === 201 && regRes.json?.access_token) {
    return { token: regRes.json.access_token, user: regRes.json.user };
  }

  // 2. If 409 conflict, login
  const loginRes = await request(`${GATEWAY_URL}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      password: PASSWORD,
    }),
  });

  if (loginRes.ok && loginRes.json?.access_token) {
    return { token: loginRes.json.access_token, user: loginRes.json.user };
  }

  throw new Error(
    `Failed to ensure user ${handle}: reg=${regRes.status} (${regRes.text}), login=${loginRes.status} (${loginRes.text})`,
  );
}

// Generate base 16:9 and 9:16 clips with ffmpeg
function generateBaseClips() {
  fs.mkdirSync(RUN_DIR, { recursive: true });
  const clip16x9 = path.join(RUN_DIR, 'seed_clip_16x9.mp4');
  const clip9x16 = path.join(RUN_DIR, 'seed_clip_9x16.mp4');

  if (!fs.existsSync(clip16x9)) {
    console.log('[seed] Generating 16:9 test clip via FFmpeg...');
    execSync(
      `ffmpeg -y -f lavfi -i testsrc2=duration=6:size=1280x720:rate=24 -f lavfi -i sine=frequency=1000:duration=6 -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac -b:a 64k "${clip16x9}" 2>/dev/null`,
    );
  }

  if (!fs.existsSync(clip9x16)) {
    console.log('[seed] Generating 9:16 test clip via FFmpeg...');
    execSync(
      `ffmpeg -y -f lavfi -i testsrc2=duration=6:size=720x1280:rate=24 -f lavfi -i sine=frequency=1000:duration=6 -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac -b:a 64k "${clip9x16}" 2>/dev/null`,
    );
  }

  return {
    buf16x9: fs.readFileSync(clip16x9),
    buf9x16: fs.readFileSync(clip9x16),
  };
}

// Upload a single clip
async function uploadClip(creatorToken, clipBuf, title, description, visibility, tags) {
  // 1. Create upload
  const createRes = await request(`${GATEWAY_URL}/v1/uploads`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${creatorToken}`,
    },
    body: JSON.stringify({
      title,
      description,
      filename: 'clip.mp4',
      content_type: 'video/mp4',
      size_bytes: clipBuf.length,
    }),
  });

  if (!createRes.ok || !createRes.json?.video_id) {
    throw new Error(
      `Failed to create upload for "${title}": ${createRes.status} ${createRes.text}`,
    );
  }
  const videoId = createRes.json.video_id;

  // 2. Presign parts
  const presignRes = await request(`${GATEWAY_URL}/v1/uploads/${videoId}/parts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${creatorToken}`,
    },
    body: JSON.stringify({ part_numbers: [1] }),
  });

  if (!presignRes.ok || !presignRes.json?.urls?.[0]?.url) {
    throw new Error(`Failed to presign parts for ${videoId}: ${presignRes.status}`);
  }
  const partUrl = presignRes.json.urls[0].url;

  // 3. PUT part directly to S3
  const putRes = await fetch(partUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'video/mp4' },
    body: clipBuf,
  });
  if (!putRes.ok) {
    throw new Error(`PUT part failed for ${videoId}: HTTP ${putRes.status}`);
  }
  const etag = (putRes.headers.get('etag') || '"dummy"').replace(/"/g, '');

  // 4. Complete upload
  const compRes = await request(`${GATEWAY_URL}/v1/uploads/${videoId}/complete`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${creatorToken}`,
    },
    body: JSON.stringify({
      parts: [{ part_number: 1, etag }],
    }),
  });

  if (compRes.status !== 202) {
    throw new Error(`Complete upload failed for ${videoId}: HTTP ${compRes.status}`);
  }

  return { videoId, title, description, visibility, tags };
}

// Wait for video transcode to reach READY
async function waitForReady(videoId, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await request(`${GATEWAY_URL}/v1/videos/${videoId}`);
    if (res.ok && res.json?.status === 'READY') {
      return res.json;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Video ${videoId} did not become READY in ${timeoutMs / 1000}s`);
}

// 40 Video definitions with Vietnamese titles & diacritics
const VIDEO_DEFINITIONS = [
  // Shared tag: du-lich (10 videos)
  {
    title: 'Hà Nội Mùa Thu Tuyệt Đẹp',
    desc: 'Dạo quanh Hồ Gươm và phố cổ Hà Nội mùa lá rụng.',
    tags: ['du-lich', 'kham-pha'],
    is16x9: true,
    vis: 'PUBLIC',
  },
  {
    title: 'Khám Phá Sài Gòn Đêm Rực Rỡ',
    desc: 'Trải nghiệm nhịp sống sôi động của TP. Hồ Chí Minh.',
    tags: ['du-lich', 'giai-tri'],
    is16x9: false,
    vis: 'PUBLIC',
  },
  {
    title: 'Vlog Du Lịch Đà Nẵng – Hội An',
    desc: 'Bà Nà Hills và phố cổ Hội An lung linh đèn lồng.',
    tags: ['du-lich'],
    is16x9: true,
    vis: 'PUBLIC',
  },
  {
    title: 'Chinh Phục Đỉnh Fansipan Sapa',
    desc: 'Nóc nhà Đông Dương hùng vĩ trong biển mây.',
    tags: ['du-lich', 'kham-pha'],
    is16x9: true,
    vis: 'PUBLIC',
  },
  {
    title: 'Hành Trình Phượt Tây Bắc Mùa Lúa Chín',
    desc: 'Mù Cang Chải rực vàng mùa thu hoạch.',
    tags: ['du-lich'],
    is16x9: true,
    vis: 'PUBLIC',
  },
  {
    title: 'Vịnh Hạ Long – Kỳ Quan Thiên Nhiên',
    desc: 'Du thuyền ngắm hoàng hôn trên vịnh biển tuyệt mỹ.',
    tags: ['du-lich', 'kham-pha'],
    is16x9: true,
    vis: 'PUBLIC',
  },
  {
    title: 'Khám Phá Hang Sơn Đoòng Quảng Bình',
    desc: 'Kỳ quan hang động lớn nhất thế giới.',
    tags: ['du-lich', 'kham-pha'],
    is16x9: true,
    vis: 'PUBLIC',
  },
  {
    title: 'Nắng Ấm Miền Tây Sông Nước',
    desc: 'Chợ nổi Cái Răng và vườn trái cây trĩu quả Cần Thơ.',
    tags: ['du-lich', 'am-thuc'],
    is16x9: false,
    vis: 'PUBLIC',
  },
  {
    title: 'Biển Xanh Phú Quốc Mùa Hè',
    desc: 'Bãi Sao và hoàng hôn lãng mạn tại đảo ngọc.',
    tags: ['du-lich'],
    is16x9: true,
    vis: 'PUBLIC',
  },
  {
    title: 'Phố Cổ Huế Trầm Mặc Cổ Kính',
    desc: 'Đại nội Huế và sông Hương thơ mộng.',
    tags: ['du-lich'],
    is16x9: true,
    vis: 'PUBLIC',
  },

  // Shared tag: am-thuc (8 videos)
  {
    title: 'Học Nấu Phở Bò Gia Truyền Chuẩn Vị',
    desc: 'Bí quyết nước dùng thanh ngọt thơm nức mũi.',
    tags: ['am-thuc'],
    is16x9: true,
    vis: 'PUBLIC',
  },
  {
    title: 'Bánh Mì Sài Gòn Giòn Rụm Thơm Ngon',
    desc: 'Món ăn đường phố được vinh danh khắp thế giới.',
    tags: ['am-thuc'],
    is16x9: false,
    vis: 'PUBLIC',
  },
  {
    title: 'Bún Chả Hà Nội Đậm Đà Hương Vị',
    desc: 'Thịt nướng than hoa thơm lừng cùng nước mắm chua ngọt.',
    tags: ['am-thuc'],
    is16x9: true,
    vis: 'PUBLIC',
  },
  {
    title: 'Cơm Tấm Sườn Bì Chả Đặc Sản Phương Nam',
    desc: 'Đĩa cơm tấm chuẩn vị người Sài Gòn.',
    tags: ['am-thuc'],
    is16x9: false,
    vis: 'PUBLIC',
  },
  {
    title: 'Bánh Xèo Miền Tây Giòn Tan Đầy Đặn',
    desc: 'Đổ bánh xèo nghệ thơm phức cùng tôm thịt tươi.',
    tags: ['am-thuc'],
    is16x9: true,
    vis: 'PUBLIC',
  },
  {
    title: 'Mì Quảng Đậm Đà Đất Quảng Nam',
    desc: 'Sợi mì vàng óng kết hợp tôm thịt trứng cút.',
    tags: ['am-thuc'],
    is16x9: true,
    vis: 'PUBLIC',
  },
  {
    title: 'Cà Phê Trứng Hà Nội Béo Ngậy Độc Đáo',
    desc: 'Thức uống sáng tạo quyến rũ thực khách quốc tế.',
    tags: ['am-thuc'],
    is16x9: false,
    vis: 'PUBLIC',
  },
  {
    title: 'Chè Bưởi An Giang Giòn Sần Sật',
    desc: 'Món tráng miệng thanh mát ngọt dịu ngày hè.',
    tags: ['am-thuc'],
    is16x9: true,
    vis: 'PUBLIC',
  },

  // Shared tag: am-nhac (6 videos)
  {
    title: 'Giai Điệu Acoustic Nhẹ Nhàng Thư Giãn',
    desc: 'Bản tình ca guitar mộc mạc cho buổi chiều bình yên.',
    tags: ['am-nhac', 'giai-tri'],
    is16x9: true,
    vis: 'PUBLIC',
  },
  {
    title: 'Hòa Tấu Đàn Tranh Dân Tộc Việt Nam',
    desc: 'Âm sắc truyền thống sâu lắng mang hồn dân tộc.',
    tags: ['am-nhac'],
    is16x9: true,
    vis: 'PUBLIC',
  },
  {
    title: 'Nhạc Lofi Chill Cho Ngày Mưa',
    desc: 'Âm hưởng lofi ấm áp giúp bạn tập trung học tập.',
    tags: ['am-nhac'],
    is16x9: true,
    vis: 'PUBLIC',
  },
  {
    title: 'Piano Bản Tình Ca Mùa Đông',
    desc: 'Những phím đàn piano du dương đầy cảm xúc.',
    tags: ['am-nhac'],
    is16x9: true,
    vis: 'PUBLIC',
  },
  {
    title: 'Beat Nhạc Trẻ Sôi Động Bắt Tai',
    desc: 'Âm nhạc hiện đại tràn đầy năng lượng tích cực.',
    tags: ['am-nhac', 'giai-tri'],
    is16x9: false,
    vis: 'PUBLIC',
  },
  {
    title: 'Khúc Hát Đồng Quê Thanh Bình',
    desc: 'Lời ca mộc mạc gợi nhớ kỷ niệm tuổi thơ bên dòng sông.',
    tags: ['am-nhac'],
    is16x9: true,
    vis: 'PUBLIC',
  },

  // Shared tag: cong-nghe (5 videos)
  {
    title: 'Hướng Dẫn Chụp Ảnh Bằng Điện Thoại',
    desc: 'Bí quyết căn góc và lấy sáng chuyên nghiệp đơn giản.',
    tags: ['cong-nghe'],
    is16x9: false,
    vis: 'PUBLIC',
  },
  {
    title: 'Đánh Giá Laptop Lập Trình 2026',
    desc: 'Cấu hình mạnh mẽ tối ưu cho developer hiện đại.',
    tags: ['cong-nghe'],
    is16x9: true,
    vis: 'PUBLIC',
  },
  {
    title: 'Mẹo Tối Ưu Hiệu Năng Máy Tính',
    desc: 'Dọn dẹp hệ thống giúp máy chạy mượt mà như mới.',
    tags: ['cong-nghe'],
    is16x9: true,
    vis: 'PUBLIC',
  },
  {
    title: 'Trí Tuệ Nhân Tạo Trong Đời Sống Hàng Ngày',
    desc: 'AI đang thay đổi cách chúng ta làm việc ra sao.',
    tags: ['cong-nghe'],
    is16x9: true,
    vis: 'PUBLIC',
  },
  {
    title: 'Setup Bàn Làm Việc Công Nghệ Minimalist',
    desc: 'Không gian làm việc gọn gàng tăng 200% hiệu suất.',
    tags: ['cong-nghe'],
    is16x9: true,
    vis: 'PUBLIC',
  },

  // Shared tag: giai-tri (3 videos)
  {
    title: 'Review Phim Chiếu Rạp Mới Nhất',
    desc: 'Phân tích cốt truyện và diễn xuất chân thực nhất.',
    tags: ['giai-tri'],
    is16x9: true,
    vis: 'PUBLIC',
  },
  {
    title: 'Những Khoảnh Khắc Hài Hước Khó Đỡ',
    desc: 'Tổng hợp tình huống cười ra nước mắt thư giãn cuối tuần.',
    tags: ['giai-tri'],
    is16x9: false,
    vis: 'PUBLIC',
  },
  {
    title: 'Thử Thách 24 Giờ Sinh Tồn Trong Rừng',
    desc: 'Trải nghiệm kỹ năng sinh tồn thiên nhiên hoang dã.',
    tags: ['giai-tri'],
    is16x9: true,
    vis: 'PUBLIC',
  },

  // Exact 1-video tag: doc-la-viet-nam (1 video)
  {
    title: 'Chuyện Lạ Bến Tre – Cây Dừa Đột Biến',
    desc: 'Hiện tượng thiên nhiên độc nhất vô nhị chỉ có tại Bến Tre.',
    tags: ['doc-la-viet-nam'],
    is16x9: true,
    vis: 'PUBLIC',
  },

  // Punctuation-only tag: !!! (1 video)
  {
    title: 'Clip Bất Ngờ Khiến Bạn Giật Mình',
    desc: 'Khoảnh khắc không thể tin nổi diễn ra trong chớp mắt.',
    tags: ['!!!'],
    is16x9: false,
    vis: 'PUBLIC',
  },

  // UNLISTED videos (3 videos)
  {
    title: 'Bản Nháp Phỏng Vấn Hậu Trường (Chưa Công Khai)',
    desc: 'Nội dung chuẩn bị cho số phát sóng tuần tới.',
    tags: ['am-nhac'],
    is16x9: true,
    vis: 'UNLISTED',
  },
  {
    title: 'Video Hướng Dẫn Nội Bộ Nhóm Dự Án',
    desc: 'Chỉ dành cho thành viên có đường dẫn liên kết.',
    tags: ['cong-nghe'],
    is16x9: true,
    vis: 'UNLISTED',
  },
  {
    title: 'Hậu Trường Buổi Quay MV Ca Nhạc',
    desc: 'Những cảnh quay hỏng hài hước chưa từng công bố.',
    tags: ['giai-tri'],
    is16x9: false,
    vis: 'UNLISTED',
  },

  // PRIVATE videos (3 videos)
  {
    title: 'Tập Kín: Bí Mật Hậu Cung Không Thể Tiết Lộ',
    desc: 'Tập phim độc quyền dành riêng cho tác giả lưu trữ.',
    tags: ['giai-tri'],
    is16x9: true,
    vis: 'PRIVATE',
  },
  {
    title: 'Nhật Ký Cá Nhân Lưu Trữ Riêng Tư',
    desc: 'Video cá nhân không chia sẻ ra ngoài.',
    tags: ['kham-pha'],
    is16x9: true,
    vis: 'PRIVATE',
  },
  {
    title: 'Kế Hoạch Dự Án Mới Quý 4',
    desc: 'Dữ liệu tuyệt mật của đội ngũ sáng tạo nội dung.',
    tags: ['cong-nghe'],
    is16x9: true,
    vis: 'PRIVATE',
  },
];

async function main() {
  console.log(`[seed] Starting deterministic seed against ${GATEWAY_URL} (SEED=${SEED_NUM})...`);
  const { buf16x9, buf9x16 } = generateBaseClips();

  // 1. Ensure 20 regular users (sim_u01..sim_u20)
  console.log('[seed] Registering 20 simulated users...');
  const users = [];
  for (let i = 1; i <= 20; i++) {
    const pad = String(i).padStart(2, '0');
    const handle = `sim_u${pad}`;
    const email = `${handle}@winkey.test`;
    const displayName = `Người Dùng ${pad}`;
    const u = await ensureUser(handle, email, displayName);
    users.push({ handle, email, displayName, id: u.user.id, token: u.token });
  }

  // 2. Ensure Creators (sim_curator, sim_creator2, sim_creator3)
  // Quota is 20 uploads/24h per account. We split 40 clips across 3 creators so all have < 20.
  console.log('[seed] Registering creators (sim_curator, sim_creator2, sim_creator3)...');
  const curator = await ensureUser(
    'sim_curator',
    'sim_curator@winkey.test',
    'Winkey Cinema Curator',
  );
  curator.handle = 'sim_curator';

  const creator2 = await ensureUser('sim_creator2', 'sim_creator2@winkey.test', 'Winkey Creator 2');
  creator2.handle = 'sim_creator2';

  const creator3 = await ensureUser('sim_creator3', 'sim_creator3@winkey.test', 'Winkey Creator 3');
  creator3.handle = 'sim_creator3';

  // 3. Ensure Moderator (sim_mod) & elevate role
  console.log('[seed] Registering moderator (sim_mod)...');
  const moderator = await ensureUser('sim_mod', 'sim_mod@winkey.test', 'Kiểm Duyệt Viên Winkey');
  moderator.handle = 'sim_mod';

  try {
    console.log('[seed] Elevating moderator roles in DB via psql...');
    execSync(
      `docker exec winkey-postgres psql -U winkey_migrator -d winkey -c "UPDATE auth.users SET roles = '{viewer,creator,moderator,admin}' WHERE id = '${moderator.user.id}';"`,
    );
    // Re-login moderator to receive token with elevated roles
    const relogin = await request(`${GATEWAY_URL}/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'sim_mod@winkey.test', password: PASSWORD }),
    });
    if (relogin.ok && relogin.json?.access_token) {
      moderator.token = relogin.json.access_token;
    }
  } catch (err) {
    console.warn(
      '[seed] Warning: Moderator DB elevation failed (may already be elevated):',
      err.message,
    );
  }

  // 4. Upload 40 short clips concurrently (concurrency 4)
  // sim_curator retains all videos used for series and playlists (15 videos, < 20).
  // Remaining 25 videos are split between sim_creator2 (13 videos, < 20) and sim_creator3 (12 videos, < 20).
  const CURATOR_INDICES = new Set([0, 1, 2, 3, 4, 10, 11, 12, 13, 14, 15, 18, 19, 20, 37]);
  const otherIndices = [];
  for (let i = 0; i < VIDEO_DEFINITIONS.length; i++) {
    if (!CURATOR_INDICES.has(i)) {
      otherIndices.push(i);
    }
  }
  const CREATOR2_INDICES = new Set(otherIndices.slice(0, 13));
  const CREATOR3_INDICES = new Set(otherIndices.slice(13));

  function getOwner(idx) {
    if (CURATOR_INDICES.has(idx)) return curator;
    if (CREATOR2_INDICES.has(idx)) return creator2;
    return creator3;
  }

  console.log(
    `[seed] Uploading and transcoding ${VIDEO_DEFINITIONS.length} videos concurrently (concurrency: 4)...`,
  );
  const uploadedVideos = new Array(VIDEO_DEFINITIONS.length);

  async function processVideo(i) {
    const def = VIDEO_DEFINITIONS[i];
    const owner = getOwner(i);
    const clipBuf = def.is16x9 ? buf16x9 : buf9x16;

    console.log(
      `[seed] [${i + 1}/${VIDEO_DEFINITIONS.length}] (${owner.handle}) Uploading "${def.title}"...`,
    );

    const up = await uploadClip(owner.token, clipBuf, def.title, def.desc, def.vis, def.tags);

    // Poll until READY
    const readyVideo = await waitForReady(up.videoId);

    // Apply tags & visibility via PATCH using the video owner's token
    await request(`${GATEWAY_URL}/v1/videos/${up.videoId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${owner.token}`,
      },
      body: JSON.stringify({
        title: def.title,
        description: def.desc,
        visibility: def.vis,
        tags: def.tags,
      }),
    });

    console.log(
      `[seed] [${i + 1}/${VIDEO_DEFINITIONS.length}] (${owner.handle}) READY (${readyVideo.slug || up.videoId})`,
    );

    uploadedVideos[i] = {
      id: up.videoId,
      title: def.title,
      description: def.desc,
      visibility: def.vis,
      tags: def.tags,
      slug: readyVideo.slug || up.videoId,
      duration_sec: 6,
      aspect_ratio: def.is16x9 ? '16:9' : '9:16',
      owner_handle: owner.handle,
    };
  }

  const CONCURRENCY = 4;
  let nextIdx = 0;

  async function worker() {
    while (nextIdx < VIDEO_DEFINITIONS.length) {
      const idx = nextIdx++;
      await processVideo(idx);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  // 5. Create 4 Playlists
  console.log('[seed] Creating 4 playlists...');
  const playlists = [];
  const playlistDefs = [
    { title: 'Danh sách phát yêu thích', vis: 'PUBLIC', videoIdxs: [0, 1, 2, 3] },
    { title: 'Nhạc chill cuối tuần', vis: 'PUBLIC', videoIdxs: [18, 19, 20] },
    { title: 'Khám phá văn hóa ẩm thực', vis: 'PUBLIC', videoIdxs: [10, 11, 12, 13] },
    { title: 'Kỷ niệm cá nhân', vis: 'PRIVATE', videoIdxs: [0, 4] },
  ];

  for (const pDef of playlistDefs) {
    const pRes = await request(`${GATEWAY_URL}/v1/playlists`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${curator.token}`,
      },
      body: JSON.stringify({
        title: pDef.title,
        visibility: pDef.vis,
        is_series: false,
      }),
    });

    if (pRes.ok && pRes.json?.id) {
      const pid = pRes.json.id;
      for (const idx of pDef.videoIdxs) {
        if (uploadedVideos[idx]) {
          await request(`${GATEWAY_URL}/v1/playlists/${pid}/items`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${curator.token}`,
            },
            body: JSON.stringify({ video_id: uploadedVideos[idx].id }),
          });
        }
      }
      playlists.push({ id: pid, title: pDef.title, visibility: pDef.vis });
    }
  }

  // 6. Create 2 Series ("Bộ phim")
  console.log('[seed] Creating 2 series ("Bộ phim")...');
  const series = [];

  // Series 1: 4 episodes (ep 1, ep 2 PUBLIC; ep 3 PRIVATE; ep 4 PUBLIC)
  // Let's use video index 0, 1, 37 (which is PRIVATE), and 2
  const s1Res = await request(`${GATEWAY_URL}/v1/playlists`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${curator.token}`,
    },
    body: JSON.stringify({
      title: 'Hành Trình Xuyên Việt',
      description: 'Khám phá vẻ đẹp dọc miền đất nước qua từng tập phim đặc sắc.',
      visibility: 'PUBLIC',
      is_series: true,
    }),
  });

  if (s1Res.ok && s1Res.json?.id) {
    const s1Id = s1Res.json.id;
    // Add 4 episodes in order: video 0, video 1, video 37 (PRIVATE), video 2
    const epIdxs = [0, 1, 37, 2];
    for (const idx of epIdxs) {
      if (uploadedVideos[idx]) {
        await request(`${GATEWAY_URL}/v1/playlists/${s1Id}/items`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${curator.token}`,
          },
          body: JSON.stringify({ video_id: uploadedVideos[idx].id }),
        });
      }
    }
    series.push({
      id: s1Id,
      title: 'Hành Trình Xuyên Việt',
      episodes_count: 4,
      episode_ids: epIdxs.map((i) => uploadedVideos[i]?.id),
    });
  }

  // Series 2: 6 episodes (all PUBLIC: videos 10, 11, 12, 13, 14, 15)
  const s2Res = await request(`${GATEWAY_URL}/v1/playlists`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${curator.token}`,
    },
    body: JSON.stringify({
      title: 'Ẩm Thực Ba Miền Bắc Trung Nam',
      description: 'Hành trình nếm trải tinh hoa ẩm thực khắp mọi nẻo đường quê hương.',
      visibility: 'PUBLIC',
      is_series: true,
    }),
  });

  if (s2Res.ok && s2Res.json?.id) {
    const s2Id = s2Res.json.id;
    const epIdxs = [10, 11, 12, 13, 14, 15];
    for (const idx of epIdxs) {
      if (uploadedVideos[idx]) {
        await request(`${GATEWAY_URL}/v1/playlists/${s2Id}/items`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${curator.token}`,
          },
          body: JSON.stringify({ video_id: uploadedVideos[idx].id }),
        });
      }
    }
    series.push({
      id: s2Id,
      title: 'Ẩm Thực Ba Miền Bắc Trung Nam',
      episodes_count: 6,
      episode_ids: epIdxs.map((i) => uploadedVideos[i]?.id),
    });
  }

  // 7. Social interactions: comments & likes spread across videos
  console.log('[seed] Spreading comments and likes across videos...');
  const sampleComments = [
    'Video quá tuyệt vời! Hình ảnh sắc nét và âm thanh chân thực.',
    'Góc quay đẹp mắt, xem mà nhớ quê hương da diết.',
    'Cảm ơn kênh đã chia sẻ nội dung ý nghĩa và bổ ích như thế này.',
    'Chất lượng 10/10, mong chờ tập tiếp theo của tác giả!',
    'Món này nhìn hấp dẫn quá, cuối tuần phải thử làm ngay mới được.',
  ];

  for (let i = 0; i < 20; i++) {
    const user = users[i % users.length];
    const targetVideo = uploadedVideos[i % uploadedVideos.length];
    if (targetVideo && targetVideo.visibility === 'PUBLIC') {
      // Post comment
      await request(`${GATEWAY_URL}/v1/videos/${targetVideo.id}/comments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${user.token}`,
        },
        body: JSON.stringify({ content: sampleComments[i % sampleComments.length] }),
      });

      // Like video
      await request(`${GATEWAY_URL}/v1/videos/${targetVideo.id}/like`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${user.token}`,
        },
      });
    }
  }

  // 8. Build & write manifest
  const manifest = {
    version: '1.0',
    generated_at: new Date().toISOString(),
    seed: SEED_NUM,
    invite_code: INVITE_CODE,
    users: users.map((u) => ({
      id: u.id,
      handle: u.handle,
      email: u.email,
      displayName: u.displayName,
    })),
    curator: { id: curator.user.id, handle: 'sim_curator', email: 'sim_curator@winkey.test' },
    creator2: { id: creator2.user.id, handle: 'sim_creator2', email: 'sim_creator2@winkey.test' },
    creator3: { id: creator3.user.id, handle: 'sim_creator3', email: 'sim_creator3@winkey.test' },
    moderator: { id: moderator.user.id, handle: 'sim_mod', email: 'sim_mod@winkey.test' },
    videos: uploadedVideos,
    playlists,
    series,
  };

  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  console.log(`[seed] SUCCESS! Manifest written to ${MANIFEST_PATH}`);
  console.log(
    `[seed] Total: 20 users, 1 curator, 1 moderator, ${uploadedVideos.length} videos, ${playlists.length} playlists, ${series.length} series.`,
  );
}

main().catch((err) => {
  console.error('[seed] ERROR:', err);
  process.exit(1);
});
