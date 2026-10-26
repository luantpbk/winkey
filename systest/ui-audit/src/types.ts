// systest/ui-audit/src/types.ts

export type PersonaRole = 'anon' | 'member' | 'creator' | 'admin';

export type InputMode = 'touch' | 'mouse' | 'keyboard';

export type Severity = 'P0' | 'P1' | 'P2';

export type ProbeCategory =
  | 'dead-control'
  | 'click-failed'
  | 'overflow-x'
  | 'touch-target'
  | 'axe-a11y'
  | 'text-clip-overlap'
  | 'tv-focus'
  | 'web-vitals';

export interface ViewportSpec {
  id: string;
  width: number;
  height: number;
  dpr: number;
  inputMode: InputMode;
}

export interface AuditFinding {
  id: string; // Hash identifier: sha256(category + route + selector)
  severity: Severity;
  category: ProbeCategory;
  persona: PersonaRole;
  viewport: string;
  route: string;
  selector: string;
  message: string;
  isBackendSuspect?: boolean;
  screenshotPath?: string;
  evidence?: Record<string, unknown>;
}

export interface AuditSummary {
  totalChecks: number;
  findings: AuditFinding[];
  counts: Record<Severity, number>;
  matrix: Record<string, Record<string, { total: number; P0: number; P1: number; P2: number }>>;
  durationMs: number;
}

export interface SeedContext {
  categorySlug: string;
  tagSlug: string;
  videoId: string;
  channelHandle: string;
  playlistId: string;
}
