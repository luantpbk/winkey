// systest/ui-audit/src/index.ts
import { chromium } from 'playwright';
import path from 'node:path';
import { VIEWPORTS } from './config/viewports.js';
import { PERSONA_ROUTES } from './config/personas.js';
import { loadSeedManifest, resolveRoute } from './core/seed-resolver.js';
import { createPersonaContext } from './core/auth.js';
import { collectVitals, VITALS_INIT_SCRIPT } from './core/vitals.js';
import { runLayoutProbes } from './probes/layout.probe.js';
import { runDeadControlProbes } from './probes/dead-control.probe.js';
import { runTvNavProbes } from './probes/tv-nav.probe.js';
import { runA11yProbes } from './probes/a11y.probe.js';
import { aggregateFindings } from './reporting/aggregator.js';
import { generateMarkdownReport } from './reporting/markdown.js';
import { syncFindingsToGitHub } from './reporting/github-sync.js';
import { AuditFinding, PersonaRole } from './types.js';

export async function runUiAudit(): Promise<{ p0Count: number; reportPath: string }> {
  const startTime = Date.now();
  const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:8080';
  const syncGh = process.argv.includes('--sync-gh') || process.env.SYNC_GH === 'true';
  const outputDir = path.resolve(process.cwd(), 'systest/ui-audit/report');

  console.log(`[UX1 Audit] Starting automated UI audit on 8 viewports against ${baseUrl}...`);

  const seed = loadSeedManifest();
  const browser = await chromium.launch({
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
  });

  const rawFindings: AuditFinding[] = [];
  const personas = Object.keys(PERSONA_ROUTES) as PersonaRole[];

  for (const persona of personas) {
    const routeTemplates = PERSONA_ROUTES[persona];
    const resolvedRoutes = routeTemplates.map(r => resolveRoute(r, seed));

    console.log(`\n--- Auditing Persona: [${persona}] (${resolvedRoutes.length} routes) ---`);

    for (const route of resolvedRoutes) {
      const targetUrl = `${baseUrl}${route}`;
      console.log(`  Route: ${route}`);

      // Pass 1: Passive Matrix across all 8 viewports
      for (const vp of VIEWPORTS) {
        let context;
        try {
          context = await createPersonaContext(browser, persona, baseUrl, vp);
          await context.addInitScript(VITALS_INIT_SCRIPT);
          const page = await context.newPage();

          await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
          await page.waitForTimeout(500);

          // 1. Layout probe
          const layoutIssues = await runLayoutProbes(page, vp, persona, route);
          rawFindings.push(...layoutIssues);

          // 2. A11y probe (run on representative viewports: mobile-s, desktop, tv-1080)
          if (vp.id === 'mobile-s' || vp.id === 'desktop' || vp.id === 'tv-1080') {
            const a11yIssues = await runA11yProbes(page, vp, persona, route);
            rawFindings.push(...a11yIssues);
          }

          // 3. TV navigation probe (run on tv viewports)
          if (vp.inputMode === 'keyboard') {
            const tvIssues = await runTvNavProbes(page, vp, persona, route);
            rawFindings.push(...tvIssues);
          }

          // 4. Vitals probe
          const vitals = await collectVitals(page);
          if (vitals.cls > 0.1) {
            rawFindings.push({
              id: '',
              severity: 'P1',
              category: 'web-vitals',
              persona,
              viewport: vp.id,
              route,
              selector: 'window',
              message: `High Cumulative Layout Shift (CLS): ${vitals.cls.toFixed(3)} exceeds 0.1 threshold.`,
            });
          }

          await page.close();
        } catch (err: any) {
          // Log and continue gracefully
        } finally {
          if (context) await context.close();
        }
      }

      // Pass 2: Active Mutation Probe (Dead Controls on Desktop & Mobile-s)
      for (const activeVp of VIEWPORTS.filter(v => v.id === 'desktop' || v.id === 'mobile-s')) {
        let activeContext;
        try {
          activeContext = await createPersonaContext(browser, persona, baseUrl, activeVp);
          const activePage = await activeContext.newPage();
          await activePage.goto(targetUrl, { waitUntil: 'networkidle', timeout: 15000 }).catch(() => {});

          const deadIssues = await runDeadControlProbes(activePage, activeVp, persona, route);
          rawFindings.push(...deadIssues);

          await activePage.close();
        } catch {
          // Ignore
        } finally {
          if (activeContext) await activeContext.close();
        }
      }
    }
  }

  await browser.close();

  const durationMs = Date.now() - startTime;
  const summary = aggregateFindings(rawFindings, durationMs);
  const reportPath = generateMarkdownReport(summary, outputDir);

  console.log(`\n=======================================================`);
  console.log(`[UX1 Audit] Audit Complete in ${(durationMs / 1000).toFixed(1)}s!`);
  console.log(`[UX1 Audit] Total Unique Issues: ${summary.findings.length}`);
  console.log(`[UX1 Audit] P0 (Critical): ${summary.counts.P0}`);
  console.log(`[UX1 Audit] P1 (Serious):  ${summary.counts.P1}`);
  console.log(`[UX1 Audit] P2 (Polish):   ${summary.counts.P2}`);
  console.log(`[UX1 Audit] Report written to: ${reportPath}`);
  console.log(`=======================================================\n`);

  if (syncGh) {
    syncFindingsToGitHub(summary);
  }

  return { p0Count: summary.counts.P0, reportPath };
}

// Direct execution from CLI
const isMain = process.argv[1] && process.argv[1].endsWith('index.ts');
if (isMain || process.argv.includes('--run')) {
  runUiAudit()
    .then(({ p0Count }) => {
      if (p0Count > 0) {
        console.error(`[UX1 Audit] Gate failed: ${p0Count} P0 issues detected.`);
        process.exit(1);
      } else {
        console.log(`[UX1 Audit] Gate passed: 0 P0 issues detected.`);
        process.exit(0);
      }
    })
    .catch((err) => {
      console.error('[UX1 Audit] Unexpected fatal error:', err);
      process.exit(1);
    });
}
