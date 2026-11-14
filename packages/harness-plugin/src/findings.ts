import { curateWithEvidence, generateReport, type EvidenceContext } from '@src-agent/curator';
import type { ReportFinding } from '@src-agent/contracts';
import type { TrafficRecord, TrafficStore } from './store.js';

// ── Finding verification ────────────────────────────────────
// A finding is only recorded when it cites at least two distinct traffic ids
// that this task actually recorded. The same curate() gate as the control plane
// runs here so the Harness agent gets immediate, honest feedback.

export type Severity = ReportFinding['severity'];

export interface FindingInput {
  title: string;
  category: string;
  severity: Severity;
  artifact?: string;
  evidence: string[];
  claimsAnonymous?: boolean;
  isCredentialLeak?: boolean;
}

export interface FindingRecord {
  title: string;
  category: string;
  severity: Severity;
  artifact?: string;
  status: 'accepted' | 'needs_review';
  curatorReasons: string[];
  confidence: 'observed' | 'inferred' | 'unverified';
  rootCauseKey: string;
  claimsAnonymous: boolean;
  isCredentialLeak: boolean;
  reportMd: string;
  evidence: TrafficRecord[];
}

export type RecordFindingResult =
  | { status: 'recorded'; finding: FindingRecord }
  | { status: 'rejected'; reason: string };

export function recordFinding(
  store: TrafficStore,
  targetUrl: string,
  input: FindingInput,
): RecordFindingResult {
  const refs = [...new Set(input.evidence.map(ref => ref.trim()).filter(Boolean))];
  if (refs.length < 2) {
    return {
      status: 'rejected',
      reason:
        'evidence 必须引用本任务实际记录过的至少 2 条不同 traffic_id（baseline + proof）。先复现请求，再填 [traffic_id=...]。',
    };
  }
  const evidence: TrafficRecord[] = [];
  for (const ref of refs) {
    const record = store.get(ref);
    if (!record) {
      return {
        status: 'rejected',
        reason: `未知 traffic_id "${ref}"：只能引用本任务中通过 http_request/web_fetch 记录过的流量。`,
      };
    }
    evidence.push(record);
  }
  if (new Set(evidence.map(record => record.id)).size < 2) {
    return { status: 'rejected', reason: 'baseline 与 proof 必须是两条不同的流量记录。' };
  }

  const finding: ReportFinding = {
    title: input.title,
    category: input.category,
    severity: input.severity,
    assetRefs: [targetUrl],
    evidenceRefs: evidence.map(record => ({
      trafficId: record.id,
      requestHash: record.requestSha256,
      responseHash: record.responseSha256,
    })),
    claimsAnonymous: input.claimsAnonymous ?? false,
    isCredentialLeak: input.isCredentialLeak ?? false,
  };
  const reportMd = generateReport({
    title: finding.title,
    severity: finding.severity,
    impact: `${finding.category} confirmed on ${targetUrl}${input.artifact ? ` — artifact: ${input.artifact}` : ''}`,
    steps: evidence.map((record, index) => `Step ${index + 1}: ${record.method} ${record.url}`),
    requests: evidence.map(record => ({ request: record.requestText, response: record.responseText })),
    fix: 'See CkSKILLS rules/40 remediation guidance',
    references: [],
  });
  // Control-plane authority re-runs the same six-gate check before insertion;
  // the plugin runs it here only for immediate, honest feedback.
  const contexts: EvidenceContext[] = evidence.map(record => ({
    trafficId: record.id,
    kind: record.kind,
    method: record.method,
    url: record.url,
    requestText: record.requestText,
    responseText: record.responseText,
    requestSha256: record.requestSha256,
    responseSha256: record.responseSha256,
    untrusted: record.untrusted,
  }));
  const verdict = curateWithEvidence(finding, contexts, { reportMd });

  return {
    status: 'recorded',
    finding: {
      title: finding.title,
      category: finding.category,
      severity: finding.severity,
      artifact: input.artifact,
      status: verdict.action === 'accept' ? 'accepted' : 'needs_review',
      curatorReasons: verdict.action === 'accept' ? [] : verdict.reasons,
      confidence: verdict.confidence,
      rootCauseKey: verdict.rootCauseKey,
      claimsAnonymous: finding.claimsAnonymous,
      isCredentialLeak: finding.isCredentialLeak,
      reportMd,
      evidence,
    },
  };
}
