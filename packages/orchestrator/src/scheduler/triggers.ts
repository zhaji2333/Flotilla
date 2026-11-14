// ── Trigger routing policy (P1-γ) ───────────────────────────
// Signals from workers/proxy/watchdog are routed either to the Planner (needs
// judgement: scope changes, risk, direction) or directly to the running worker
// as an informational hint. Direct hints never expand authorization; they only
// carry a finding/asset/observation that is already inside the grant scope.

export type TriggerSource = 'worker_report' | 'finding' | 'asset' | 'watchdog' | 'manual';
export type TriggerRoute = 'planner' | 'direct';
export type TriggerKind = 'report' | 'finding' | 'asset' | 'no_progress' | 'duplicate_url' | 'direction_drift' | 'manual';

const PLANNER_SOURCES = new Set<TriggerSource>(['worker_report', 'manual']);
const DIRECT_SOURCES = new Set<TriggerSource>(['finding', 'asset', 'watchdog']);

export function routeTrigger(source: TriggerSource): TriggerRoute {
  if (PLANNER_SOURCES.has(source)) return 'planner';
  if (DIRECT_SOURCES.has(source)) return 'direct';
  return 'planner';
}

export function buildDirectFindingHint(input: {
  sourceTaskId: string;
  findings: Array<{ title: string; artifact?: string | null }>;
}): string {
  const titles = input.findings.slice(0, 3).map(finding =>
    finding.artifact ? `${finding.title} (artifact ${finding.artifact})` : finding.title,
  );
  return `[trigger:finding] Another authorized task (${input.sourceTaskId.slice(0, 8)}) reported: ${titles.join('; ')}. ` +
    'Treat this as a lead inside the current grant scope; verify it yourself before reporting and never expand scope.';
}

export interface WatchdogThresholds {
  duplicateUrlCount: number;
  noProgressMinutes: number;
}

export const DEFAULT_WATCHDOG_THRESHOLDS: WatchdogThresholds = {
  duplicateUrlCount: 10,
  noProgressMinutes: 15,
};

export function shouldWarnDuplicateUrl(count: number, thresholds: WatchdogThresholds): boolean {
  return count >= thresholds.duplicateUrlCount;
}


export function shouldWarnNoProgress(
  runningMinutes: number,
  hasRecentFinding: boolean,
  thresholds: WatchdogThresholds,
  hasRecentTrace = false,
): boolean {
  // A long recon task produces trace rows (tool calls, commands, status) long
  // before its first finding. Treat that activity as progress so the watchdog
  // only flags genuinely silent tasks, not healthy-but-slow ones.
  return !hasRecentFinding && !hasRecentTrace && runningMinutes >= thresholds.noProgressMinutes;
}

export function watchdogHint(rule: TriggerKind, detail: string): string {
  const prefix = `[trigger:${rule}] `;
  switch (rule) {
    case 'duplicate_url':
      return `${prefix}${detail} Stop repeating the same request; change parameter/method or move to a different attack surface. Do not bypass platform blocks.`;
    case 'no_progress':
      return `${prefix}${detail} If this direction is exhausted, pivot to another surface or report a dead end explicitly.`;
    case 'direction_drift':
      return `${prefix}${detail} Re-check the mission objective and current scope; abandon repetitive or off-target work, or report a dead end explicitly.`;
    default:
      return `${prefix}${detail}`;
  }
}
