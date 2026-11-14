import Busboy from 'busboy';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { copyFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type http from 'node:http';
import { CreateMissionSchema, activateBootstrapTask, createMission, deleteMissionCascade, getMission, getPool } from '@src-agent/control-plane';
import { createArtifact } from '@src-agent/control-plane';
import type { AuthContext } from './auth.js';
import { removeMissionArtifacts } from './artifact-cleanup.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(response: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  response.end(text);
}

function safeFilename(raw: string): string {
  const candidate = basename(raw.replace(/\\/g, '/')).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 160);
  return candidate && candidate !== '.' && candidate !== '..' ? candidate : 'artifact.bin';
}

function maxBytes(): number {
  const value = Number(process.env.ARTIFACT_MAX_BYTES || 2 * 1024 * 1024 * 1024);
  return Number.isFinite(value) && value > 0 ? Math.min(value, 8 * 1024 * 1024 * 1024) : 2 * 1024 * 1024 * 1024;
}

function artifactsRoot(): string {
  return (process.env.ARTIFACTS_DIR || '/artifacts').replace(/\/+$/, '');
}

function artifactGroupId(): number {
  return Number(process.env.ARTIFACT_GROUP_ID || 10003);
}

interface ParsedFile {
  path: string;
  filename: string;
  contentType: string;
  size: number;
}

interface ParsedMultipart {
  fields: Record<string, string>;
  files: ParsedFile[];
}

