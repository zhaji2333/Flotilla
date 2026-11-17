import { describe, expect, it } from 'vitest';
import {
  computeNextRetryAt,
  parseCoverageForStorage,
  parseHandoffForStorage,
  parsePreflightForStorage,
} from './reliability-repository';

const handoff = {
  targetRef: 'target:web',
  scopeRef: 'grant:1:v1',
  accessState: 'authorized' as const,
  credentialRefs: ['credential:1'],
  confirmedFacts: ['login works'],
  evidenceIds: ['ev_1'],
  failedHypotheses: ['sqli on /search'],
  nextActions: ['try upload'],
  blockers: [],
  approvalsNeeded: [],
};

describe('reliability repository validation', () => {
  it('accepts a structured handoff and rejects embedded secrets', () => {
    expect(parseHandoffForStorage(handoff)).toMatchObject({ targetRef: 'target:web', accessState: 'authorized' });
    expect(() => parseHandoffForStorage({ ...handoff, password: 'hunter2' })).toThrow();
    expect(() => parseHandoffForStorage({ ...handoff, nextActions: ['token ghp_abcdefghijklmnopqrstuvwxyz012345'] })).toThrow();
  });

  it('validates preflight checks', () => {
    const check = parsePreflightForStorage({
      phaseOk: true,
      deadlineOk: true,
      scopeOk: false,
      authOk: true,
      decision: 'out_of_scope',
      reason: 'target removed from grant',
    });
    expect(check.decision).toBe('out_of_scope');
    expect(check.targetVersion).toBeNull();
  });

  it('normalises coverage requirements with pending default', () => {
    const coverage = parseCoverageForStorage({ targetRef: 'target:web', attackSurface: 'web' });
    expect(coverage.status).toBe('pending');
    expect(coverage.disposition).toBeNull();
  });

  it('computes deterministic retry times and caps the delay', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const next = computeNextRetryAt(1, { baseDelayMs: 1_000, jitterRatio: 0 }, now, () => 0.5);
    expect(next.toISOString()).toBe('2026-01-01T00:00:01.000Z');
    const capped = computeNextRetryAt(99, { baseDelayMs: 1_000, maxDelayMs: 5_000, jitterRatio: 0 }, now, () => 0.5);
    expect(capped.toISOString()).toBe('2026-01-01T00:00:05.000Z');
  });
});

describe('handoff builder', () => {
  it('derives a structured handoff without raw evidence text', async () => {
    const { buildHandoffFromReport } = await import('./reliability-repository');
    const handoff = buildHandoffFromReport({
      targetRef: 'target:web',
      scopeRef: 'grant:1:v1',
      findings: [{ title: 'stored XSS on /profile' }],
      evidenceIds: ['ev_1', 'ev_2'],
      failureClass: 'no_progress',
    });
    expect(handoff.confirmedFacts).toEqual(['stored XSS on /profile']);
    expect(handoff.evidenceIds).toEqual(['ev_1', 'ev_2']);
    expect(handoff.failedHypotheses).toEqual(['failed with no_progress']);
    expect(handoff.nextActions[0]).toContain('stored XSS');
  });
});
