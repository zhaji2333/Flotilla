import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createHintFileReader } from './hint-file.js';

describe('createHintFileReader', () => {
  it('reads only complete new lines written since the previous poll', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'src-agent-hints-'));
    const path = join(dir, 'hints.jsonl');
    try {
      await writeFile(path, '');
      const read = createHintFileReader(path);
      expect(await read()).toEqual([]);

      await writeFile(path, `${JSON.stringify('first hint')}\n{"partial`);
      expect(await read()).toEqual(['first hint']);
      expect(await read()).toEqual([]);

      await writeFile(path, `${JSON.stringify('first hint')}\n{"partial": true}\n${JSON.stringify('second hint')}\n`);
      expect(await read()).toEqual(['second hint']);
      expect(await read()).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns [] when the file does not exist yet', async () => {
    const read = createHintFileReader('/tmp/src-agent-missing-hint-file.jsonl');
    expect(await read()).toEqual([]);
  });
});
