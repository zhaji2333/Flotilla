import { describe, expect, it } from 'vitest';
import { CreateMissionSchema } from './mission-repository';

describe('CreateMissionSchema attachment invariants', () => {
  const base = { objective: 'analyze uploaded artifact' };

  it('accepts an explicit attachment-only mission', () => {
    const parsed = CreateMissionSchema.safeParse({ ...base, targetMode: 'attachment' });
    expect(parsed.success).toBe(true);
  });

  it('rejects a file target without targetMode=attachment', () => {
    const parsed = CreateMissionSchema.safeParse({ ...base, target: { type: 'file', value: 'attachments' } });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues[0]?.message).toMatch(/file target requires/);
  });

  it('rejects attachment mode with a network target', () => {
    const parsed = CreateMissionSchema.safeParse({
      ...base,
      targetMode: 'attachment',
      target: { type: 'url', value: 'http://127.0.0.1:65280' },
    });
    expect(parsed.success).toBe(false);
  });

  it('keeps normal network targets unchanged', () => {
    const parsed = CreateMissionSchema.safeParse({ ...base, target: { type: 'url', value: 'http://target.test' } });
    expect(parsed.success).toBe(true);
  });
});
