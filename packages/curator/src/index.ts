import { createHash } from 'node:crypto';
import type { ReportFinding } from '@src-agent/contracts';

// ── P2 Evidence Gate (six mechanical gates) ─────────────────
// The same gate runs inside the Harness plugin (immediate feedback) and in the
// control plane (authoritative re-check before a finding is inserted/merged).
// Every check is deterministic; no model call decides acceptance.

export interface EvidenceContext {
  trafficId: string;
  kind?: 'target' | 'internet';
  method: string;
  url: string;
  requestText: string;
  responseText: string;
  requestSha256: string;
  responseSha256: string;
  untrusted?: boolean;
}

export interface CuratorOptions {
  /** Report text used by the forbidden-content gate. */
  reportMd?: string;
  /** Maximum accepted report length (bytes) — larger reports are suspicious. */
  maxReportBytes?: number;
}

export interface EvidenceCheckResult {
  passed: boolean;
  failures: string[];
}

export type FindingConfidence = 'observed' | 'inferred' | 'unverified';

export interface CuratedFinding {
  action: 'accept' | 'review';
  finding: ReportFinding;
  reasons: string[];
  confidence: FindingConfidence;
  rootCauseKey: string;
}

// ── helpers ─────────────────────────────────────────────────

function headerValue(requestText: string, name: string): string | null {
  const match = requestText.match(new RegExp(`^${name}\\s*:\\s*(.+)$`, 'im'));
  return match?.[1]?.trim() ?? null;
}

function authHeaders(requestText: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ['Authorization', 'Cookie', 'X-API-Key', 'X-Auth-Token']) {
    const value = headerValue(requestText, name);
    if (value) out[name.toLowerCase()] = value;
  }
  return out;
}

function hasHostHeader(requestText: string): boolean {
  return /^Host\s*:/im.test(requestText);
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizedTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\d{2,}/g, '#')
    .replace(/[^\p{L}\p{N}#]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

/** sha256 fingerprint used for automatic duplicate merging per mission. */
export function rootCauseKey(finding: ReportFinding, evidence: EvidenceContext[] = []): string {
  const primary = evidence[0];
  let path = '';
  let host = '';
  if (primary) {
    try {
      const url = new URL(primary.url);
      host = url.host;
      path = url.pathname.replace(/\d+/g, '#');
    } catch {
      path = primary.url;
    }
  } else if (finding.assetRefs[0]) {
    try {
      const url = new URL(finding.assetRefs[0]);
      host = url.host;
      path = url.pathname.replace(/\d+/g, '#');
    } catch {
      host = finding.assetRefs[0];
    }
  }
  return sha256Hex(`${finding.category.toLowerCase()}|${normalizedTitle(finding.title)}|${host}${path}`);
}

/** Flags suspicious content that must never enter an accepted report. */
const FORBIDDEN_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, label: '私钥正文' },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/, label: 'AWS Access Key' },
  { pattern: /\b\d{3}-\d{2}-\d{4}\b/, label: '美国社会安全号' },
  { pattern: /\b(?:\d[ -]?){13,16}\b/, label: '银行卡号' },
  { pattern: /(?:^|\s)rm\s+-rf\s+\//im, label: '破坏性命令' },
  { pattern: /drop\s+(?:table|database)\s+/im, label: '破坏性 SQL' },
];
const DESTRUCTIVE_TITLE = /(dos|ddos|拒绝服务|删除数据|破坏|停机)/i;

function checkBaselineProof(finding: ReportFinding, evidence: EvidenceContext[]): string[] {
  const failures: string[] = [];
  const refs = finding.evidenceRefs;
  if (refs.length < 2) {
    failures.push(`证据不足：需要至少 2 条 evidence_refs（baseline + proof），当前 ${refs.length} 条`);
    return failures;
  }
  if (new Set(refs.map(ref => ref.trafficId)).size < 2) {
    failures.push('baseline 与 proof 必须是两条不同的流量记录');
  }
  for (const ref of refs) {
    if (!ref.requestHash || !ref.responseHash) failures.push(`证据 ${ref.trafficId} 缺少哈希引用`);
  }
  if (evidence.length === 0) return failures;
  const byId = new Map(evidence.map(item => [item.trafficId, item]));
  const resolved: EvidenceContext[] = [];
  for (const ref of refs) {
    const item = byId.get(ref.trafficId);
    if (!item) {
      failures.push(`证据 ${ref.trafficId} 未在任务流量中找到（禁止伪造 traffic 引用）`);
      continue;
    }
    if (item.requestSha256 !== ref.requestHash || item.responseSha256 !== ref.responseHash) {
      failures.push(`证据 ${ref.trafficId} 的哈希与真实流量不一致`);
    }
    resolved.push(item);
  }
  if (resolved.length >= 2) {
    const requestSignatures = new Set(resolved.map(item => `${item.method} ${item.url} ${item.requestSha256}`));
    if (requestSignatures.size < 2) failures.push('baseline 与 proof 请求完全相同，无法证明差异');
  }
  return failures;
}

