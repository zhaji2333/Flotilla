import { describe, it, expect } from 'vitest';
import {
  GrantSchema, TaskSpecSchema, WorkerReportSchema,
  SystemBlockSchema, CommandSchema, EvidenceRefSchema,
  MissionDeadlineSchema, TaskDispositionSchema, TaskHandoffSchema,
  PreflightCheckSchema, RetryPolicySchema, CoverageRequirementSchema,
  computeRetryDelayMs, deriveTaskDisposition, buildTaskHandoffDigest, deriveCoverageRequirements,
} from '../src/index.js';

describe('GrantSchema', () => {
  it('accepts a valid grant', () => {
    const result = GrantSchema.safeParse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      version: 1,
      scope: {
        domainSuffixes: ['example.com'],
        ips: ['10.0.0.0/8'],
        urlPrefixes: [],
        exclude: ['*.admin.example.com'],
      },
      constraints: {
        readOnly: true,
        excludedPaths: ['/admin/*'],
        allowedCategories: ['http'],
        maxBudget: 30,
      },
      issuedBy: 'user',
      createdAt: '2026-01-01T00:00:00Z',
    });
    expect(result.success).toBe(true);
  });

  it('rejects grant with extra fields', () => {
    const result = GrantSchema.safeParse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      version: 1,
      scope: { domainSuffixes: [], ips: [], urlPrefixes: [], exclude: [] },
      constraints: { readOnly: false, excludedPaths: [], allowedCategories: ['http'], maxBudget: 30 },
      issuedBy: 'user',
      createdAt: '2026-01-01T00:00:00Z',
      extra: 'should_fail',
    });
    expect(result.success).toBe(false);
  });
});

describe('TaskSpecSchema', () => {
  it('accepts valid task', () => {
    const result = TaskSpecSchema.safeParse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      missionId: '660e8400-e29b-41d4-a716-446655440000',
      type: 'explore',
      intentNodeId: null,
      dependsOn: [],
      grantId: '770e8400-e29b-41d4-a716-446655440000',
      grantVersion: 1,
      budget: { maxSteps: 30, maxWallClockMs: 300000 },
      payload: {},
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid task type', () => {
    const result = TaskSpecSchema.safeParse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      missionId: '660e8400-e29b-41d4-a716-446655440000',
      type: 'invalid',
      intentNodeId: null,
      dependsOn: [],
      grantId: '770e8400-e29b-41d4-a716-446655440000',
      grantVersion: 1,
      budget: { maxSteps: 30, maxWallClockMs: 300000 },
      payload: {},
    });
    expect(result.success).toBe(false);
  });
});

describe('WorkerReportSchema', () => {
  it('accepts valid report', () => {
    const result = WorkerReportSchema.safeParse({
      taskId: '550e8400-e29b-41d4-a716-446655440000',
      status: 'done',
      insertedAssets: [{ type: 'host', value: 'example.com' }],
      insertedFacts: [],
      findings: [],
      suggestedIntents: [],
      stepCount: 5,
      tokenCount: 1500,
    });
    expect(result.success).toBe(true);
  });

  it('rejects finding without evidence', () => {
    const result = WorkerReportSchema.safeParse({
      taskId: '550e8400-e29b-41d4-a716-446655440000',
      status: 'done',
      insertedAssets: [],
      insertedFacts: [],
      findings: [{
        title: 'test',
        category: 'xss',
        severity: 'high',
        assetRefs: ['example.com'],
        evidenceRefs: [],
        claimsAnonymous: false,
        isCredentialLeak: false,
      }],
      suggestedIntents: [],
      stepCount: 5,
      tokenCount: 1500,
    });
    expect(result.success).toBe(false);
  });
});

describe('SystemBlockSchema', () => {
  it('accepts valid block', () => {
    const result = SystemBlockSchema.safeParse({
      ok: false,
      blocked_by: 'platform',
      reason: 'Target not in authorized scope',
      approval_required: false,
    });
    expect(result.success).toBe(true);
  });

  it('rejects block without blocked_by', () => {
    const result = SystemBlockSchema.safeParse({
      ok: false,
      reason: 'test',
      approval_required: false,
    });
    expect(result.success).toBe(false);
  });
});

