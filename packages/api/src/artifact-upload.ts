import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, chown, mkdir, rename, rm } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import type http from 'node:http';
import { createArtifact, getMission, getPool } from '@src-agent/control-plane';
import type { AuthContext } from './auth.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ARTIFACT_GROUP_ID = Number(process.env.ARTIFACT_GROUP_ID || 10003);

function json(response: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  response.end(text);
}

function safeFilename(raw: string | undefined): string {
  const candidate = basename((raw ?? 'artifact.bin').replace(/\\/g, '/')).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 160);
  return candidate && candidate !== '.' && candidate !== '..' ? candidate : 'artifact.bin';
}

function maxBytes(): number {
  const value = Number(process.env.ARTIFACT_MAX_BYTES || 2 * 1024 * 1024 * 1024);
  return Number.isFinite(value) && value > 0 ? Math.min(value, 8 * 1024 * 1024 * 1024) : 2 * 1024 * 1024 * 1024;
}

function rootDir(): string {
  return (process.env.ARTIFACTS_DIR || '/artifacts').replace(/\/+$/, '');
}

/** Raw-body artifact upload; intentionally bypasses the small JSON body parser. */
export async function handleArtifactUpload(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  url: URL,
  auth: AuthContext | null,
): Promise<boolean> {
  const match = url.pathname.match(/^\/api\/missions\/([^/]+)\/artifacts$/);
  if (!match) return false;
  if (request.method !== 'POST') return false;
  const missionId = match[1]!;
  if (!UUID.test(missionId)) {
    json(response, 400, { error: 'missionId must be a UUID' });
    return true;
  }
  const mission = await getMission(missionId);
  if (!mission) {
    json(response, 404, { error: 'mission not found' });
    return true;
  }
  const limit = maxBytes();
  const declared = Number(request.headers['content-length'] ?? 0);
  if (Number.isFinite(declared) && declared > limit) {
    json(response, 413, { error: `artifact exceeds limit of ${limit} bytes` });
    return true;
  }
  const rawFilename = typeof request.headers['x-artifact-filename'] === 'string' ? request.headers['x-artifact-filename'] : undefined;
  let filenameHeader = rawFilename;
  if (rawFilename) {
    try { filenameHeader = decodeURIComponent(rawFilename); } catch { /* keep raw header */ }
  }
  const filename = safeFilename(filenameHeader);
  const contentType = typeof request.headers['content-type'] === 'string' ? request.headers['content-type'] : 'application/octet-stream';
  const taskHeader = typeof request.headers['x-artifact-task-id'] === 'string' ? request.headers['x-artifact-task-id'] : '';
  const taskId = taskHeader && UUID.test(taskHeader) ? taskHeader : null;

  const root = rootDir();
  const tempDirectory = join(root, missionId, '.uploads');
  await mkdir(tempDirectory, { recursive: true, mode: 0o775 });
  await chown(join(root, missionId), -1, ARTIFACT_GROUP_ID).catch(() => undefined);
  await chmod(join(root, missionId), 0o2775).catch(() => undefined);
  await chown(tempDirectory, -1, ARTIFACT_GROUP_ID).catch(() => undefined);
  await chmod(tempDirectory, 0o2775).catch(() => undefined);
  const tempPath = join(tempDirectory, `upload-${Date.now()}-${Math.random().toString(16).slice(2)}.part`);
  const hash = createHash('sha256');
  let size = 0;
  const stream = createWriteStream(tempPath, { mode: 0o640 });
  try {
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > limit) {
        stream.destroy();
        await rm(tempPath, { force: true });
        json(response, 413, { error: `artifact exceeds limit of ${limit} bytes` });
        return true;
      }
      hash.update(buffer);
      if (!stream.write(buffer)) await new Promise<void>(resolve => stream.once('drain', resolve));
    }
    await new Promise<void>((resolve, reject) => {
      stream.end(() => resolve());
      stream.once('error', reject);
    });
    if (size === 0) {
      await rm(tempPath, { force: true });
      json(response, 400, { error: 'empty artifact body' });
      return true;
    }
    const sha256 = hash.digest('hex');
    const directory = join(root, missionId, 'uploads', sha256);
    await mkdir(directory, { recursive: true, mode: 0o775 });
    await chown(join(root, missionId, 'uploads'), -1, ARTIFACT_GROUP_ID).catch(() => undefined);
    await chmod(join(root, missionId, 'uploads'), 0o2775).catch(() => undefined);
    await chown(directory, -1, ARTIFACT_GROUP_ID).catch(() => undefined);
    await chmod(directory, 0o2775).catch(() => undefined);
    const finalPath = join(directory, filename);
    await rm(finalPath, { force: true });
    await rename(tempPath, finalPath);
    await chown(finalPath, -1, ARTIFACT_GROUP_ID).catch(() => undefined);
    await chmod(finalPath, 0o640).catch(() => undefined);
    const artifact = await createArtifact(getPool(), {
      missionId,
      taskId,
      sha256,
      size,
      filename,
      contentType,
      storagePath: relative(root, finalPath),
      createdBy: auth?.actor ?? 'api',
    });
    const status = artifact.sha256 === sha256 ? 201 : 200;
    json(response, status, { artifact });
    return true;
  } catch (error) {
    stream.destroy();
    await rm(tempPath, { force: true }).catch(() => undefined);
    json(response, 500, { error: `artifact upload failed: ${String(error)}` });
    return true;
  }
}
