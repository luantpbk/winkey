/* global fetch, WebSocket, process, console, setTimeout */
// test-browser-cdp.mjs
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTTP_PORT = 8089;
const CDP_PORT = 9223;
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const CSP1_POLICY =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; connect-src 'self'";

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

// 1. Khởi tạo HTTP Server cổng 8089 kèm CSP1 Header
function startLocalServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const urlPath = req.url.split('?')[0];
      const safeRelPath = path
        .normalize(urlPath === '/' ? '/index.html' : urlPath)
        .replace(/^(\.\.[/\\])+/, '');
      const filePath = path.join(__dirname, safeRelPath);

      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('404 Not Found');
      }

      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
        'Content-Security-Policy': CSP1_POLICY,
        'Cache-Control': 'no-store',
      });
      fs.createReadStream(filePath).pipe(res);
    });

    server.on('error', reject);
    server.listen(HTTP_PORT, '127.0.0.1', () => resolve(server));
  });
}

// 2. Giao tiếp CDP tối giản qua Native WebSocket (Node 22)
class CdpSession {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.msgId = 0;
    this.pending = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) {
          reject(new Error(msg.error.message));
        } else {
          resolve(msg.result);
        }
      }
    };
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.msgId;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
    }
  }
}

// 3. Chạy benchmark trong một tab hoàn toàn mới được cô lập qua CDP HTTP API
async function runProfileInFreshTab(cdpPort, targetUrl, rate) {
  const createRes = await fetch(`http://127.0.0.1:${cdpPort}/json/new`, {
    method: 'PUT',
  });
  const targetInfo = await createRes.json();
  const tabId = targetInfo.id;
  const cdp = new CdpSession(targetInfo.webSocketDebuggerUrl);

  await cdp.connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setCPUThrottlingRate', { rate });
  await cdp.send('Page.navigate', { url: `${targetUrl}?rate=${rate}&t=${Date.now()}` });

  try {
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 600));
      const evalRes = await cdp.send('Runtime.evaluate', {
        expression: `JSON.stringify({
          bench: window.__BENCHMARK_RESULTS__ || null,
          csp: window.__CSP_VIOLATIONS__ || []
        })`,
        returnByValue: true,
      });

      const rawVal = evalRes?.result?.value;
      if (!rawVal) continue;

      const { bench, csp } = JSON.parse(rawVal);
      if (bench && (bench.status === 'completed' || bench.status === 'error')) {
        if (bench.status === 'error') {
          throw new Error(`Benchmark error at rate=${rate}: ${bench.error}`);
        }
        return { bench, csp };
      }
    }
    throw new Error(`Timeout (90s) waiting for 1000 iterations benchmark at rate=${rate}`);
  } finally {
    cdp.close();
    await fetch(`http://127.0.0.1:${cdpPort}/json/close/${tabId}`).catch(() => {
      /* ignore */
    });
  }
}

