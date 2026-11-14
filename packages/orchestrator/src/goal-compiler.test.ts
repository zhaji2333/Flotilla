import { describe, it, expect } from 'vitest';
import { compileGoal } from '../src/goal-compiler.js';

describe('compileGoal', () => {
  it('creates a bootstrap task', () => {
    const task = compileGoal({
      missionId: '550e8400-e29b-41d4-a716-446655440000',
      grantId: '660e8400-e29b-41d4-a716-446655440000',
      grantVersion: 1,
      targetUrl: 'https://example.com',
      objective: 'Find vulnerabilities',
    });
    expect(task.type).toBe('bootstrap');
    expect(task.missionId).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(task.grantId).toBe('660e8400-e29b-41d4-a716-446655440000');
    expect(task.grantVersion).toBe(1);
    expect(task.budget.maxSteps).toBe(0);
    expect(task.payload.objective).toBe('Find vulnerabilities');
    expect(task.payload.targetUrl).toBe('https://example.com');
  });

  it('respects custom budget', () => {
    const task = compileGoal({
      missionId: '550e8400-e29b-41d4-a716-446655440000',
      grantId: '660e8400-e29b-41d4-a716-446655440000',
      grantVersion: 1,
      targetUrl: 'https://example.com',
      objective: 'Quick scan',
      budget: { maxSteps: 10, maxWallClockMs: 60000 },
    });
    expect(task.budget.maxSteps).toBe(10);
    expect(task.budget.maxWallClockMs).toBe(60000);
  });
});
