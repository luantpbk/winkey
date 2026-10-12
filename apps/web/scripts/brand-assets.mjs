import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const webRoot = path.resolve(__dirname, '..');

const markSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <rect width="512" height="512" rx="112" fill="#dc2626"/>
  <polygon points="190,140 370,256 190,372" fill="#ffffff"/>
</svg>`;

const orgLogoSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <rect width="512" height="512" fill="#0f0f0f"/>
  <rect x="56" y="56" width="400" height="400" rx="88" fill="#dc2626"/>
  <polygon points="206,166 356,256 206,346" fill="#ffffff"/>
</svg>`;

const ogSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" width="1200" height="630">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#141414"/>
      <stop offset="100%" stop-color="#0a0a0a"/>
    </linearGradient>
    <radialGradient id="glow" cx="30%" cy="40%" r="50%">
      <stop offset="0%" stop-color="#dc2626" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="#dc2626" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <circle cx="360" cy="250" r="400" fill="url(#glow)"/>
  <!-- Logo Mark -->
  <rect x="120" y="160" width="120" height="120" rx="28" fill="#dc2626"/>
  <polygon points="166,192 212,220 166,248" fill="#ffffff"/>
  <!-- Wordmark -->
  <text x="264" y="246" font-family="system-ui, -apple-system, sans-serif" font-weight="900" font-size="80" fill="#ffffff" letter-spacing="-1.5">Winkey</text>
  <text x="560" y="210" font-family="system-ui, -apple-system, sans-serif" font-weight="800" font-size="30" fill="#ef4444" letter-spacing="1">VN</text>
  <!-- Tagline / Keywords -->
  <text x="120" y="370" font-family="system-ui, -apple-system, sans-serif" font-weight="700" font-size="44" fill="#f3f4f6">Xem phim, video, nhạc và game giải trí</text>
  <text x="120" y="430" font-family="system-ui, -apple-system, sans-serif" font-weight="400" font-size="26" fill="#9ca3af">Nền tảng chia sẻ và phát video trực tuyến tốc độ cao tại Việt Nam</text>
</svg>`;

function buildIco(pngBuffers) {
  const count = pngBuffers.length;
  const headerSize = 6;
  const entrySize = 16;
  let offset = headerSize + count * entrySize;

  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);

  const entries = [];
  for (const item of pngBuffers) {
    const entry = Buffer.alloc(entrySize);
    entry.writeUInt8(item.width >= 256 ? 0 : item.width, 0);
    entry.writeUInt8(item.height >= 256 ? 0 : item.height, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(item.buffer.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += item.buffer.length;
  }

  return Buffer.concat([header, ...entries, ...pngBuffers.map((p) => p.buffer)]);
}

async function generateAssets() {
  console.log('Generating brand assets...');

  // Ensure directories exist
  const appDir = path.join(webRoot, 'src/app');
  const publicDir = path.join(webRoot, 'public');
  if (!fs.existsSync(appDir)) fs.mkdirSync(appDir, { recursive: true });
  if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });

  // 1. src/app/icon.png (512x512)
  console.log('-> src/app/icon.png (512x512)');
  await sharp(Buffer.from(markSvg))
    .resize(512, 512)
    .png()
    .toFile(path.join(appDir, 'icon.png'));

  // 2. src/app/apple-icon.png (180x180)
  console.log('-> src/app/apple-icon.png (180x180)');
  await sharp(Buffer.from(markSvg))
    .resize(180, 180)
    .png()
    .toFile(path.join(appDir, 'apple-icon.png'));

  // 3. public/logo.png (512x512 square solid background for Organization.logo)
  console.log('-> public/logo.png (512x512)');
  await sharp(Buffer.from(orgLogoSvg))
    .resize(512, 512)
    .png()
    .toFile(path.join(publicDir, 'logo.png'));

  // 4. src/app/opengraph-image.png (1200x630)
  console.log('-> src/app/opengraph-image.png (1200x630)');
  await sharp(Buffer.from(ogSvg))
    .resize(1200, 630)
    .png()
    .toFile(path.join(appDir, 'opengraph-image.png'));

  // 5. src/app/favicon.ico (16, 32, 48)
  console.log('-> src/app/favicon.ico (16, 32, 48)');
  const icoSizes = [16, 32, 48];
  const pngBuffers = [];
  for (const size of icoSizes) {
    const buf = await sharp(Buffer.from(markSvg))
      .resize(size, size)
      .png()
      .toBuffer();
    pngBuffers.push({ width: size, height: size, buffer: buf });
  }
  const icoData = buildIco(pngBuffers);
  fs.writeFileSync(path.join(appDir, 'favicon.ico'), icoData);

  console.log('Brand assets generated successfully!');
}

generateAssets().catch((err) => {
  console.error('Failed to generate brand assets:', err);
  process.exit(1);
});