async function main() {
  const server = await startLocalServer();
  const tempProfileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'winkey-cdp-'));

  const chromeProc = spawn(CHROME_PATH, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${tempProfileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-extensions',
    'about:blank',
  ]);

  try {
    let versionInfo = null;
    for (let i = 0; i < 40; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
        if (res.ok) {
          versionInfo = await res.json();
          break;
        }
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    if (!versionInfo) throw new Error('Failed to attach to Headless Chrome on port 9223');

    const targetUrl = `http://127.0.0.1:${HTTP_PORT}/index.html`;

    console.log('========================================================================');
    console.log(' Winkey SOC-3: Real Browser Benchmark & CSP1 Compliance (CDP)');
    console.log(` Browser:     ${versionInfo.Browser}`);
    console.log(` User Agent:  ${versionInfo['User-Agent']}`);
    console.log(` CSP1 Policy: ${CSP1_POLICY}`);
    console.log('========================================================================\n');

    // Test 1: Desktop (rate = 1) trong Fresh Tab
    console.log('--- Run 1: Desktop (Emulation.setCPUThrottlingRate rate = 1, Fresh Tab) ---');
    const run1 = await runProfileInFreshTab(CDP_PORT, targetUrl, 1);
    console.log(`Status: ${run1.bench.status}`);
    console.log(`Startup (vodozemac): ${run1.bench.startup_ms.vodozemac_primary} ms`);
    console.log(`Startup (libolm):    ${run1.bench.startup_ms.libolm_baseline} ms`);
    console.log(
      `Olm 1-1 Encrypt 1 KiB (vodozemac): median=${run1.bench.olm_1to1.encrypt_1kib_median_ms} ms, p95=${run1.bench.olm_1to1.encrypt_1kib_p95_ms} ms`,
    );
    console.log(
      `Olm 1-1 Encrypt 1 KiB (libolm):    median=${run1.bench.olm_1to1.encrypt_1kib_median_ms} ms, p95=${run1.bench.olm_1to1.encrypt_1kib_p95_ms} ms`,
    );
    console.log(
      `Megolm Share 100 devices: vodozemac=${run1.bench.megolm_group_50.share_key_100_devices_ms} ms | libolm=${run1.bench.megolm_group_50.share_key_100_devices_ms} ms`,
    );
    console.log(`Argon2id 64 MiB Derivation: ${run1.bench.argon2id_derivation_ms} ms`);
    console.log(`Worker Offload Duration:   ${run1.bench.worker_offload?.durationMs} ms`);
    console.log(`CSP Violations (rate=1):   ${run1.csp.length}`);
    if (run1.csp.length > 0) {
      console.log('Violations detail:', run1.csp);
    }
    console.log('');

    // Test 2: Mobile Simulation (rate = 4) trong Fresh Tab hoàn toàn độc lập
    console.log(
      '--- Run 2: Mobile 4x Throttle (Emulation.setCPUThrottlingRate rate = 4, Fresh Tab) ---',
    );
    const run4 = await runProfileInFreshTab(CDP_PORT, targetUrl, 4);
    console.log(`Status: ${run4.bench.status}`);
    console.log(`Startup (vodozemac): ${run4.bench.startup_ms.vodozemac_primary} ms`);
    console.log(`Startup (libolm):    ${run4.bench.startup_ms.libolm_baseline} ms`);
    console.log(
      `Olm 1-1 Encrypt 1 KiB (vodozemac): median=${run4.bench.olm_1to1.encrypt_1kib_median_ms} ms, p95=${run4.bench.olm_1to1.encrypt_1kib_p95_ms} ms`,
    );
    console.log(
      `Olm 1-1 Encrypt 1 KiB (libolm):    median=${run4.bench.olm_1to1.encrypt_1kib_median_ms} ms, p95=${run4.bench.olm_1to1.encrypt_1kib_p95_ms} ms`,
    );
    console.log(
      `Megolm Share 100 devices: vodozemac=${run4.bench.megolm_group_50.share_key_100_devices_ms} ms | libolm=${run4.bench.megolm_group_50.share_key_100_devices_ms} ms`,
    );
    console.log(`Argon2id 64 MiB Derivation: ${run4.bench.argon2id_derivation_ms} ms`);
    console.log(`Worker Offload Duration:   ${run4.bench.worker_offload?.durationMs} ms`);
    console.log(`CSP Violations (rate=4):   ${run4.csp.length}`);
    if (run4.csp.length > 0) {
      console.log('Violations detail:', run4.csp);
    }
    console.log('');

    const totalViolations = run1.csp.length + run4.csp.length;
    const finalReport = {
      browser: versionInfo.Browser,
      userAgent: versionInfo['User-Agent'],
      csp_header: CSP1_POLICY,
      total_csp_violations: totalViolations,
      desktop_rate_1: run1.bench,
      mobile_rate_4: run4.bench,
    };

    console.log('### FULL BROWSER CDP JSON REPORT ###');
    console.log(JSON.stringify(finalReport, null, 2));

    if (totalViolations !== 0) {
      console.error('FAIL: Detected CSP violations in browser!');
      process.exitCode = 1;
    } else {
      console.log('SUCCESS: 0 CSP violations detected under strict CSP1 policy!');
    }
  } finally {
    chromeProc.kill();
    server.close();
    try {
      fs.rmSync(tempProfileDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

main().catch((err) => {
  console.error('[CDP Runner Error]', err);
  process.exit(1);
});
