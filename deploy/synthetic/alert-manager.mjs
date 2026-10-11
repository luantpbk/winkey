#!/usr/bin/env node
/**
 * deploy/synthetic/alert-manager.mjs
 *
 * MON1 production synthetic monitoring alert manager (ADR-038).
 * Tracks consecutive failures/greens across runs.
 * - Opens/updates issue `[synthetic] <check> failing` after 2 consecutive failures.
 * - Auto-closes issue after 3 consecutive green runs.
 * - Writes detailed markdown report to $GITHUB_STEP_SUMMARY.
 *
 * Zero external dependencies.
 */

import fs from 'node:fs';
import path from 'node:path';

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_API_URL = process.env.GITHUB_API_URL || 'https://api.github.com';
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY || '';
const GITHUB_SERVER_URL = process.env.GITHUB_SERVER_URL || 'https://github.com';
const GITHUB_RUN_ID = process.env.GITHUB_RUN_ID || '';
const RUN_URL = GITHUB_REPOSITORY && GITHUB_RUN_ID
  ? `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`
  : '';

const STATE_DIR = path.resolve('.synthetic-state');
const STATE_FILE = path.join(STATE_DIR, 'state.json');

/**
 * Make an authenticated GitHub API request.
 */
async function githubApi(endpoint, options = {}) {
  if (!GITHUB_TOKEN || !GITHUB_REPOSITORY) {
    console.warn('[alert-manager] GITHUB_TOKEN or GITHUB_REPOSITORY not set; skipping GitHub API call.');
    return null;
  }

  const url = endpoint.startsWith('http') ? endpoint : `${GITHUB_API_URL}/repos/${GITHUB_REPOSITORY}${endpoint}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'WinkeySynthetic/1.0',
      ...(options.headers || {}),
    },
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => '');
    throw new Error(`GitHub API ${options.method || 'GET'} ${url} returned ${res.status}: ${errorText}`);
  }

  if (res.status === 204) {
    return null;
  }

  return res.json();
}

/**
 * Load persisted state or default.
 */
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, 'utf-8');
      return JSON.parse(raw);
    }
  } catch (err) {
    console.warn('[alert-manager] Failed to read state file, starting fresh:', err.message);
  }
  return {
    consecutiveFailures: {},
    consecutiveGreens: 0,
  };
}

/**
 * Persist state to disk.
 */
function saveState(state) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
  } catch (err) {
    console.error('[alert-manager] Failed to save state file:', err.message);
  }
}

/**
 * Find open issues with label 'synthetic'.
 */
async function getOpenSyntheticIssues() {
  if (!GITHUB_TOKEN || !GITHUB_REPOSITORY) return [];
  try {
    const issues = await githubApi('/issues?state=open&labels=synthetic');
    return Array.isArray(issues) ? issues : [];
  } catch (err) {
    console.error('[alert-manager] Failed to fetch open issues:', err.message);
    return [];
  }
}

/**
 * Create a new GitHub issue.
 */
async function createIssue(title, body) {
  return githubApi('/issues', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title,
      body,
      labels: ['synthetic'],
    }),
  });
}

/**
 * Add a comment to an issue.
 */
async function commentIssue(issueNumber, body) {
  return githubApi(`/issues/${issueNumber}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
  });
}

/**
 * Close an issue.
 */
