// systest/ui-audit/src/reporting/markdown.ts
import fs from 'node:fs';
import path from 'node:path';
import { AuditSummary } from '../types.js';

export function generateMarkdownReport(data: AuditSummary, outputDir: string): string {
  const dateStr = new Date().toISOString().split('T')[0];
  let md = `# UX1 Phase 0 UI Audit Report — ${dateStr}\n\n`;

  md += `**Total Checks Run:** ${data.totalChecks}  \n`;
  md += `**Execution Duration:** ${(data.durationMs / 1000).toFixed(1)}s  \n`;
  md += `**Total Violations:** P0 (🔴 ${data.counts.P0}) | P1 (🟠 ${data.counts.P1}) | P2 (🟡 ${data.counts.P2})\n\n`;

  // 1. Matrix Summary (Page x Viewport)
  md += `## 📊 Matrix Summary (Page x Viewport)\n\n`;
  md += `| Route | Viewport | Total Violations | P0 (Critical/Dead) | P1 (Layout/A11y) | P2 (Polish) |\n`;
  md += `| :--- | :--- | :---: | :---: | :---: | :---: |\n`;

  for (const [route, viewports] of Object.entries(data.matrix)) {
    for (const [vp, counts] of Object.entries(viewports)) {
      md += `| \`${route}\` | \`${vp}\` | **${counts.total}** | ${counts.P0 > 0 ? `🔴 **${counts.P0}**` : '0'} | ${counts.P1 > 0 ? `🟠 ${counts.P1}` : '0'} | ${counts.P2 > 0 ? `🟡 ${counts.P2}` : '0'} |\n`;
    }
  }

  md += `\n---\n\n## 🔍 Detailed Findings (${data.findings.length} Unique Issues)\n\n`;

  if (data.findings.length === 0) {
    md += `✨ No violations found! All checks passed successfully across all viewports.\n`;
  } else {
    for (const f of data.findings) {
      const severityIcon = f.severity === 'P0' ? '🔴 P0' : f.severity === 'P1' ? '🟠 P1' : '🟡 P2';
      const gapTag = f.isBackendSuspect ? ' `[backend-gap]`' : '';
      md += `### [${severityIcon}] \`${f.category}\` on \`${f.route}\` (${f.viewport})${gapTag}\n`;
      md += `- **Persona**: \`${f.persona}\`\n`;
      md += `- **Message**: ${f.message}\n`;
      if (f.selector) md += `- **Selector**: \`${f.selector}\`\n`;
      md += `- **ID/Fingerprint**: \`${f.id}\`\n\n`;
    }
  }

  const targetDir = path.join(outputDir, dateStr);
  fs.mkdirSync(targetDir, { recursive: true });
  const filePath = path.join(targetDir, 'report.md');
  fs.writeFileSync(filePath, md, 'utf-8');

  return filePath;
}
