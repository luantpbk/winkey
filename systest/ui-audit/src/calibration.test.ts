// systest/ui-audit/src/calibration.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runDeadControlProbes } from './probes/dead-control.probe.js';
import { ViewportSpec } from './types.js';

test('UI Audit Calibration: Exactly 1 dead-control (P0) and 1 click-failed (P2)', async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    const fixtureFilePath = fileURLToPath(new URL('../fixtures/calibration.html', import.meta.url));
    const fixtureUrl = pathToFileURL(fixtureFilePath).href;

    await page.goto(fixtureUrl, { waitUntil: 'domcontentloaded' });

    const vp: ViewportSpec = {
      id: 'desktop',
      width: 1920,
      height: 1080,
      dpr: 1,
      inputMode: 'mouse',
    };

    const findings = await runDeadControlProbes(page, vp, 'anon', fixtureUrl);

    const deadControls = findings.filter(f => f.category === 'dead-control');
    const clickFailed = findings.filter(f => f.category === 'click-failed');

    // Assertions
    assert.strictEqual(deadControls.length, 1, `Expected exactly 1 dead control, got ${deadControls.length}`);
    assert.match(deadControls[0].selector, /dead-btn|Nút chết/);
    assert.strictEqual(deadControls[0].severity, 'P0');

    assert.strictEqual(clickFailed.length, 1, `Expected exactly 1 click-failed, got ${clickFailed.length}`);
    assert.match(clickFailed[0].selector, /covered-btn|Nút bị che/);
    assert.strictEqual(clickFailed[0].severity, 'P2');
  } finally {
    await browser.close();
  }
});
