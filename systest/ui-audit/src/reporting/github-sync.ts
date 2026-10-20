// systest/ui-audit/src/reporting/github-sync.ts
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { AuditFinding, AuditSummary } from '../types.js';

interface FindingGroup {
  rootCauseKey: string;
  title: string;
  category: string;
  severity: string;
  isBackendGap: boolean;
  affectedRoutes: string[];
  affectedViewports: string[];
  sampleMessage: string;
  selectors: string[];
  count: number;
  findings: AuditFinding[];
}

export function groupFindingsByRootCause(findings: AuditFinding[]): FindingGroup[] {
  const groups = new Map<string, FindingGroup>();

  for (const f of findings) {
    let rootCauseKey = '';
    let isBackend = Boolean(f.isBackendSuspect);
    let title = '';

    const text = (f.message + ' ' + f.selector).toLowerCase();

    if (text.includes('#history') || text.includes('lịch sử')) {
      rootCauseKey = 'history-link-dead';
      title = '[UX1] Sidebar link "Lịch sử" points to #history without API implementation';
      isBackend = true;
    } else if (text.includes('thích') || text.includes('like')) {
      rootCauseKey = 'cinema-like-button-dead';
      title = '[UX1] Cinema detail dialog "Thích" button has no handler';
    } else if (text.includes('kham-pha') && text.includes('chip')) {
      rootCauseKey = 'explore-chips-dead';
      title = '[UX1] Explore page category chips have no click handler';
    } else if (f.category === 'dead-control') {
      rootCauseKey = `dead-control-${f.route.replace(/[/:?=&]/g, '-')}`;
      title = `[UX1] Interactive elements not responsive on ${f.route}`;
    } else if (f.category === 'overflow-x') {
      rootCauseKey = `overflow-${f.route.replace(/[/:?=&]/g, '-')}`;
      title = `[UX1] Horizontal layout overflow on ${f.route}`;
    } else if (f.category === 'touch-target') {
      rootCauseKey = 'touch-target-small';
      title = '[UX1] Touch targets smaller than 44x44px on interactive controls';
    } else if (f.category === 'tv-focus') {
      rootCauseKey = 'tv-navigation-focus';
      title = '[UX1] TV navigation focus indicators missing or dialog trap';
    } else if (f.category === 'axe-a11y') {
      rootCauseKey = 'axe-a11y-wcag';
      title = '[UX1] Accessibility WCAG serious/critical violations';
    } else {
      rootCauseKey = `misc-${f.category}`;
      title = `[UX1] UI/UX polish issue: ${f.category}`;
    }

    if (!groups.has(rootCauseKey)) {
      groups.set(rootCauseKey, {
        rootCauseKey,
        title,
        category: f.category,
        severity: f.severity,
        isBackendGap: isBackend,
        affectedRoutes: [],
        affectedViewports: [],
        sampleMessage: f.message,
        selectors: [],
        count: 0,
        findings: [],
      });
    }

    const grp = groups.get(rootCauseKey)!;
    grp.count++;
    grp.findings.push(f);
    if (!grp.affectedRoutes.includes(f.route)) grp.affectedRoutes.push(f.route);
    if (!grp.affectedViewports.includes(f.viewport)) grp.affectedViewports.push(f.viewport);
    if (f.selector && !grp.selectors.includes(f.selector) && grp.selectors.length < 15) {
      grp.selectors.push(f.selector);
    }
    if (f.severity === 'P0') grp.severity = 'P0';
    else if (f.severity === 'P1' && grp.severity !== 'P0') grp.severity = 'P1';
    if (isBackend) grp.isBackendGap = true;
  }

  return Array.from(groups.values());
}

