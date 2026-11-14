import { readdir, rm, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { getPool } from '@src-agent/control-plane';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function artifactsRoot(): string {
  return (process.env.ARTIFACTS_DIR || '/artifacts').replace(/\/+$/, '');
}

/** Remove the complete artifact tree for a mission. DB rows cascade separately. */
export async function removeMissionArtifacts(missionId: string): Promise<void> {
  if (!UUID.test(missionId)) throw new Error('missionId must be a UUID');
  await rm(join(artifactsRoot(), missionId), { recursive: true, force: true });
}

async function pruneEmptyDirectories(directory: string, root: string): Promise<void> {
  if (directory === root) return;
  try {
    const entries = await readdir(directory);
    if (entries.length > 0) return;
    await rm(directory, { recursive: false, force: true });
    await pruneEmptyDirectories(join(directory, '..'), root);
  } catch {
    // best-effort cleanup
  }
}

async function removeOldFiles(root: string, cutoff: number): Promise<number> {
  let removed = 0;
  const visit = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const info = await stat(path);
        if (info.mtimeMs < cutoff) {
          await unlink(path);
          removed += 1;
        }
      } catch {
        // file may have been removed by a concurrent job
      }
    }
  };
  await visit(root);
  // Prune empty task/job directories after files are gone.
  try {
    const missions = await readdir(root, { withFileTypes: true });
    for (const mission of missions) {
      if (mission.isDirectory() && UUID.test(mission.name)) await pruneEmptyDirectories(join(root, mission.name), root);
    }
  } catch {
    // root may not exist yet
  }
  return removed;
}

export interface ArtifactGcResult {
  cutoff: string;
  removedFiles: number;
  removedArtifacts: number;
}

/** TTL cleanup for browser/reverse files and uploaded artifact metadata. */
export async function gcArtifacts(days?: number): Promise<ArtifactGcResult> {
  const configured = Math.max(1, Math.min(365, Number(days ?? process.env.ARTIFACT_TTL_DAYS ?? 7)));
  const cutoffMs = Date.now() - configured * 24 * 60 * 60_000;
  const cutoff = new Date(cutoffMs).toISOString();
  const removedFiles = await removeOldFiles(artifactsRoot(), cutoffMs);
  const deleted = await getPool().query(
    `DELETE FROM artifacts WHERE created_at < $1 RETURNING storage_path`,
    [cutoff],
  );
  return { cutoff, removedFiles, removedArtifacts: deleted.rowCount ?? 0 };
}
