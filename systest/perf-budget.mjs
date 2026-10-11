/* global console, process */
import fs from 'node:fs';
import path from 'node:path';

function parseArgs() {
  const args = process.argv.slice(2);
  let currentPath = '';
  let baselinePath = '';
  for (const arg of args) {
    if (arg.startsWith('--current=')) {
      currentPath = arg.split('=')[1];
    } else if (arg.startsWith('--baseline=')) {
      baselinePath = arg.split('=')[1];
    }
  }
  return {
    currentPath:
      currentPath ||
      process.env.PERF_PATH ||
      path.join(process.cwd(), 'systest/.run/report/perf.json'),
    baselinePath:
      baselinePath ||
      process.env.BASELINE_PERF_PATH ||
      path.join(process.cwd(), 'systest/.run/report/baseline-perf.json'),
  };
}

export function comparePerf(current, baseline) {
  const violations = [];

  // Check error rate
  if (current.http_req_failed >= 0.01) {
    violations.push(
      `Error rate budget exceeded: http_req_failed ${(current.http_req_failed * 100).toFixed(2)}% >= 1.00%`,
    );
  }

  // Compare endpoint latencies
  const currentEndpoints = current.endpoints || {};
  const baselineEndpoints = baseline.endpoints || {};

  for (const [ep, cMetrics] of Object.entries(currentEndpoints)) {
    const bMetrics = baselineEndpoints[ep];
    if (!bMetrics) continue;

    const bP95 = bMetrics.p95 || 0;
    const cP95 = cMetrics.p95 || 0;

    // Regressed by > 20% if current is more than 1.20x baseline (with minimum 10ms margin for noise)
    if (bP95 > 0 && cP95 > bP95 * 1.2 && cP95 - bP95 > 10) {
      const regrPct = (((cP95 - bP95) / bP95) * 100).toFixed(1);
      violations.push(
        `Latency regression > 20% on [${ep}]: p95 was ${bP95.toFixed(1)}ms, now ${cP95.toFixed(1)}ms (+${regrPct}%)`,
      );
    }
  }

  return {
    passed: violations.length === 0,
    violations,
  };
}

function main() {
  const { currentPath, baselinePath } = parseArgs();

  if (!fs.existsSync(currentPath)) {
    console.error(`[perf-budget] ERROR: Current perf file not found: ${currentPath}`);
    process.exit(1);
  }

  const current = JSON.parse(fs.readFileSync(currentPath, 'utf8'));

  if (!fs.existsSync(baselinePath)) {
    console.log(
      `[perf-budget] No previous baseline found at ${baselinePath}. Recording current run as baseline.`,
    );
    fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
    fs.writeFileSync(baselinePath, JSON.stringify(current, null, 2));
    fs.writeFileSync(path.join(path.dirname(baselinePath), '.is-baseline-run'), 'true');
    process.exit(0);
  }

  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  console.log(`[perf-budget] Comparing ${currentPath} against baseline ${baselinePath}...`);

  const result = comparePerf(current, baseline);

  if (result.passed) {
    console.log('[perf-budget] PASS: All relative performance budgets met within 20% threshold.');
    process.exit(0);
  } else {
    console.error('[perf-budget] FAIL: Performance budget violated:');
    for (const v of result.violations) {
      console.error(`  - ${v}`);
    }
    process.exit(1);
  }
}

if (process.argv[1] && process.argv[1].endsWith('perf-budget.mjs')) {
  main();
}
