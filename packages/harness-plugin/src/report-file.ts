import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { FindingRecord } from './findings.js';
import type { AssetRecord, TrafficRecord } from './store.js';
import type { MissionSummary } from '@src-agent/contracts';

// ── Task report file ────────────────────────────────────────
// The plugin cannot write to PostgreSQL itself (the control plane owns the data
// layer). Instead it maintains an atomic JSON snapshot next to the workspace;
// the worker process reads it after the Harness run and persists evidence and
// findings through the normal repository transaction.

export interface TaskReportFile {
  version: 1;
  missionId: string;
  taskId: string;
  targetUrl: string;
  artifacts: string[];
  findings: FindingRecord[];
  /** Every recorded exchange, so a settlement/retry run can cite existing ids. */
  traffic: TrafficRecord[];
  assets: AssetRecord[];
  summary?: MissionSummary;
  updatedAt: string;
}

export interface TaskReportState {
  missionId: string;
  taskId: string;
  targetUrl: string;
  artifacts: string[];
  findings: FindingRecord[];
  traffic: TrafficRecord[];
  assets: AssetRecord[];
  summary?: MissionSummary;
}

export function buildReportSnapshot(state: TaskReportState): TaskReportFile {
  return {
    version: 1,
    missionId: state.missionId,
    taskId: state.taskId,
    targetUrl: state.targetUrl,
    artifacts: [...new Set(state.artifacts)],
    findings: state.findings,
    // Full trail (also used to resume after a timeout/retry).
    traffic: state.traffic,
    assets: state.assets,
    ...(state.summary ? { summary: state.summary } : {}),
    updatedAt: new Date().toISOString(),
  };
}

export async function loadReportFile(path: string): Promise<TaskReportFile | null> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as TaskReportFile;
    if (!raw || raw.version !== 1) return null;
    return raw;
  } catch {
    return null;
  }
}

/** Atomically writes the snapshot so a crash never leaves a half-written file. */
export async function writeReportFile(path: string, report: TaskReportFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await rename(temporary, path);
}