async function closeIssue(issueNumber, commentBody) {
  if (commentBody) {
    await commentIssue(issueNumber, commentBody);
  }
  return githubApi(`/issues/${issueNumber}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      state: 'closed',
      state_reason: 'completed',
    }),
  });
}

async function main() {
  const logFile = process.argv[2] || '.synthetic/output.log';
  if (!fs.existsSync(logFile)) {
    console.error(`[alert-manager] Log file not found: ${logFile}`);
    process.exit(1);
  }

  const rawLines = fs.readFileSync(logFile, 'utf-8')
    .replace(/^\uFEFF/, '')
    .replace(/\0/g, '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  const parsedResults = [];
  for (const line of rawLines) {
    try {
      const obj = JSON.parse(line);
      if (obj.name && obj.status) {
        parsedResults.push(obj);
      }
    } catch {
      // ignore non-json log lines
    }
  }

  if (parsedResults.length === 0) {
    console.error('[alert-manager] No probe result JSON lines found in log.');
    process.exit(1);
  }

  const state = loadState();
  if (!state.consecutiveFailures) state.consecutiveFailures = {};
  if (typeof state.consecutiveGreens !== 'number') state.consecutiveGreens = 0;

  const failedResults = parsedResults.filter(r => r.status === 'FAIL');
  const isAllGreen = failedResults.length === 0;

  const openIssues = await getOpenSyntheticIssues();

  if (isAllGreen) {
    // Reset all failure counters
    for (const key of Object.keys(state.consecutiveFailures)) {
      state.consecutiveFailures[key] = 0;
    }
    state.consecutiveGreens += 1;

    console.log(`[alert-manager] All checks passed. Consecutive greens: ${state.consecutiveGreens}`);

    // If there are open synthetic issues, notify and check auto-close threshold (3 green runs)
    for (const issue of openIssues) {
      if (state.consecutiveGreens >= 3) {
        console.log(`[alert-manager] Auto-closing issue #${issue.number} (${issue.title}) after ${state.consecutiveGreens} green runs.`);
        await closeIssue(
          issue.number,
          `### :white_check_mark: Alert Resolved\n\nAll synthetic checks have passed successfully for **${state.consecutiveGreens} consecutive runs**.\nLatest run: [Run #${GITHUB_RUN_ID || 'local'}](${RUN_URL})\n\nAuto-closing issue.`
        );
      } else {
        console.log(`[alert-manager] Posting green run notice on issue #${issue.number} (${state.consecutiveGreens}/3).`);
        await commentIssue(
          issue.number,
          `### :white_check_mark: Green Run Detected (${state.consecutiveGreens}/3)\n\nSynthetic monitoring run [Run #${GITHUB_RUN_ID || 'local'}](${RUN_URL}) passed.\nWaiting for 3 consecutive green runs to auto-close.`
        );
      }
    }
  } else {
    // Reset consecutive green counter
    state.consecutiveGreens = 0;

    for (const fail of failedResults) {
      const checkName = fail.name;
      state.consecutiveFailures[checkName] = (state.consecutiveFailures[checkName] || 0) + 1;
      const count = state.consecutiveFailures[checkName];
      console.log(`[alert-manager] Check '${checkName}' failed (consecutive failures: ${count}).`);

      const matchingIssue = openIssues.find(i =>
        i.title.toLowerCase().includes(`[synthetic] ${checkName.toLowerCase()} failing`) ||
        i.title.toLowerCase().includes(`[synthetic]`) && i.title.toLowerCase().includes(checkName.toLowerCase())
      );

      if (count >= 2 || matchingIssue) {
        const title = `[synthetic] ${checkName} failing`;
        const bodyContent = `### :rotating_light: Synthetic Monitoring Alert: \`${checkName}\` Failing\n\n` +
          `- **Check:** \`${checkName}\`\n` +
          `- **Consecutive Failures:** ${count}\n` +
          `- **Latest Run:** [Run #${GITHUB_RUN_ID || 'local'}](${RUN_URL})\n` +
          `- **Duration:** ${fail.ms} ms\n` +
          `- **Error:**\n\`\`\`\n${fail.error || 'Unknown error'}\n\`\`\`\n` +
          `- **Timestamp:** ${new Date().toISOString()}\n\n` +
          `*This alert is automatically managed by .github/workflows/synthetic.yml. It will auto-close after 3 consecutive green runs.*`;

        if (matchingIssue) {
          console.log(`[alert-manager] Updating existing issue #${matchingIssue.number} for check '${checkName}'.`);
          await commentIssue(matchingIssue.number, bodyContent);
        } else {
          console.log(`[alert-manager] Opening new issue '${title}' after ${count} consecutive failures.`);
          await createIssue(title, bodyContent);
        }
      } else {
        console.log(`[alert-manager] First failure for check '${checkName}'; waiting for 2nd failure before alerting.`);
      }
    }

    // Reset counters for checks that passed
    for (const passed of parsedResults.filter(r => r.status === 'PASS')) {
      state.consecutiveFailures[passed.name] = 0;
    }
  }

  saveState(state);

  // Write GITHUB_STEP_SUMMARY if available
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    try {
      let md = `## Production Synthetic Monitoring (MON1)\n\n`;
      md += `**Result:** ${isAllGreen ? ':white_check_mark: **ALL PASSED**' : ':x: **FAILURE DETECTED**'}\n\n`;
      md += `| Check | Status | Duration | Details |\n`;
      md += `|---|---|---|---|\n`;

      for (const r of parsedResults) {
        const icon = r.status === 'PASS' ? ':white_check_mark: PASS' : ':x: FAIL';
        const detail = r.status === 'PASS' ? 'OK' : `\`${r.error || 'Failed'}\``;
        md += `| \`${r.name}\` | ${icon} | ${r.ms} ms | ${detail} |\n`;
      }

      md += `\n**Consecutive Green Runs:** ${state.consecutiveGreens}/3\n`;
      if (failedResults.length > 0) {
        md += `\n> [!CAUTION]\n> Failed checks: ${failedResults.map(f => `\`${f.name}\` (x${state.consecutiveFailures[f.name] || 1})`).join(', ')}\n`;
      }

      fs.appendFileSync(summaryPath, md, 'utf-8');
    } catch (err) {
      console.warn('[alert-manager] Failed to write step summary:', err.message);
    }
  }

  if (!isAllGreen) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('[alert-manager] Fatal error:', err);
  process.exit(1);
});
