import { describe, expect, it } from 'vitest';
import {
  isAttackTaskType,
  isPlanCreateBlockedByPhase,
  isTaskBlockedByPhase,
  phaseCancelDisposition,
} from './mission-phase.js';

describe('mission phase gate', () => {
  it('allows every task in the active phase', () => {
    expect(isTaskBlockedByPhase('active', 'explore')).toBe(false);
    expect(isTaskBlockedByPhase(null, 'intent')).toBe(false);
    expect(phaseCancelDisposition('active')).toBe('cancelled');
  });

  it('freezes attack tasks in reporting/closed but keeps summary/report work', () => {
    for (const phase of ['reporting', 'closed']) {
      expect(isTaskBlockedByPhase(phase, 'explore')).toBe(true);
      expect(isTaskBlockedByPhase(phase, 'intent')).toBe(true);
      expect(isTaskBlockedByPhase(phase, 'bootstrap')).toBe(true);
      expect(isTaskBlockedByPhase(phase, 'reason')).toBe(true);
      expect(isTaskBlockedByPhase(phase, 'summary')).toBe(false);
    }
    expect(phaseCancelDisposition('reporting')).toBe('cancelled');
    expect(phaseCancelDisposition('closed')).toBe('timeout');
  });

  it('only classifies known attack task types', () => {
    expect(isAttackTaskType('explore')).toBe(true);
    expect(isAttackTaskType('summary')).toBe(false);
    expect(isAttackTaskType('unknown')).toBe(false);
  });

  it('blocks only plans that create tasks after the deadline phase', () => {
    const creates = [{ type: 'create_task' }, { type: 'add_todo' }];
    const hintsOnly = [{ type: 'add_hint' }, { type: 'update_todo' }];
    expect(isPlanCreateBlockedByPhase('active', creates)).toBe(false);
    expect(isPlanCreateBlockedByPhase('reporting', creates)).toBe(true);
    expect(isPlanCreateBlockedByPhase('closed', creates)).toBe(true);
    expect(isPlanCreateBlockedByPhase('reporting', hintsOnly)).toBe(false);
  });
});
