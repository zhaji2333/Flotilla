import { describe, expect, it } from 'vitest';
import { evaluatePreflight, preflightDisposition } from './preflight.js';

const now = new Date('2026-01-01T00:00:00Z');
const base = { phase: 'active' as const, deadlineAt: null, now, scopePresent: true };

describe('preflight gate', () => {
  it('proceeds for an active, in-scope, non-destructive task', () => {
    const check = evaluatePreflight(base);
    expect(check.decision).toBe('proceed');
    expect(check.phaseOk).toBe(true);
    expect(check.deadlineOk).toBe(true);
  });

  it('blocked after the deadline and when the mission is closed', () => {
    const expired = evaluatePreflight({ ...base, deadlineAt: new Date('2025-12-31T23:59:59Z') });
    expect(expired.decision).toBe('blocked');
    expect(preflightDisposition(expired)).toBe('timeout');
    const closed = evaluatePreflight({ ...base, phase: 'closed' });
    expect(closed.decision).toBe('blocked');
    expect(preflightDisposition(closed)).toBe('timeout');
  });

  it('reports out_of_scope when the grant is missing', () => {
    const check = evaluatePreflight({ ...base, scopePresent: false });
    expect(check.decision).toBe('out_of_scope');
    expect(preflightDisposition(check)).toBe('out_of_scope');
  });

  it('blocks destructive actions that are not approved yet', () => {
    const check = evaluatePreflight({ ...base, pendingDestructiveApproval: true });
    expect(check.decision).toBe('blocked');
    expect(check.reason).toContain('destructive');
  });
});
