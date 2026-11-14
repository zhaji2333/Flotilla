import { describe, expect, it } from 'vitest';
import { buildPlannerPrompt } from './prompt.js';
import type { PlannerSnapshot } from './types.js';

const snapshot: PlannerSnapshot = {
  mission: {
    id: 'm-1',
    name: 'lab',
    state: 'pending',
    objective: 'obtain all flags',
    targetType: 'url',
    targetValue: 'http://target',
    checkpoint: {},
  },
  tasks: [{ id: 't-1', type: 'bootstrap', state: 'done', objective: 'initial recon', attempt: 1, dependsOn: [], lastError: null }],
  findings: [{ id: 'f-1', title: 'IDOR', artifact: 'flag1', status: 'accepted' }],
  assets: [{ type: 'host', value: 'target' }],
  todo: [{ id: '1', content: 'recon', status: 'done', position: 0 }],
};

describe('planner prompt', () => {
  it('injects frontier facts/intents when the blackboard is enabled', () => {
    const withFrontier: PlannerSnapshot = {
      ...snapshot,
      frontier: {
        missionId: 'm-1',
        version: 7,
        generatedAt: new Date().toISOString(),
        facts: [
          {
            id: 'asset:a-1', missionId: 'm-1', source: 'asset', sourceId: 'a-1',
            kind: 'credential', key: 'credential:admin:plaintext-secret', value: 'admin:plaintext-secret',
            summary: 'login page', provenance: 'worker_asset', trust: 'inferred', sensitive: true,
            taskId: 't-1', createdAt: new Date().toISOString(),
          },
          {
            id: 'evidence-host:h-1', missionId: 'm-1', source: 'evidence', sourceId: 'h-1',
            kind: 'host', key: 'target', value: 'target', summary: 'target',
            provenance: 'proxy_evidence', trust: 'observed', sensitive: false,
            taskId: null, createdAt: new Date().toISOString(),
          },
        ],
        intents: [{
          id: 't-2', missionId: 'm-1', type: 'intent', state: 'ready',
          objective: 'enumerate /admin', priority: 0.8, dependsOn: [], attempt: 0,
          createdAt: new Date().toISOString(),
        }],
        counts: { facts: 2, intents: 1, sensitiveFacts: 1, byKind: { credential: 1, host: 1 } },
      },
    };
    const prompt = buildPlannerPrompt(withFrontier, []);
    expect(prompt).toContain('FRONTIER (typed blackboard read model; 2 facts / 1 open intents; version=7)');
    expect(prompt).toContain('[credential|inferred|sensitive]');
    expect(prompt).toContain('admin:plaintext-secret');
    expect(prompt).toContain('enumerate /admin');
    expect(prompt).toContain('never copy secret values');
    expect(buildPlannerPrompt(snapshot, [])).not.toContain('FRONTIER (typed blackboard');
  });

  it('includes the batched signals, task state, findings and submit_plan contract', () => {
    const prompt = buildPlannerPrompt(snapshot, [
      { id: 's-1', kind: 'worker_report', payload: { taskId: 't-1', findings: 1 }, createdAt: new Date().toISOString() },
    ]);
    expect(prompt).toContain('obtain all flags');
    expect(prompt).toContain('[worker_report]');
    expect(prompt).toContain('FINDINGS (1)');
    expect(prompt).toContain('submit_plan');
    expect(prompt).toContain('Max 6 actions');
    expect(prompt).toContain('never propose scope expansion');
  });

  it('works with no signals', () => {
    expect(buildPlannerPrompt(snapshot, [])).toContain('(none)');
  });
});
