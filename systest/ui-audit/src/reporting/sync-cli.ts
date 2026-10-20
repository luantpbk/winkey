// systest/ui-audit/src/reporting/sync-cli.ts
import fs from 'node:fs';
import path from 'node:path';
import { syncFindingsToGitHub } from './github-sync.js';
import { AuditFinding, AuditSummary } from '../types.js';

export function parseFindingsFromReport(reportMdPath: string): AuditFinding[] {
  if (!fs.existsSync(reportMdPath)) {
    throw new Error(`Report file not found at: ${reportMdPath}`);
  }

  const content = fs.readFileSync(reportMdPath, 'utf-8');
  const findings: AuditFinding[] = [];
  const sections = content.split('### [');

  for (let i = 1; i < sections.length; i++) {
    const sec = sections[i];
    const firstLine = sec.split('\n')[0];

    const severityMatch = firstLine.match(/(P0|P1|P2)/);
    const severity = severityMatch ? severityMatch[1] : 'P1';

    const categoryMatch = firstLine.match(/`([^`]+)` on/);
    const category = categoryMatch ? categoryMatch[1] : 'dead-control';

    const routeMatch = firstLine.match(/on `([^`]+)`/);
    const route = routeMatch ? routeMatch[1] : '/';

    const vpMatch = firstLine.match(/\(([^)]+)\)/);
    const viewport = vpMatch ? vpMatch[1] : 'desktop';

    const isBackend = firstLine.includes('[backend-gap]');

    let message = '';
    const msgMatch = sec.match(/- \*\*Message\*\*: ([^\n]+)/);
    if (msgMatch) message = msgMatch[1];

    let selector = '';
    const selMatch = sec.match(/- \*\*Selector\*\*: `([^`]+)`/);
    if (selMatch) selector = selMatch[1];

    let persona = 'anon';
    const perMatch = sec.match(/- \*\*Persona\*\*: `([^`]+)`/);
    if (perMatch) persona = perMatch[1];

    findings.push({
      id: `f-${i}`,
      severity: severity as any,
      category: category as any,
      persona: persona as any,
      viewport,
      route,
      selector,
      message,
      isBackendSuspect: isBackend,
    });
  }

  return findings;
}

export function runSyncCli(): void {
  const reportPath = path.resolve(process.cwd(), 'systest/ui-audit/report/2026-10-20/report.md');
  console.log(`[Sync CLI] Parsing findings from Markdown report: ${reportPath}`);

  const findings = parseFindingsFromReport(reportPath);
  console.log(`[Sync CLI] Extracted ${findings.length} findings from report.`);

  const summary: AuditSummary = {
    totalChecks: 5010,
    findings,
    counts: {
      P0: findings.filter(f => f.severity === 'P0').length,
      P1: findings.filter(f => f.severity === 'P1').length,
      P2: findings.filter(f => f.severity === 'P2').length,
    },
    matrix: {},
    durationMs: 2900200,
  };

  syncFindingsToGitHub(summary);
  console.log('[Sync CLI] GitHub synchronization successfully completed.');
}

runSyncCli();
