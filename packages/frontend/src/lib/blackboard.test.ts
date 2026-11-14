import { describe, expect, it } from 'vitest';
import { factDisplayValue, groupFactsByKind, maskSensitiveValue } from './blackboard';
import type { MissionFact } from './types';

function fact(overrides: Partial<MissionFact>): MissionFact {
  return {
    id: 'asset:1',
    missionId: 'm',
    source: 'asset',
    sourceId: 'a',
    kind: 'credential',
    key: 'credential:admin',
    value: 'admin:plaintext-secret',
    summary: 'admin:plaintext-secret',
    provenance: 'worker_asset',
    trust: 'inferred',
    sensitive: true,
    taskId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('blackboard helpers', () => {
  it('masks sensitive credential values by default', () => {
    expect(maskSensitiveValue('admin:plaintext-secret')).toBe('admin:••••••');
    expect(factDisplayValue(fact({}), false)).not.toContain('plaintext');
    expect(factDisplayValue(fact({}), true)).toBe('admin:plaintext-secret');
    expect(factDisplayValue(fact({ sensitive: false, value: 'observed-host' }), false)).toBe('observed-host');
  });

  it('groups facts by known kind priority', () => {
    const groups = groupFactsByKind([
      fact({ id: 'h', kind: 'host' }),
      fact({ id: 'c', kind: 'credential' }),
      fact({ id: 'v', kind: 'vuln' }),
    ]);
    expect(groups.map(group => group.kind)).toEqual(['credential', 'vuln', 'host']);
  });
});
