import { describe, it, expect } from 'vitest';
import {
  GrantSchema, TaskSpecSchema, WorkerReportSchema,
  SystemBlockSchema, CommandSchema, EvidenceRefSchema,
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
