import { describe, it, expect } from 'vitest';
import { autoReviewFinding, checkEvidence, curate, curateWithEvidence, generateReport, mapToCkSkillsLevel } from '../src/index.js';
import type { ReportFinding } from '@src-agent/contracts';

const validFinding: ReportFinding = {
  title: 'IDOR on user profile',
  category: 'idor',
  severity: 'high',
  assetRefs: ['api.example.com'],
  evidenceRefs: [
    { trafficId: 'tr_1', requestHash: 'req_hash_1', responseHash: 'resp_hash_1' },
    { trafficId: 'tr_2', requestHash: 'req_hash_2', responseHash: 'resp_hash_2' },
  ],
  claimsAnonymous: false,
  isCredentialLeak: false,
};

describe('checkEvidence', () => {
  it('passes valid finding', () => {
    const result = checkEvidence(validFinding);
    expect(result.passed).toBe(true);
    expect(result.failures).toHaveLength(0);
  });

  it('rejects finding with <2 evidence refs', () => {
    const finding = { ...validFinding, evidenceRefs: [validFinding.evidenceRefs[0]] };
    const result = checkEvidence(finding);
    expect(result.passed).toBe(false);
    expect(result.failures[0]).toContain('证据不足');
  });

  it('rejects anonymous claim with auth headers', () => {
    const finding: ReportFinding = {
      ...validFinding,
      claimsAnonymous: true,
      evidenceRefs: [
        { trafficId: 'tr_1', requestHash: 'req_with_authorization', responseHash: 'resp_1' },
        { trafficId: 'tr_2', requestHash: 'req_2', responseHash: 'resp_2' },
      ],
    };
    const result = checkEvidence(finding);
    expect(result.passed).toBe(false);
    expect(result.failures[0]).toContain('匿名闸');
  });

  it('rejects credential leak without false value control', () => {
    const finding: ReportFinding = {
      ...validFinding,
      isCredentialLeak: true,
      evidenceRefs: [validFinding.evidenceRefs[0]], // only 1 evidence
    };
    const result = checkEvidence(finding);
    expect(result.passed).toBe(false);
    expect(result.failures.some(f => f.includes('认钥闸'))).toBe(true);
  });
});

describe('curate', () => {
  it('accepts valid finding', () => {
    const result = curate(validFinding);
    expect(result.action).toBe('accept');
  });

  it('sends invalid finding to review (not silently drop)', () => {
    const finding = { ...validFinding, evidenceRefs: [] };
    const result = curate(finding);
    expect(result.action).toBe('review');
    if (result.action === 'review') {
      expect(result.reasons.length).toBeGreaterThan(0);
    }
  });
});

describe('mapToCkSkillsLevel', () => {
  it('maps critical to 严重', () => expect(mapToCkSkillsLevel('critical')).toBe('严重'));
  it('maps high to 高危', () => expect(mapToCkSkillsLevel('high')).toBe('高危'));
  it('maps medium to 中危', () => expect(mapToCkSkillsLevel('medium')).toBe('中危'));
  it('maps low to 低危', () => expect(mapToCkSkillsLevel('low')).toBe('低危'));
  it('maps info to 低危', () => expect(mapToCkSkillsLevel('info')).toBe('低危'));
});

describe('generateReport', () => {
  it('generates report with correct format', () => {
    const report = generateReport({
      title: 'IDOR on user profile',
      severity: 'high',
      impact: '任意用户数据泄露',
      steps: ['登录用户A', '请求用户B的资料'],
      requests: [
        { request: 'GET /api/users/2 HTTP/1.1', response: 'HTTP/1.1 200 OK\n{"name":"B"}' },
      ],
      fix: '添加越权校验',
      references: ['https://owasp.org/...'],
    });
    expect(report).toContain('【高危】');
    expect(report).toContain('## 影响');
    expect(report).toContain('任意用户数据泄露');
    expect(report).toContain('## 复现步骤');
    expect(report).toContain('## 完整请求 / 响应');
    expect(report).toContain('## 修复建议');
  });
});

