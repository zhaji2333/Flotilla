import { describe, expect, it } from 'vitest';
import { parsePlan, resolveDependencies, taskFingerprint, validatePlan } from './plan.js';
import { PlannerPlanError, type PlannerPlan } from './types.js';

const known = new Set(['11111111-1111-4111-8111-111111111111']);
const open = new Set(['11111111-1111-4111-8111-111111111111']);

function plan(actions: PlannerPlan['actions']): PlannerPlan {
  return { analysis: 'test analysis', actions };
}

describe('planner plan validation', () => {
  it('parses a valid plan and assigns create ids', () => {
    const parsed = parsePlan(plan([
      { type: 'create_task', objective: 'recon the login flow', dependsOn: [] },
      { type: 'create_task', objective: 'test IDOR on /api/users', dependsOn: ['new:1'] },
      { type: 'add_todo', content: 'recon', position: 0 },
      { type: 'update_checkpoint', summary: 'started' },
    ]));
    const validated = validatePlan(parsed, { knownTaskIds: known, openTaskIds: open });
    expect(validated.creates).toHaveLength(2);
    expect(validated.creates[0].id).toMatch(/[0-9a-f-]{36}/);
    expect(resolveDependencies(['new:1'], validated.creates)).toEqual([validated.creates[0].id]);
  });

  it('rejects unknown fields, too many actions and forward dependencies', () => {
    expect(() => parsePlan({ analysis: 'x', actions: [], extra: true })).toThrow(PlannerPlanError);
    expect(() => parsePlan({ analysis: 'x', actions: Array.from({ length: 7 }, () => ({ type: 'add_todo', content: 't' })) })).toThrow(/at most 6|<=6/);
    expect(() => parsePlan({ analysis: 'x', actions: [{ type: 'bogus' }] })).toThrow(PlannerPlanError);
    const forward = plan([{ type: 'create_task', objective: 'a', dependsOn: ['new:2'] }, { type: 'create_task', objective: 'b', dependsOn: [] }]);
    expect(() => validatePlan(parsePlan(forward), { knownTaskIds: known, openTaskIds: open })).toThrow(/forward/);
  });

  it('rejects dependencies on unknown tasks and cancelling finished tasks', () => {
    const unknownDep = plan([{ type: 'create_task', objective: 'x', dependsOn: ['22222222-2222-4222-8222-222222222222'] }]);
    expect(() => validatePlan(parsePlan(unknownDep), { knownTaskIds: known, openTaskIds: open })).toThrow(/unknown task/);
    const cancelClosed = plan([{ type: 'cancel_task', taskId: '33333333-3333-4333-8333-333333333333' }]);
    expect(() => validatePlan(parsePlan(cancelClosed), { knownTaskIds: known, openTaskIds: open })).toThrow(/missing or already-finished/);
  });

  it('resolves new:N references in add_hint and cancel_task targets', () => {
    const refs = parsePlan(plan([
      { type: 'create_task', objective: 'recon', dependsOn: [] },
      { type: 'add_hint', content: 'focus on login', taskId: 'new:1' },
      { type: 'cancel_task', taskId: 'new:1', reason: 'superseded' },
    ]));
    const validated = validatePlan(refs, { knownTaskIds: known, openTaskIds: open });
    expect(validated.creates).toHaveLength(1);
    expect(() => validatePlan(parsePlan(plan([
      { type: 'add_hint', content: 'x', taskId: 'new:2' },
      { type: 'create_task', objective: 'y', dependsOn: [] },
    ])), { knownTaskIds: known, openTaskIds: open })).toThrow(/unknown plan item/);
  });

  it('has a stable fingerprint per objective/target and separates angles', () => {
    expect(taskFingerprint('a', 'http://t')).toBe(taskFingerprint('a', 'http://t'));
    expect(taskFingerprint('a', 'http://t')).not.toBe(taskFingerprint('b', 'http://t'));
    expect(taskFingerprint('a', 'http://t', 'web')).not.toBe(taskFingerprint('a', 'http://t', 'api'));
  });

  it('parses update_todo with string or numeric ids', () => {
    const parsed = parsePlan({
      analysis: 'test analysis',
      actions: [
        { type: 'update_todo', todoId: '12', status: 'in_progress' },
        { type: 'update_todo', todoId: '13', status: 'done' },
        { type: 'update_todo', todoId: '14', status: 'completed' },
      ],
    });
    expect(parsed.actions[0]).toMatchObject({ type: 'update_todo', todoId: '12', status: 'in_progress' });
    expect(parsed.actions[1]).toMatchObject({ type: 'update_todo', todoId: '13', status: 'done' });
    expect(parsed.actions[2]).toMatchObject({ type: 'update_todo', todoId: '14', status: 'done' });
  });

  it('parses an optional angle and rejects unknown angles', () => {
    const parsed = parsePlan(plan([{ type: 'create_task', objective: 'api recon', dependsOn: [], angle: 'api' }]));
    expect(parsed.actions[0]).toMatchObject({ type: 'create_task', angle: 'api' });
    expect(() => parsePlan({ analysis: 'x', actions: [{ type: 'create_task', objective: 'x', dependsOn: [], angle: 'mobile' }] })).toThrow();
  });
});
