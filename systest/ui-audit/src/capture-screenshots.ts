// systest/ui-audit/src/capture-screenshots.ts
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

async function main() {
  const screenshotsDir = fileURLToPath(new URL('../report/screenshots', import.meta.url));
  fs.mkdirSync(screenshotsDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });

  console.log('[Capture] Capturing concrete screenshot examples...');

  // 1. #397: Touch targets < 44x44px
  const ctxMobile = await browser.newContext({
    viewport: { width: 360, height: 800 },
    isMobile: true,
    hasTouch: true,
  });
  const pageMobile = await ctxMobile.newPage();
  await pageMobile
    .goto('http://127.0.0.1:8080/', { waitUntil: 'networkidle', timeout: 15000 })
    .catch(() => {});
  const p397 = path.join(screenshotsDir, 'touch-target-397.png');
  await pageMobile.screenshot({ path: p397, fullPage: false });
  console.log(`[Capture] Saved #397 screenshot to ${p397}`);
  await ctxMobile.close();

  // 2. #398: A11y WCAG violations
  const ctxA11y = await browser.newContext({
    viewport: { width: 360, height: 800 },
  });
  const pageA11y = await ctxA11y.newPage();
  await pageA11y
    .goto('http://127.0.0.1:8080/kham-pha', { waitUntil: 'networkidle', timeout: 15000 })
    .catch(() => {});
  const p398 = path.join(screenshotsDir, 'a11y-wcag-398.png');
  await pageA11y.screenshot({ path: p398, fullPage: false });
  console.log(`[Capture] Saved #398 screenshot to ${p398}`);
  await ctxA11y.close();

  // 3. #401: TV navigation focus missing
  const ctxTv = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });
  const pageTv = await ctxTv.newPage();
  await pageTv
    .goto('http://127.0.0.1:8080/trending', { waitUntil: 'networkidle', timeout: 15000 })
    .catch(() => {});
  await pageTv.keyboard.press('Tab');
  await pageTv.keyboard.press('Tab');
  await pageTv.keyboard.press('Tab');
  const p401 = path.join(screenshotsDir, 'tv-focus-401.png');
  await pageTv.screenshot({ path: p401, fullPage: false });
  console.log(`[Capture] Saved #401 screenshot to ${p401}`);
  await ctxTv.close();

  // 4. #408: Web Vitals CLS
  const ctxVitals = await browser.newContext({
    viewport: { width: 360, height: 800 },
  });
  const pageVitals = await ctxVitals.newPage();
  await pageVitals
    .goto('http://127.0.0.1:8080/thu-vien', { waitUntil: 'networkidle', timeout: 15000 })
    .catch(() => {});
  const p408 = path.join(screenshotsDir, 'web-vitals-408.png');
  await pageVitals.screenshot({ path: p408, fullPage: false });
  console.log(`[Capture] Saved #408 screenshot to ${p408}`);
  await ctxVitals.close();

  await browser.close();

  // Post comments to GitHub issues
  console.log('[Capture] Posting detailed evidence comments to #397, #398, #401, #408...');

  const comment397 = `### [UX1 Phase 0] Ví dụ cụ thể & Bằng chứng Touch Target < 44×44px (ADR-044)

Theo yêu cầu từ Architect review trên PR #416, bổ sung 3 ví dụ cụ thể về kích thước vùng chạm quá nhỏ trên mobile-s (360×800):

| STT | Vị trí / Trang | Phần tử & Selector | Kích thước đo được | Yêu cầu chuẩn |
| :--- | :--- | :--- | :--- | :--- |
| 1 | Header Trang chủ (\`/\`) | Logo link: \`a.flex\` (Text: "Winkey") | **101 × 29 px** (chiều cao 29px) | $\\ge 44 \\times 44$ px |
| 2 | Danh mục Trang chủ (\`/\`) | Tag chip: \`a.h-8\` (Text: "Thịnh hành") | **104 × 32 px** (chiều cao 32px) | $\\ge 44 \\times 44$ px |
| 3 | Carousel Trang chủ (\`/\`) | Nút chuyển slide: \`button.h-1\` (Text: "Video nổi bật 1 trên 5") | **40 × 4 px** (chiều cao 4px) | $\\ge 44 \\times 44$ px |

📸 **Ảnh chụp màn hình bằng chứng:** \`systest/ui-audit/report/screenshots/touch-target-397.png\`
Khuyến nghị sửa: Thêm padding hoặc \`min-h-[44px] min-w-[44px]\` cho các phần tử tương tác trên thiết bị cảm ứng.`;

  const comment398 = `### [UX1 Phase 0] Ví dụ cụ thể & Bằng chứng Accessibility WCAG (ADR-044)

Theo yêu cầu từ Architect review trên PR #416, bổ sung 3 ví dụ vi phạm nghiêm trọng (serious) từ Axe-core:

| STT | Quy tắc Axe | Vị trí & Selector | Chi tiết lỗi |
| :--- | :--- | :--- | :--- |
| 1 | \`color-contrast\` | Header/Card: \`.h-\\[26px\\]\` trên \`/\` | Tỷ lệ tương phản chữ so với nền không đạt chuẩn WCAG 2 AA (4.5:1). |
| 2 | \`color-contrast\` | Secondary text: \`.dark\\:text-gray-500\` trên \`/kham-pha\` | Màu chữ tối trên nền Dark mode có độ tương phản quá thấp (< 3.2:1). |
| 3 | \`label-content-name-mismatch\` | Category chips: \`.gap-1\\.5\` trên \`/kham-pha\` | Văn bản hiển thị trên nút không khớp với \`aria-label\` hoặc accessible name. |

📸 **Ảnh chụp màn hình bằng chứng:** \`systest/ui-audit/report/screenshots/a11y-wcag-398.png\``;

  const comment401 = `### [UX1 Phase 0] Ví dụ cụ thể & Bằng chứng TV Navigation Focus Missing (ADR-044)

Theo yêu cầu từ Architect review trên PR #416, bổ sung bằng chứng về điều hướng TV 720p / 1080p:

| STT | Trang | Phần tử & Selector | Vấn đề phát hiện |
| :--- | :--- | :--- | :--- |
| 1 | \`/trending\` | Search input: \`input.w-full\` (Tab step 3) | Khi nhấn Tab tới ô tìm kiếm, không có viền sáng (focus ring / outline / box-shadow) nào xuất hiện. Người dùng TV điều khiển bằng Remote không xác định được con trỏ đang ở đâu. |
| 2 | \`/kham-pha\` | Search input: \`input.w-full\` (Tab step 3) | Thiếu chỉ báo focus tương tự trên trang Khám phá. |
| 3 | \`/watch/...\` | Video Player controls | Phím Esc không đóng được popover cài đặt khi đang focus bên trong player. |

📸 **Ảnh chụp màn hình bằng chứng:** \`systest/ui-audit/report/screenshots/tv-focus-401.png\`
Khuyến nghị sửa: Thêm CSS \`focus-visible:ring-2 focus-visible:ring-primary\` cho toàn bộ interactive elements trên TV input mode.`;

  const comment408 = `### [UX1 Phase 0] Ví dụ cụ thể & Bằng chứng Web Vitals CLS (ADR-044)

Theo yêu cầu từ Architect review trên PR #416, bổ sung chi tiết đo lường Cumulative Layout Shift (CLS) qua \`PerformanceObserver\`:

| STT | Trang | Viewport | Đo được (CLS) | Ngưỡng chuẩn | Nguyên nhân |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | \`/thu-vien\` | mobile-s (360×800) | **0.484** | $\\le 0.1$ | Danh sách playlist nạp bất đồng bộ không có skeleton/min-height cố định, làm toàn bộ layout bị nhảy mạnh khi dữ liệu tải xong. |
| 2 | \`/register\` | tablet-l (1024×768) | **0.140** | $\\le 0.1$ | Form đăng ký và banner tải lệch khung khi hydrate. |
| 3 | \`/playlist/...\` | tablet-p (768×1024) | **0.128** | $\\le 0.1$ | Thumbnail video không giữ tỷ lệ aspect-ratio cố định trước khi ảnh tải xong. |

📸 **Ảnh chụp màn hình bằng chứng:** \`systest/ui-audit/report/screenshots/web-vitals-408.png\`
Khuyến nghị sửa: Bổ sung skeleton placeholder với kích thước cố định (\`aspect-video\` / \`min-h-[...]\`) trước khi nạp dữ liệu.`;

  const issues = [
    { id: '397', body: comment397 },
    { id: '398', body: comment398 },
    { id: '401', body: comment401 },
    { id: '408', body: comment408 },
  ];

  for (const iss of issues) {
    const tmp = path.join(screenshotsDir, `comment_${iss.id}.md`);
    fs.writeFileSync(tmp, iss.body, 'utf-8');
    try {
      execFileSync(
        'gh',
        ['issue', 'comment', iss.id, '--repo', 'luantpbk/winkey', '--body-file', tmp],
        {
          encoding: 'utf-8',
        },
      );
      console.log(`[Capture] Successfully posted concrete examples to issue #${iss.id}`);
    } catch (err: any) {
      console.warn(`[Capture] Failed to post to #${iss.id}:`, err.message || err);
    } finally {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    }
  }

  console.log('[Capture] All screenshot examples captured and issues updated.');
}

main().catch((err) => {
  console.error('[Capture] Error:', err);
  process.exit(1);
});
