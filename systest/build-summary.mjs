/* global console, process */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { comparePerf } from './perf-budget.mjs';

export function parseTap(tapContent) {
  if (!tapContent || !tapContent.trim()) {
    return { status: 'NOT RUN', total: 0, pass: 0, fail: 0, skipped: 0, durationMs: 0 };
  }

  const testsMatch = tapContent.match(/(?:#|ℹ)\s*tests\s+(\d+)/);
  const passMatch = tapContent.match(/(?:#|ℹ)\s*pass\s+(\d+)/);
  const failMatch = tapContent.match(/(?:#|ℹ)\s*fail\s+(\d+)/);
  const skipMatch = tapContent.match(/(?:#|ℹ)\s*skipped\s+(\d+)/);
  const durMatch = tapContent.match(/(?:#|ℹ)\s*duration_ms\s+([\d.]+)/);

  const total = testsMatch ? parseInt(testsMatch[1], 10) : 0;
  const pass = passMatch ? parseInt(passMatch[1], 10) : 0;
  const fail = failMatch ? parseInt(failMatch[1], 10) : 0;
  const skipped = skipMatch ? parseInt(skipMatch[1], 10) : 0;
  const durationMs = durMatch ? parseFloat(durMatch[1]) : 0;

  let status = 'NOT RUN';
  if (total > 0 || pass > 0 || fail > 0) {
    status = fail === 0 ? 'PASSED' : 'FAILED';
  }

  return { status, total, pass, fail, skipped, durationMs };
}

export function parsePlaywright(playwrightJson) {
  const PERSONA_CONFIGS = [
    { id: 'member', persona: 'member (Lưu regression)', viewport: 'Desktop (1440x900)' },
    { id: 'creator', persona: 'creator', viewport: 'Desktop (1440x900)' },
    { id: 'anon-viewer-desktop', persona: 'anon-viewer', viewport: 'Desktop (1440x900)' },
    { id: 'anon-viewer-mobile', persona: 'anon-viewer', viewport: 'Mobile (iPhone 14)' },
    { id: 'moderator', persona: 'moderator', viewport: 'Desktop (1440x900)' },
  ];

  if (!playwrightJson) {
    return PERSONA_CONFIGS.map((cfg) => ({
      ...cfg,
      status: 'NOT RUN',
      totalSpecs: 0,
      passedSpecs: 0,
      failedSpecs: 0,
      details: 'Not run',
    }));
  }

  // Collect test items by project
  const projectTests = new Map();
  for (const cfg of PERSONA_CONFIGS) {
    projectTests.set(cfg.id, []);
  }

  function walk(suite) {
    if (!suite) return;
    if (Array.isArray(suite.specs)) {
      for (const spec of suite.specs) {
        for (const test of spec.tests || []) {
          const proj = test.projectName || '';
          if (projectTests.has(proj)) {
            const resStatus = test.results?.[0]?.status || test.status;
            projectTests.get(proj).push({
              title: spec.title,
              status: resStatus,
              expected: test.status === 'expected' || resStatus === 'passed',
            });
          }
        }
      }
    }
    if (Array.isArray(suite.suites)) {
      for (const child of suite.suites) {
        walk(child);
      }
    }
  }

  if (Array.isArray(playwrightJson.suites)) {
    for (const topSuite of playwrightJson.suites) {
      walk(topSuite);
    }
  } else if (playwrightJson.suites) {
    walk(playwrightJson.suites);
  }

  return PERSONA_CONFIGS.map((cfg) => {
    const tests = projectTests.get(cfg.id) || [];
    if (tests.length === 0) {
      return {
        ...cfg,
        status: 'NOT RUN',
        totalSpecs: 0,
        passedSpecs: 0,
        failedSpecs: 0,
        details: 'Not run',
      };
    }

    const totalSpecs = tests.length;
    const passedSpecs = tests.filter((t) => t.expected || t.status === 'passed').length;
    const failedSpecs = tests.filter(
      (t) => !t.expected && (t.status === 'failed' || t.status === 'timedOut'),
    ).length;
    const skippedSpecs = tests.filter((t) => t.status === 'skipped').length;

    let status = 'PASSED';
    if (failedSpecs > 0) {
      status = 'FAILED';
    } else if (skippedSpecs === totalSpecs) {
      status = 'SKIPPED';
    }

    const details =
      `${passedSpecs}/${totalSpecs} specs passed` +
      (failedSpecs > 0 ? `, ${failedSpecs} failed` : '');
    return {
      ...cfg,
      status,
      totalSpecs,
      passedSpecs,
      failedSpecs,
      details,
    };
  });
}

export function buildSummaryMarkdown({
  tapContent = '',
  playwrightJson = null,
  perfJson = null,
  baselineJson = null,
  dateStr = new Date().toISOString(),
}) {
  const tap = parseTap(tapContent);
  const personas = parsePlaywright(playwrightJson);

  let budgetStatus = 'NOT RUN';
  let budgetViolations = [];
  if (perfJson) {
    if (baselineJson) {
      const cmp = comparePerf(perfJson, baselineJson);
      budgetStatus = cmp.passed ? 'PASSED' : 'FAILED';
      budgetViolations = cmp.violations || [];
    } else {
      budgetStatus = perfJson.http_req_failed < 0.01 ? 'PASSED (baseline set)' : 'FAILED';
      if (perfJson.http_req_failed >= 0.01) {
        budgetViolations.push(
          `Error rate ${(perfJson.http_req_failed * 100).toFixed(2)}% >= 1.00%`,
        );
      }
    }
  }

  const anyFailed =
    tap.status === 'FAILED' ||
    personas.some((p) => p.status === 'FAILED') ||
    budgetStatus.startsWith('FAILED');

  const allRunAndPassed =
    tap.status === 'PASSED' &&
    personas.every((p) => p.status === 'PASSED') &&
    budgetStatus.startsWith('PASSED');

  const overallStatus = anyFailed ? 'FAILED' : allRunAndPassed ? 'PASSED' : 'INCOMPLETE';

  let md = `# SIM1 Local Run Summary (ADR-038)\n\n`;
  md += `- **Date**: ${dateStr}\n`;
  md += `- **Status**: **${overallStatus}**\n`;
  md += `- **Stack**: Ephemeral Docker Compose with real web-svc (Traefik gateway http://127.0.0.1:8080)\n`;
  md += `- **Seed**: 20 users, 1 curator, 1 moderator, 40 short videos (16:9 & 9:16), 4 playlists, 2 series\n\n`;

  md += `## API System Tests (12 scenarios)\n\n`;
  if (tap.status === 'NOT RUN') {
    md += `- **Status**: NOT RUN\n\n`;
  } else {
    md += `- **Status**: **${tap.status}**\n`;
    md += `- **TAP Summary**: ${tap.pass} passed, ${tap.fail} failed, ${tap.total} total`;
    if (tap.durationMs > 0) {
      md += ` (${(tap.durationMs / 1000).toFixed(2)}s)`;
    }
    md += `\n\n`;
  }

  md += `## Persona Journeys (Playwright)\n\n`;
  md += `| Persona | Viewport | Status | Details |\n`;
  md += `|---|---|---|---|\n`;
  for (const p of personas) {
    md += `| ${p.persona} | ${p.viewport} | **${p.status}** | ${p.details} |\n`;
  }
  md += `\n`;

  md += `## Simulated Concurrency & Performance Budget (k6)\n\n`;
  if (!perfJson) {
    md += `- **Status**: NOT RUN\n\n`;
  } else {
    const reb = ((perfJson.rebuffer_ratio_noseek || 0) * 100).toFixed(2);
    const failRate = ((perfJson.http_req_failed || 0) * 100).toFixed(2);
    md += `- **HLS Viewers**: rebuffer ratio (non-seek) ${reb}%, http_req_failed ${failRate}%\n`;
    md += `- **API Reads**: http_req_failed ${failRate}%\n`;
    md += `- **Budget Status**: **${budgetStatus}** (threshold: p95 regr <= 20%, error rate < 1.0%)\n`;
    if (budgetViolations.length > 0) {
      md += `- **Violations**:\n`;
      for (const v of budgetViolations) {
        md += `  - ${v}\n`;
      }
    }
    md += `\n`;

    if (perfJson.endpoints && Object.keys(perfJson.endpoints).length > 0) {
      md += `### Endpoint Latencies\n\n`;
      md += `| Endpoint | p50 | p95 |\n`;
      md += `|---|---|---|\n`;
      for (const [ep, m] of Object.entries(perfJson.endpoints)) {
        md += `| ${ep} | ${(m.p50 || 0).toFixed(1)} ms | ${(m.p95 || 0).toFixed(1)} ms |\n`;
      }
      md += `\n`;
    }
  }

  return md;
}

function main() {
  const runDir = path.resolve(process.cwd(), 'systest/.run');
  const reportDir = path.join(runDir, 'report');
  const tapPath = path.join(reportDir, 'systest.tap');
  const playwrightPath = path.join(reportDir, 'playwright-results.json');
  const perfPath = path.join(reportDir, 'perf.json');
  const baselinePath = path.join(reportDir, 'baseline-perf.json');
  const summaryOut = path.join(reportDir, 'summary.md');

  let tapContent = '';
  if (fs.existsSync(tapPath)) {
    try {
      tapContent = fs.readFileSync(tapPath, 'utf8');
    } catch {
      /* ignore */
    }
  }

  let playwrightJson = null;
  if (fs.existsSync(playwrightPath)) {
    try {
      playwrightJson = JSON.parse(fs.readFileSync(playwrightPath, 'utf8'));
    } catch {
      /* ignore */
    }
  }

  let perfJson = null;
  if (fs.existsSync(perfPath)) {
    try {
      perfJson = JSON.parse(fs.readFileSync(perfPath, 'utf8'));
    } catch {
      /* ignore */
    }
  }

  let baselineJson = null;
  if (fs.existsSync(baselinePath)) {
    try {
      baselineJson = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
    } catch {
      /* ignore */
    }
  }

  const md = buildSummaryMarkdown({
    tapContent,
    playwrightJson,
    perfJson,
    baselineJson,
  });

  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(summaryOut, md, 'utf8');
  console.log(`[build-summary] Written ${summaryOut}`);
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(currentFile)) {
  main();
}
