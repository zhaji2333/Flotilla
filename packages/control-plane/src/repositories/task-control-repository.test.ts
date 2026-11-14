import { describe, expect, it } from 'vitest';
import { CreateManualTaskSchema } from './task-control-repository.js';

describe('CreateManualTaskSchema', () => {
  it('accepts a bounded manual objective and optional angle', () => {
    expect(CreateManualTaskSchema.parse({ objective: 'check /admin', angle: 'web' })).toEqual({
      objective: 'check /admin',
      angle: 'web',
      artifactIds: [],
    });
  });

  it('accepts mission artifact ids', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    expect(CreateManualTaskSchema.parse({ objective: 'reverse apk', artifactIds: [id] }).artifactIds).toEqual([id]);
  });

  it('rejects empty/oversized objectives and unknown fields', () => {
    expect(CreateManualTaskSchema.safeParse({ objective: '   ' }).success).toBe(false);
    expect(CreateManualTaskSchema.safeParse({ objective: 'x'.repeat(2_001) }).success).toBe(false);
    expect(CreateManualTaskSchema.safeParse({ objective: 'x', unexpected: true }).success).toBe(false);
  });
});