describe('P2 six-gate curator', () => {
  const contexts = [
    {
      trafficId: 'tr_1', kind: 'target' as const, method: 'GET', url: 'http://target.test/api/users/1',
      requestText: 'GET /api/users/1 HTTP/1.1\nHost: target.test\nUser-Agent: test\n\n',
      responseText: 'HTTP/1.1 200 OK\n\n{"id":1}',
      requestSha256: 'a'.repeat(64), responseSha256: 'b'.repeat(64),
    },
    {
      trafficId: 'tr_2', kind: 'target' as const, method: 'GET', url: 'http://target.test/api/users/2',
      requestText: 'GET /api/users/2 HTTP/1.1\nHost: target.test\nUser-Agent: test\n\n',
      responseText: 'HTTP/1.1 200 OK\n\n{"id":2}',
      requestSha256: 'c'.repeat(64), responseSha256: 'd'.repeat(64),
    },
  ];
  const accepted: ReportFinding = {
    title: 'IDOR user profile', category: 'idor', severity: 'high', assetRefs: ['FLAG{demo}'],
    evidenceRefs: [
      { trafficId: 'tr_1', requestHash: 'a'.repeat(64), responseHash: 'b'.repeat(64) },
      { trafficId: 'tr_2', requestHash: 'c'.repeat(64), responseHash: 'd'.repeat(64) },
    ],
    claimsAnonymous: false, isCredentialLeak: false,
  };

  it('accepts real target evidence with six gates and marks it observed', () => {
    const verdict = curateWithEvidence(accepted, contexts, { reportMd: '## 完整请求 / 响应' });
    expect(verdict.action).toBe('accept');
    expect(verdict.confidence).toBe('observed');
    expect(verdict.rootCauseKey).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects forged traffic ids and hash mismatches', () => {
    const forged = { ...accepted, evidenceRefs: [{ ...accepted.evidenceRefs[0], trafficId: 'tr_999' }, accepted.evidenceRefs[1]] };
    const verdict = curateWithEvidence(forged, contexts);
    expect(verdict.action).toBe('review');
    expect(verdict.reasons.some(reason => reason.includes('未在任务流量中找到'))).toBe(true);
  });

  it('rejects anonymous claims carrying auth headers', () => {
    const authed = contexts.map((context, index) => ({
      ...context,
      requestText: `${index === 0 ? 'Authorization: Bearer demo-token\n' : ''}${context.requestText}`,
    }));
    const verdict = curateWithEvidence({ ...accepted, claimsAnonymous: true }, authed);
    expect(verdict.action).toBe('review');
    expect(verdict.reasons.some(reason => reason.includes('匿名闸'))).toBe(true);
  });

  it('requires false-value control for credential leaks', () => {
    const twoOnly = { ...accepted, isCredentialLeak: true };
    const verdict = curateWithEvidence(twoOnly, contexts);
    expect(verdict.action).toBe('review');
    expect(verdict.reasons.some(reason => reason.includes('认钥闸'))).toBe(true);
  });

  it('rejects high severity with no observable differential', () => {
    const sameResponses = contexts.map(context => ({ ...context, responseSha256: 'e'.repeat(64) }));
    const verdict = curateWithEvidence({ ...accepted, assetRefs: [] }, sameResponses);
    expect(verdict.action).toBe('review');
    expect(verdict.reasons.some(reason => reason.includes('定级闸'))).toBe(true);
  });

  it('rejects forbidden content such as private keys', () => {
    const verdict = curateWithEvidence(accepted, contexts, {
      reportMd: '-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----',
    });
    expect(verdict.action).toBe('review');
    expect(verdict.reasons.some(reason => reason.includes('禁写闸'))).toBe(true);
  });

  it('rejects evidence packets without an explicit Host header', () => {
    const noHost = contexts.map(context => ({ ...context, requestText: 'GET / HTTP/1.1\n\n' }));
    const verdict = curateWithEvidence(accepted, noHost);
    expect(verdict.action).toBe('review');
    expect(verdict.reasons.some(reason => reason.includes('Host'))).toBe(true);
  });

  it('produces a stable root-cause key for duplicate merging', () => {
    const first = curateWithEvidence(accepted, contexts);
    const second = curateWithEvidence({ ...accepted }, contexts);
    expect(second.rootCauseKey).toBe(first.rootCauseKey);
  });
});


describe('automatic finding review', () => {
  const evidence = [
    {
      trafficId: 'tr_1', kind: 'target' as const, method: 'GET', url: 'http://target.test/api/users/1',
      requestText: 'GET /api/users/1 HTTP/1.1\nHost: target.test\nAuthorization: Bearer a\n\n',
      responseText: 'HTTP/1.1 200 OK\n\n{"id":1}', requestSha256: 'a'.repeat(64), responseSha256: 'b'.repeat(64),
    },
    {
      trafficId: 'tr_2', kind: 'target' as const, method: 'GET', url: 'http://target.test/api/users/2',
      requestText: 'GET /api/users/2 HTTP/1.1\nHost: target.test\nAuthorization: Bearer b\n\n',
      responseText: 'HTTP/1.1 200 OK\n\n{"id":2}', requestSha256: 'c'.repeat(64), responseSha256: 'd'.repeat(64),
    },
  ];
  const finding: ReportFinding = {
    title: 'IDOR user profile', category: 'idor', severity: 'high', assetRefs: ['FLAG{demo}'],
    evidenceRefs: [
      { trafficId: 'tr_1', requestHash: 'a'.repeat(64), responseHash: 'b'.repeat(64) },
      { trafficId: 'tr_2', requestHash: 'c'.repeat(64), responseHash: 'd'.repeat(64) },
    ],
    claimsAnonymous: true,
    isCredentialLeak: false,
  };

  it('repairs an anonymous claim contradicted by auth evidence and accepts', () => {
    const verdict = curateWithEvidence(finding, evidence);
    expect(verdict.action).toBe('review');
    const result = autoReviewFinding({ finding, evidence, reportMd: 'report', verdict });
    expect(result.action).toBe('accept');
    expect(result.finding.claimsAnonymous).toBe(false);
    expect(result.normalized[0]).toContain('匿名');
  });

  it('rejects a finding with missing baseline/proof instead of queueing a human review', () => {
    const broken: ReportFinding = { ...finding, evidenceRefs: [] , claimsAnonymous: false };
    const verdict = curateWithEvidence(broken, []);
    const result = autoReviewFinding({ finding: broken, evidence: [], reportMd: 'report', verdict });
    expect(result.action).toBe('reject');
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it('keeps the manual mode as review for repairable claims', () => {
    const verdict = curateWithEvidence(finding, evidence);
    const result = autoReviewFinding({ finding, evidence, reportMd: 'report', verdict, mode: 'manual' });
    expect(result.action).toBe('review');
  });
});