describe('CommandSchema', () => {
  it('accepts PauseMission', () => {
    const result = CommandSchema.safeParse({
      type: 'PauseMission',
      payload: { missionId: '550e8400-e29b-41d4-a716-446655440000' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown command', () => {
    const result = CommandSchema.safeParse({
      type: 'DeleteEverything',
      payload: {},
    });
    expect(result.success).toBe(false);
  });
});

describe('EvidenceRefSchema', () => {
  it('accepts valid evidence ref', () => {
    const result = EvidenceRefSchema.safeParse({
      trafficId: 'tr_123',
      requestHash: 'abc',
      responseHash: 'def',
    });
    expect(result.success).toBe(true);
  });

  it('rejects extra fields', () => {
    const result = EvidenceRefSchema.safeParse({
      trafficId: 'tr_123',
      requestHash: 'abc',
      responseHash: 'def',
      extra: true,
    });
    expect(result.success).toBe(false);
  });
});

describe('v1.0.2 reliability contracts', () => {
  it('applies deadline defaults and rejects invalid phase', () => {
    const parsed = MissionDeadlineSchema.parse({ deadlineAt: null });
    expect(parsed.phase).toBe('active');
    expect(parsed.reportingLeadMs).toBe(900_000);
    expect(MissionDeadlineSchema.safeParse({ deadlineAt: null, phase: 'exploding' }).success).toBe(false);
  });

  it('derives dispositions for legacy terminal states', () => {
    expect(deriveTaskDisposition('done')).toBe('completed');
    expect(deriveTaskDisposition('exhausted')).toBe('exhausted');
    expect(deriveTaskDisposition('blocked')).toBe('blocked');
    expect(deriveTaskDisposition('cancelled')).toBe('cancelled');
    expect(deriveTaskDisposition('running')).toBeNull();
  });

  it('accepts a structured handoff and rejects sensitive fields/values', () => {
    const valid = {
      targetRef: 'asset:web-01',
      scopeRef: 'grant:42:v2',
      accessState: 'authorized',
      credentialRefs: ['credential:8'],
      confirmedFacts: ['admin login available'],
      evidenceIds: ['ev_1'],
      failedHypotheses: ['SQLi on /search'],
      nextActions: ['test upload endpoint', 'inspect JWT secret'],
      blockers: [],
      approvalsNeeded: [],
    };
    expect(TaskHandoffSchema.safeParse(valid).success).toBe(true);
    expect(TaskHandoffSchema.safeParse({ ...valid, password: 'hunter2' }).success).toBe(false);
    expect(TaskHandoffSchema.safeParse({
      ...valid,
      nextActions: ['use API_KEY=sk_live_abcdefghijklmnop'],
    }).success).toBe(false);
    expect(TaskHandoffSchema.safeParse({ ...valid, nextActions: [] }).success).toBe(false);
  });

  it('validates preflight decisions', () => {
    const base = { phaseOk: true, deadlineOk: true, scopeOk: true, authOk: true };
    expect(PreflightCheckSchema.safeParse({ ...base, decision: 'proceed' }).success).toBe(true);
    expect(PreflightCheckSchema.safeParse({ ...base, decision: 'proceed', pendingDestructiveApproval: true }).success).toBe(true);
    expect(PreflightCheckSchema.safeParse({ ...base, decision: 'launch_missiles' }).success).toBe(false);
  });

  it('computes capped exponential retry delays', () => {
    expect(computeRetryDelayMs(1, { baseDelayMs: 1000, jitterRatio: 0 }, () => 0.5)).toBe(1000);
    expect(computeRetryDelayMs(3, { baseDelayMs: 1000, jitterRatio: 0 }, () => 0.5)).toBe(4000);
    expect(computeRetryDelayMs(99, { baseDelayMs: 1000, maxDelayMs: 5000, jitterRatio: 0 }, () => 0.5)).toBe(5000);
    const jittered = computeRetryDelayMs(1, { baseDelayMs: 1000, jitterRatio: 0.2 }, () => 1);
    expect(jittered).toBeGreaterThan(1000);
    expect(jittered).toBeLessThanOrEqual(1200);
  });

  it('validates coverage requirements and disposition enum', () => {
    expect(CoverageRequirementSchema.safeParse({
      targetRef: 'target:web',
      attackSurface: 'web',
      status: 'pending',
    }).success).toBe(true);
    expect(TaskDispositionSchema.safeParse('out_of_scope').success).toBe(true);
    expect(TaskDispositionSchema.safeParse('gave_up').success).toBe(false);
  });
});

describe('handoff digest', () => {
  it('bounds lists and clamps long text', () => {
    const handoff = {
      targetRef: 'target:web',
      accessState: 'authenticated' as const,
      confirmedFacts: Array.from({ length: 12 }, (_, i) => `fact ${i} ${'x'.repeat(300)}`),
      failedHypotheses: ['hypothesis'],
      nextActions: ['one', 'two', 'three', 'four'],
      blockers: [],
      approvalsNeeded: [],
      credentialRefs: [],
      evidenceIds: [],
    };
    const digest = buildTaskHandoffDigest(handoff as never, 2);
    expect(digest.version).toBe(2);
    expect(digest.confirmedFacts).toHaveLength(8);
    expect(digest.nextActions).toHaveLength(3);
    expect(digest.confirmedFacts[0].length).toBeLessThanOrEqual(240);
  });
});

describe('coverage requirements', () => {
  it('maps network and attachment targets to authorized surfaces', () => {
    expect(deriveCoverageRequirements({ type: 'url', value: 'https://app.example.com' }))
      .toEqual([expect.objectContaining({ attackSurface: 'web', status: 'pending' })]);
    expect(deriveCoverageRequirements({ type: 'ip', value: '10.0.0.1' }))
      .toEqual([expect.objectContaining({ attackSurface: 'network' })]);
    expect(deriveCoverageRequirements({ type: 'file', value: 'attachments' }))
      .toEqual([expect.objectContaining({ attackSurface: 'artifact' })]);
    expect(deriveCoverageRequirements(null)).toEqual([]);
  });
});