export function syncFindingsToGitHub(summary: AuditSummary): void {
  console.log('[GitHub Sync] Grouping findings by root cause and syncing to GitHub Issues...');

  const groups = groupFindingsByRootCause(summary.findings);
  const tmpDir = path.resolve('/tmp');
  const tempIssueBody = path.join(tmpDir, `ux1_issue_${Date.now()}.md`);
  const tempCommentBody = path.join(tmpDir, `ux1_summary_${Date.now()}.md`);

  const createdIssueUrls: string[] = [];

  for (const g of groups) {
    const labels = ['ux1', g.severity.toLowerCase()];
    if (g.isBackendGap) {
      labels.push('backend');
    }

    let body = `### Root Cause Group\n`;
    body += `Automated UX1 Phase 0 UI Audit detected an issue group with **${g.count} occurrences**.\n\n`;
    body += `- **Severity**: **${g.severity}**\n`;
    body += `- **Category**: \`${g.category}\`\n`;
    body += `- **Classification**: ${g.isBackendGap ? '`backend` (API missing / contract gap)' : '`frontend` (Antigravity 1)'}\n`;
    body += `- **Affected Viewports**: ${g.affectedViewports.map((v) => `\`${v}\``).join(', ')}\n`;
    body += `- **Affected Routes**: ${g.affectedRoutes.map((r) => `\`${r}\``).join(', ')}\n\n`;

    body += `### Sample Selectors & Elements\n`;
    for (const sel of g.selectors.slice(0, 10)) {
      body += `- \`${sel}\`\n`;
    }
    body += `\n### Sample Finding\n> ${g.sampleMessage}\n`;

    fs.writeFileSync(tempIssueBody, body, 'utf-8');

    try {
      const args = [
        'issue',
        'create',
        '--repo',
        'luantpbk/winkey',
        '--title',
        g.title,
        '--body-file',
        tempIssueBody,
        '--label',
        labels.join(','),
      ];
      const out = execFileSync('gh', args, { encoding: 'utf-8' }).trim();
      console.log(`[GitHub Sync] Created issue: ${out}`);
      createdIssueUrls.push(out);
    } catch (err: any) {
      console.warn(`[GitHub Sync] Failed to create issue for "${g.title}":`, err.message || err);
    }
  }

  // Post summary comment to Issue #47
  try {
    let comment = `### [UX1 Phase 0] Automated UI Audit Summary Report (ADR-044)\n\n`;
    comment += `Antigravity 4 báo cáo kết quả kiểm toán UI tự động trên 8 viewports và 4 personas:\n\n`;
    comment += `- **Tổng số lượt kiểm tra:** ${summary.totalChecks}\n`;
    comment += `- **Thời gian chạy:** ${(summary.durationMs / 1000).toFixed(1)}s\n`;
    comment += `- **Tổng số vi phạm sau khử trùng lặp:** ${summary.findings.length}\n`;
    comment += `  - 🔴 **P0 (Critical / Dead Controls):** ${summary.counts.P0}\n`;
    comment += `  - 🟠 **P1 (Layout Overflow / Touch Target / A11y):** ${summary.counts.P1}\n`;
    comment += `  - 🟡 **P2 (Polish):** ${summary.counts.P2}\n\n`;

    comment += `#### Nhóm lỗi đã mở Issue (giao Antigravity 1 & Backend):\n`;
    for (const url of createdIssueUrls) {
      comment += `- ${url}\n`;
    }

    fs.writeFileSync(tempCommentBody, comment, 'utf-8');
    execFileSync(
      'gh',
      ['issue', 'comment', '47', '--repo', 'luantpbk/winkey', '--body-file', tempCommentBody],
      {
        encoding: 'utf-8',
      },
    );
    console.log('[GitHub Sync] Posted summary comment to Issue #47.');
  } catch (err: any) {
    console.warn('[GitHub Sync] Failed to post comment to Issue #47:', err.message || err);
  } finally {
    try {
      if (fs.existsSync(tempIssueBody)) fs.unlinkSync(tempIssueBody);
      if (fs.existsSync(tempCommentBody)) fs.unlinkSync(tempCommentBody);
    } catch {
      // Best effort: a leftover temp file is harmless.
    }
  }
}
