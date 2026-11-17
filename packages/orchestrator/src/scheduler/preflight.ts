import { PreflightCheckSchema, type MissionPhase, type PreflightCheck } from '@src-agent/contracts';

// ── Preflight gate (v1.0.2, ADR-0054) ──────────────────────
// Runs immediately before an agent may send target traffic: the mission must
// still be allowed to act, the deadline must not have passed, the grant must
// still exist and no unapproved destructive action may be pending.

export interface PreflightInput {
  phase: MissionPhase | string | null | undefined;
  deadlineAt: Date | null;
  now: Date;
  scopePresent: boolean;
  pendingDestructiveApproval?: boolean;
  targetVersion?: string | null;
  credentialVersion?: string | null;
}

export function evaluatePreflight(input: PreflightInput): PreflightCheck {
  const phase = (input.phase ?? 'active') as MissionPhase;
  const phaseOk = phase !== 'closed';
  const deadlineOk = !input.deadlineAt || input.now.getTime() <= input.deadlineAt.getTime();
  const reasonParts: string[] = [];
  if (!phaseOk) reasonParts.push('mission is closed');
  if (!deadlineOk) reasonParts.push('mission deadline passed');
  if (!input.scopePresent) reasonParts.push('grant scope missing or revoked');
  if (input.pendingDestructiveApproval) reasonParts.push('destructive action awaiting approval');

  let decision: PreflightCheck['decision'] = 'proceed';
  if (!phaseOk || !deadlineOk) decision = 'blocked';
  else if (!input.scopePresent) decision = 'out_of_scope';
  else if (input.pendingDestructiveApproval) decision = 'blocked';

  return PreflightCheckSchema.parse({
    phaseOk,
    deadlineOk,
    scopeOk: input.scopePresent,
    authOk: true,
    targetVersion: input.targetVersion ?? null,
    credentialVersion: input.credentialVersion ?? null,
    pendingDestructiveApproval: input.pendingDestructiveApproval ?? false,
    decision,
    reason: reasonParts.length > 0 ? reasonParts.join('; ') : null,
    evidenceRef: null,
  });
}

/** Task disposition used when preflight stops a task before it starts. */
export function preflightDisposition(check: PreflightCheck): 'out_of_scope' | 'timeout' | 'blocked' {
  if (check.decision === 'out_of_scope') return 'out_of_scope';
  if (check.reason?.includes('deadline')) return 'timeout';
  if (check.reason?.includes('closed') || check.reason?.includes('closed')) return 'timeout';
  return 'blocked';
}