async function parseMultipart(request: http.IncomingMessage, tempDirectory: string): Promise<ParsedMultipart> {
  return await new Promise((resolve, reject) => {
    const fields: Record<string, string> = {};
    const files: ParsedFile[] = [];
    const writes: Promise<void>[] = [];
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const done = (): void => {
      void Promise.all(writes).then(() => {
        if (settled) return;
        settled = true;
        resolve({ fields, files });
      }, fail);
    };
    let parser: ReturnType<typeof Busboy>;
    try {
      parser = Busboy({
        headers: request.headers,
        limits: { files: 20, fields: 30, fieldSize: 1_000_000, fileSize: maxBytes() },
      });
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    parser.on('field', (name, value) => { fields[name] = value; });
    parser.on('file', (name, stream, info) => {
      if (name !== 'artifact' && name !== 'file' && name !== 'files') {
        stream.resume();
        return;
      }
      const filename = safeFilename(info.filename || 'artifact.bin');
      const path = join(tempDirectory, `${files.length}-${Date.now()}-${filename}`);
      let size = 0;
      let limited = false;
      const output = createWriteStream(path, { mode: 0o600 });
      writes.push(new Promise<void>((resolveFile, rejectFile) => {
        stream.on('data', (chunk: Buffer) => {
          size += chunk.length;
          output.write(chunk);
        });
        stream.on('limit', () => { limited = true; });
        stream.on('error', rejectFile);
        output.on('error', rejectFile);
        stream.on('end', () => {
          output.end(() => {
            if (limited) {
              rejectFile(new Error(`artifact ${filename} exceeds limit of ${maxBytes()} bytes`));
            } else {
              files.push({ path, filename, contentType: info.mimeType || 'application/octet-stream', size });
              resolveFile();
            }
          });
        });
      }));
    });
    parser.on('error', fail);
    parser.on('finish', done);
    request.pipe(parser);
  });
}

async function persistFile(missionId: string, file: ParsedFile, actor: string): Promise<Awaited<ReturnType<typeof createArtifact>>> {
  const root = artifactsRoot();
  const directory = join(root, missionId, 'uploads');
  const { mkdir, chown, chmod, rename, rm } = await import('node:fs/promises');
  await mkdir(directory, { recursive: true, mode: 0o775 });
  await chown(join(root, missionId), -1, artifactGroupId()).catch(() => undefined);
  await chmod(join(root, missionId), 0o2775).catch(() => undefined);
  await chown(directory, -1, artifactGroupId()).catch(() => undefined);
  await chmod(directory, 0o2775).catch(() => undefined);
  const hash = createHash('sha256');
  for await (const chunk of (await import('node:fs')).createReadStream(file.path)) hash.update(chunk as Buffer);
  const sha256 = hash.digest('hex');
  const targetDirectory = join(directory, sha256);
  await mkdir(targetDirectory, { recursive: true, mode: 0o775 });
  await chown(targetDirectory, -1, artifactGroupId()).catch(() => undefined);
  await chmod(targetDirectory, 0o2775).catch(() => undefined);
  const finalPath = join(targetDirectory, file.filename);
  await rm(finalPath, { force: true });
  await rename(file.path, finalPath).catch(async () => {
    await copyFile(file.path, finalPath);
    await rm(file.path, { force: true });
  });
  await chown(finalPath, -1, artifactGroupId()).catch(() => undefined);
  await chmod(finalPath, 0o640).catch(() => undefined);
  const size = (await stat(finalPath)).size;
  return await createArtifact(getPool(), {
    missionId,
    sha256,
    size,
    filename: file.filename,
    contentType: file.contentType,
    storagePath: finalPath.slice(root.length + 1),
    createdBy: actor,
  });
}

/** POST /api/missions multipart/form-data: target + objective + files in one request. */
export async function handleMissionMultipart(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  auth: AuthContext | null,
): Promise<boolean> {
  const contentType = String(request.headers['content-type'] ?? '');
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) return false;
  const tempDirectory = await mkdtemp(join(tmpdir(), 'src-agent-mission-upload-'));
  let missionId: string | null = null;
  try {
    const parsed = await parseMultipart(request, tempDirectory);
    const fields = parsed.fields;
    const attachmentMode = fields.targetMode === 'attachment';
    if (attachmentMode && parsed.files.length === 0) {
      json(response, 400, { error: 'targetMode=attachment requires at least one uploaded artifact' });
      return true;
    }
    const target = fields.target
      ? JSON.parse(fields.target) as unknown
      : attachmentMode
        ? { type: 'file', value: 'attachments' }
        : { type: fields.targetType, value: fields.targetValue };
    const numeric = (key: string): number | undefined => fields[key] === undefined ? undefined : Number(fields[key]);
    const parsedMission = CreateMissionSchema.safeParse({
      name: fields.name,
      target,
      ...(attachmentMode ? { targetMode: 'attachment' as const } : {}),
      objective: fields.objective,
      ...(fields.maxSteps !== undefined ? { maxSteps: numeric('maxSteps') } : {}),
      ...(fields.maxWallClockMs !== undefined ? { maxWallClockMs: numeric('maxWallClockMs') } : {}),
      ...(fields.methodology ? { methodology: fields.methodology } : {}),
      ...(fields.scopeExtras ? { scopeExtras: JSON.parse(fields.scopeExtras) } : {}),
      ...(fields.priority !== undefined ? { priority: numeric('priority') } : {}),
      ...(fields.coverageGate ? { coverageGate: JSON.parse(fields.coverageGate) } : {}),
    });
    if (!parsedMission.success) {
      json(response, 400, { error: 'invalid mission fields', issues: parsedMission.error.issues });
      return true;
    }
    const created = await createMission(parsedMission.data, { bootstrapState: 'blocked' });
    missionId = created.missionId;
    const actor = auth?.actor ?? 'api';
    const artifacts = [];
    for (const file of parsed.files) {
      artifacts.push(await persistFile(created.missionId, file, actor));
    }
    const artifactIds = artifacts.map(artifact => artifact.id);
    await activateBootstrapTask(created.taskId, created.missionId, artifactIds);
    json(response, 201, { ...created, artifacts, artifactIds });
    return true;
  } catch (error) {
    if (missionId) {
      await removeMissionArtifacts(missionId).catch(() => undefined);
      const mission = await getMission(missionId).catch(() => null);
      if (mission) await deleteMissionCascade(missionId, mission.name).catch(() => undefined);
    }
    json(response, 400, { error: `multipart mission creation failed: ${String(error).slice(0, 1000)}` });
    return true;
  } finally {
    await rm(tempDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

// UUID kept here for future per-file task attachment validation; exported to
// avoid dead-code warnings in strict lint configurations.
export const MULTIPART_UUID = UUID;