function checkAnonymousGate(finding: ReportFinding, evidence: EvidenceContext[]): string[] {
  if (!finding.claimsAnonymous) return [];
  const failures: string[] = [];
  for (const item of evidence) {
    if (Object.keys(authHeaders(item.requestText)).length > 0) {
      failures.push(`匿名闸：声称匿名可复现，但证据 ${item.trafficId} 包含认证凭据`);
    }
  }
  // Fallback for older callers that only pass hashes.
  if (evidence.length === 0) {
    const hasAuthEvidence = finding.evidenceRefs.some(
      ref => ref.requestHash.includes('authorization') || ref.requestHash.includes('cookie'),
    );
    if (hasAuthEvidence) failures.push('匿名闸：声称匿名可复现但证据中包含认证凭据（Authorization header / Cookie）');
  }
  return failures;
}

function checkCredentialGate(finding: ReportFinding, evidence: EvidenceContext[]): string[] {
  if (!finding.isCredentialLeak) return [];
  const failures: string[] = [];
  if (finding.evidenceRefs.length < 3) {
    failures.push('认钥闸：凭据泄露需要 ≥3 条证据（真实身份 + false value 对照 + proof），当前不足');
  }
  const credentialValues = new Set<string>();
  for (const item of evidence) {
    for (const value of Object.values(authHeaders(item.requestText))) credentialValues.add(value);
  }
  if (evidence.length > 0 && credentialValues.size < 2) {
    failures.push('认钥闸：缺少 false value 对照组（需要至少两个不同凭据值的请求）');
  }
  const responseHashes = new Set(evidence.filter(item => item.responseSha256).map(item => item.responseSha256));
  if (evidence.length >= 2 && responseHashes.size < 2) {
    failures.push('认钥闸：有效凭据与 false value 的响应无法区分');
  }
  return theFailures(failures);
}

function theFailures(failures: string[]): string[] { return failures; }

