import type { ReportFinding } from '@src-agent/contracts';
import { curateWithEvidence, type CuratedFinding, type EvidenceContext, type FindingConfidence } from './index.js';

// ── Automatic finding review ────────────────────────────────
// The six deterministic gates stay authoritative. This policy only handles
// the post-gate queue: a finding that failed a *repairable* claim can be
// normalized and re-checked; a finding that failed a hard evidence gate is
// rejected instead of waiting for a human. No model is allowed to override a
// failing evidence hash or a missing baseline/proof.

export type AutoReviewMode = 'auto' | 'manual';

export interface AutoReviewInput {
  finding: ReportFinding;
  evidence: EvidenceContext[];
  reportMd: string;
  verdict: CuratedFinding;
  maxReportBytes?: number;
  mode?: AutoReviewMode;
}

export interface AutoReviewResult {
  action: 'accept' | 'reject' | 'review';
  finding: ReportFinding;
  reasons: string[];
  confidence: FindingConfidence;
  rootCauseKey: string;
  normalized: string[];
}

const HARD_REASON = /^(?:证据不足|baseline|证据 .*未在|复现包|禁写闸)/;

/**
 * Repairs only claims that are contradicted by the persisted evidence:
 * - `claimsAnonymous` with auth headers: the finding is still useful as an
 *   authenticated finding, not an anonymous one;
 * - credential-leak claims with insufficient identity evidence: downgrade to
 *   a normal finding instead of accepting an unproven credential claim;
 * - high/critical without observable impact: downgrade to medium so the
 *   tiering gate is honest, rather than deleting an otherwise valid finding.
 */
export function autoReviewFinding(input: AutoReviewInput): AutoReviewResult {
  const original = input.verdict;
  if (original.action === 'accept') {
    return { action: 'accept', finding: input.finding, reasons: [], confidence: original.confidence, rootCauseKey: original.rootCauseKey, normalized: [] };
  }
  if ((input.mode ?? 'auto') === 'manual') {
    return { action: 'review', finding: input.finding, reasons: original.reasons, confidence: 'unverified', rootCauseKey: original.rootCauseKey, normalized: [] };
  }
  const candidate: ReportFinding = { ...input.finding };
  const normalized: string[] = [];
  const reasons = original.reasons;
  if (candidate.claimsAnonymous && reasons.some(reason => reason.startsWith('匿名闸'))) {
    candidate.claimsAnonymous = false;
    normalized.push('清除与认证头矛盾的匿名声明');
  }
  if (candidate.isCredentialLeak && reasons.some(reason => reason.startsWith('认钥闸'))) {
    candidate.isCredentialLeak = false;
    normalized.push('降级为普通 finding（凭据泄露证据不足）');
  }
  if ((candidate.severity === 'critical' || candidate.severity === 'high') && reasons.some(reason => reason.startsWith('定级闸'))) {
    candidate.severity = 'medium';
    normalized.push('降级为 medium（缺少可观察影响差异）');
  }
  const recheck = curateWithEvidence(candidate, input.evidence, { reportMd: input.reportMd, maxReportBytes: input.maxReportBytes });
  if (recheck.action === 'accept') {
    return { action: 'accept', finding: candidate, reasons: [], confidence: recheck.confidence, rootCauseKey: recheck.rootCauseKey, normalized };
  }
  const hard = recheck.reasons.some(reason => HARD_REASON.test(reason));
  if (hard) {
    return { action: 'reject', finding: candidate, reasons: recheck.reasons, confidence: 'unverified', rootCauseKey: recheck.rootCauseKey, normalized };
  }
  if ((input.mode ?? 'auto') === 'auto') {
    return { action: 'reject', finding: candidate, reasons: recheck.reasons, confidence: 'unverified', rootCauseKey: recheck.rootCauseKey, normalized };
  }
  return { action: 'review', finding: candidate, reasons: recheck.reasons, confidence: 'unverified', rootCauseKey: recheck.rootCauseKey, normalized };
}
