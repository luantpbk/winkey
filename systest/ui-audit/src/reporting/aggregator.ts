// systest/ui-audit/src/reporting/aggregator.ts
import crypto from 'node:crypto';
import { AuditFinding, AuditSummary, Severity } from '../types.js';

export function computeFindingHash(f: AuditFinding): string {
  const raw = `${f.category}:${f.route}:${f.selector}`;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12);
}

export function aggregateFindings(rawFindings: AuditFinding[], durationMs: number): AuditSummary {
  const uniqueMap = new Map<string, AuditFinding>();
  const counts: Record<Severity, number> = { P0: 0, P1: 0, P2: 0 };
  const matrix: Record<string, Record<string, { total: number; P0: number; P1: number; P2: number }>> = {};

  for (const f of rawFindings) {
    const id = computeFindingHash(f);
    f.id = id;

    // Detect known or suspected backend gap
    if (
      f.message.toLowerCase().includes('501') ||
      f.message.toLowerCase().includes('not implemented') ||
      f.message.toLowerCase().includes('#history') ||
      f.message.toLowerCase().includes('lịch sử') ||
      f.message.toLowerCase().includes('thích') ||
      f.isBackendSuspect
    ) {
      f.isBackendSuspect = true;
    }

    if (!uniqueMap.has(id)) {
      uniqueMap.set(id, f);
      counts[f.severity] = (counts[f.severity] || 0) + 1;
    }

    // Build Page x Viewport matrix
    if (!matrix[f.route]) {
      matrix[f.route] = {};
    }
    if (!matrix[f.route][f.viewport]) {
      matrix[f.route][f.viewport] = { total: 0, P0: 0, P1: 0, P2: 0 };
    }

    const cell = matrix[f.route][f.viewport];
    cell.total += 1;
    cell[f.severity] += 1;
  }

  return {
    totalChecks: rawFindings.length,
    findings: Array.from(uniqueMap.values()),
    counts,
    matrix,
    durationMs,
  };
}
