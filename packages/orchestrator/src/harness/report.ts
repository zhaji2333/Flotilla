import type { AssetInput, EvidenceInput, FindingInput } from '../repositories/worker-repository.js';
import type { MissionSummary } from '@src-agent/contracts';

// ── Harness task report → control-plane persistence ────────
// The SRC-Agent plugin inside the Harness process writes an atomic JSON report
// (findings + internet trail). The worker validates and maps it into the normal
// evidence/findings rows; the Harness process never writes to PostgreSQL.

export interface HarnessReportTraffic {
  id: string;
  kind: 'target' | 'internet';
  method: string;
  url: string;
  statusCode: number;
  requestText: string;
  responseText: string;
  requestSha256: string;
  responseSha256: string;
  requestBytes: number;
  responseBytes: number;
  untrusted: boolean;
}

export interface HarnessReportAsset {
  type: string;
  value: string;
  notes?: string;
}

export interface HarnessReportFinding {
  title: string;
  category: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  artifact?: string;
  status: 'accepted' | 'needs_review';
  curatorReasons: string[];
  confidence?: 'observed' | 'inferred' | 'unverified';
  rootCauseKey?: string;
  claimsAnonymous?: boolean;
  isCredentialLeak?: boolean;
  reportMd: string;
  evidence: HarnessReportTraffic[];
}

export interface HarnessReportFile {
  version: 1;
  missionId: string;
  taskId: string;
  targetUrl: string;
  artifacts: string[];
  findings: HarnessReportFinding[];
  internetTraffic: HarnessReportTraffic[];
  /** Worker-discovered assets (includes plaintext credential values). */
  assets?: HarnessReportAsset[];
  summary?: MissionSummary;
  updatedAt: string;
}

export interface MappedHarnessReport {
  artifacts: string[];
  evidence: EvidenceInput[];
  findings: FindingInput[];
  assets: AssetInput[];
  summary?: MissionSummary;
}

function toEvidence(entry: HarnessReportTraffic): EvidenceInput {
  return {
    trafficRef: entry.id,
    kind: entry.kind,
    method: entry.method,
    url: entry.url,
    requestText: entry.requestText,
    responseText: entry.responseText,
    requestSha256: entry.requestSha256,
    responseSha256: entry.responseSha256,
    requestBytes: entry.requestBytes,
    responseBytes: entry.responseBytes,
    untrusted: entry.untrusted,
  };
}

/** Maps the plugin report onto persistence inputs; throws on malformed reports. */
export function mapHarnessReport(raw: unknown, missionId: string, taskId: string): MappedHarnessReport {
  if (!raw || typeof raw !== 'object') throw new Error('harness report is not an object');
  const report = raw as Partial<HarnessReportFile>;
  if (report.version !== 1) throw new Error(`unsupported harness report version ${String(report.version)}`);
  if (report.missionId !== missionId || report.taskId !== taskId) {
    throw new Error('harness report belongs to a different mission/task');
  }
  const findings = Array.isArray(report.findings) ? report.findings : [];
  const internet = Array.isArray(report.internetTraffic) ? report.internetTraffic : [];
  // Assets feed the P3-B1 blackboard. Only the declared fields are accepted;
  // arbitrary extra keys from the report file never reach PostgreSQL.
  const assets: AssetInput[] = (Array.isArray(report.assets) ? report.assets : [])
    .filter(asset => asset && typeof asset.type === 'string' && typeof asset.value === 'string')
    .map(asset => ({
      type: String(asset.type).trim().slice(0, 100),
      value: String(asset.value).trim().slice(0, 8_000),
      ...(typeof asset.notes === 'string' && asset.notes.trim() ? { notes: asset.notes.trim().slice(0, 1_000) } : {}),
    }))
    .filter(asset => asset.type.length > 0 && asset.value.length > 0);

  const evidence = new Map<string, EvidenceInput>();
  const add = (entry: HarnessReportTraffic): void => {
    if (!entry?.id) return;
    evidence.set(entry.id, toEvidence(entry));
  };
  for (const entry of internet) add(entry);
  for (const finding of findings) {
    for (const entry of finding.evidence ?? []) add(entry);
  }

  const mappedFindings: FindingInput[] = findings.map(finding => ({
    title: finding.title,
    category: finding.category,
    severity: finding.severity,
    status: finding.status,
    artifact: finding.artifact,
    reportMd: finding.reportMd,
    evidenceIds: (finding.evidence ?? []).map(entry => entry.id),
    curatorReasons: finding.curatorReasons ?? [],
    claimsAnonymous: finding.claimsAnonymous === true,
    isCredentialLeak: finding.isCredentialLeak === true,
  }));

  const artifacts = [...new Set((report.artifacts ?? []).filter(Boolean))];
  return { artifacts, evidence: [...evidence.values()], findings: mappedFindings, assets, ...(report.summary ? { summary: report.summary } : {}) };
}
