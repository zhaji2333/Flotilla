import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface StoredArtifact {
  sha256: string;
  size: number;
  path: string;
  ref: string;
}

/** Content-addressed, mission/task-scoped artifact storage on a shared volume. */
export class ArtifactStore {
  constructor(private readonly root: string) {}

  async put(missionId: string, taskId: string, data: Buffer, filename = 'body'): Promise<StoredArtifact> {
    const mission = safeSegment(missionId, 'missionId');
    const task = safeSegment(taskId, 'taskId');
    const sha256 = createHash('sha256').update(data).digest('hex');
    const directory = join(this.root, mission, task, 'sha256', sha256.slice(0, 2));
    const path = join(directory, sha256);
    await mkdir(directory, { recursive: true });
    await writeFile(path, data, { mode: 0o640 });
    await writeFile(`${path}.json`, JSON.stringify({
      sha256,
      size: data.length,
      filename: safeFilename(filename),
      missionId: mission,
      taskId: task,
      createdAt: new Date().toISOString(),
    }), { mode: 0o640 });
    return { sha256, size: data.length, path, ref: `sha256:${sha256}` };
  }
}

function safeSegment(value: string, label: string): string {
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(value) || value === '.' || value === '..') {
    throw new Error(`invalid ${label}`);
  }
  return value;
}

function safeFilename(value: string): string {
  const base = value.replace(/[/\\\0]/g, '_').slice(0, 160);
  return base || 'artifact';
}