function checkTieringGate(finding: ReportFinding, evidence: EvidenceContext[]): string[] {
  if (finding.severity !== 'critical' && finding.severity !== 'high') return [];
  const failures: string[] = [];
  if (evidence.length >= 2) {
    const responseHashes = new Set(evidence.map(item => item.responseSha256).filter(Boolean));
    const hasArtifact = finding.assetRefs.some(ref => /FLAG\{|flag\{/.test(ref));
    if (responseHashes.size < 2 && !hasArtifact) {
      failures.push('定级闸：高危/严重 finding 需要可观察的影响差异（baseline/proof 响应不同）或产物证明');
    }
  }
  return failures;
}

function checkForbiddenContent(finding: ReportFinding, options: CuratorOptions): string[] {
  const failures: string[] = [];
  const text = `${finding.title}\n${options.reportMd ?? ''}`;
  for (const item of FORBIDDEN_PATTERNS) {
    if (item.pattern.test(text)) failures.push(`禁写闸：报告中包含${item.label}`);
  }
  if (DESTRUCTIVE_TITLE.test(finding.title)) {
    failures.push('禁写闸：自动报告不得包含破坏性测试描述（DoS/删除数据等）');
  }
  if (options.maxReportBytes && Buffer.byteLength(text, 'utf8') > options.maxReportBytes) {
    failures.push(`禁写闸：报告长度超过上限 ${options.maxReportBytes} 字节`);
  }
  return failures;
}

function checkReproducibilityGate(finding: ReportFinding, evidence: EvidenceContext[]): string[] {
  const failures: string[] = [];
  if (evidence.length === 0) return failures;
  const byId = new Map(evidence.map(item => [item.trafficId, item]));
  for (const ref of finding.evidenceRefs) {
    const item = byId.get(ref.trafficId);
    if (!item) continue; // already reported by baseline gate
    if (!item.requestText.trim() || !item.responseText.trim()) {
      failures.push(`复现包闸：证据 ${ref.trafficId} 缺少请求/响应正文`);
    }
    if (item.requestSha256.length !== 64 || item.responseSha256.length !== 64) {
      failures.push(`复现包闸：证据 ${ref.trafficId} 缺少完整 SHA-256`);
    }
    if (item.kind !== 'internet' && !hasHostHeader(item.requestText)) {
      failures.push(`复现包闸：证据 ${ref.trafficId} 的原始请求包缺少 Host 头`);
    }
  }
  return failures;
}

/** Runs all six gates. Without evidence context, only hash-level gates run. */
export function checkEvidence(
  finding: ReportFinding,
  evidence: EvidenceContext[] = [],
  options: CuratorOptions = {},
): EvidenceCheckResult {
  const failures = [
    ...checkBaselineProof(finding, evidence),
    ...checkAnonymousGate(finding, evidence),
    ...checkCredentialGate(finding, evidence),
    ...checkTieringGate(finding, evidence),
    ...checkForbiddenContent(finding, options),
    ...checkReproducibilityGate(finding, evidence),
  ];
  return { passed: failures.length === 0, failures };
}

export function determineConfidence(
  finding: ReportFinding,
  evidence: EvidenceContext[],
  reasons: string[],
): FindingConfidence {
  if (reasons.length > 0) return 'unverified';
  const hasArtifact = finding.assetRefs.some(ref => /FLAG\{|flag\{/.test(ref)) || evidence.some(item => /FLAG\{/i.test(item.responseText));
  const targetEvidence = evidence.filter(item => item.kind !== 'internet');
  const responseHashes = new Set(targetEvidence.map(item => item.responseSha256));
  if (hasArtifact || (targetEvidence.length >= 2 && responseHashes.size >= 2)) return 'observed';
  return 'inferred';
}

export function curateWithEvidence(
  finding: ReportFinding,
  evidence: EvidenceContext[] = [],
  options: CuratorOptions = {},
): CuratedFinding {
  const check = checkEvidence(finding, evidence, options);
  return {
    action: check.passed ? 'accept' : 'review',
    finding,
    reasons: check.failures,
    confidence: determineConfidence(finding, evidence, check.failures),
    rootCauseKey: rootCauseKey(finding, evidence),
  };
}

// ── Backwards-compatible wrapper (P0 callers/tests) ────────
export function curate(finding: ReportFinding): CuratorVerdictWithEvidence {
  const result = curateWithEvidence(finding, []);
  return result.action === 'accept'
    ? { action: 'accept', finding, reasons: [], confidence: result.confidence, rootCauseKey: result.rootCauseKey }
    : { action: 'review', finding, reasons: result.reasons, confidence: result.confidence, rootCauseKey: result.rootCauseKey };
}

export interface CuratorVerdictWithEvidence extends CuratedFinding {}

// ── Severity mapping ────────────────────────────────────────

export function mapToCkSkillsLevel(severity: ReportFinding['severity']): string {
  switch (severity) {
    case 'critical': return '严重';
    case 'high': return '高危';
    case 'medium': return '中危';
    case 'low': return '低危';
    case 'info': return '低危';
    default: return '低危';
  }
}

// ── Report generation ──────────────────────────────────────

export interface ReportInput {
  title: string;
  severity: ReportFinding['severity'];
  impact: string;
  steps: string[];
  requests: { request: string; response: string }[];
  fix: string;
  references: string[];
}

export function generateReport(input: ReportInput): string {
  const level = mapToCkSkillsLevel(input.severity);
  const title = `【${level}】${input.title}`;

  let report = `# ${title}\n\n`;
  report += `## 影响\n${input.impact}\n\n`;
  report += `## 复现步骤\n`;
  input.steps.forEach((step, i) => {
    report += `${i + 1}. ${step}\n`;
  });
  report += '\n';
  report += `## 完整请求 / 响应\n`;
  input.requests.forEach((req, i) => {
    report += `### 请求 ${i + 1}\n\`\`\`http\n${req.request}\n\`\`\`\n`;
    report += `### 响应 ${i + 1}\n\`\`\`http\n${req.response}\n\`\`\`\n`;
  });
  report += '\n';
  report += `## 修复建议\n${input.fix}\n\n`;
  if (input.references.length > 0) {
    report += `## 参考\n`;
    input.references.forEach(ref => {
      report += `- ${ref}\n`;
    });
    report += '\n';
  }
  return report;
}

export * from './auto-review.js';
