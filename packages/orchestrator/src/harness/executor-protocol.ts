import type { ModelRuntimeOverride } from './config.js';
import type { HarnessRunOutcome } from './runner.js';
import type { WorkerTask } from './types.js';

// ── Worker ↔ executor protocol ──────────────────────────────
// The executor runs the Harness agent; the worker controller owns DB writes,
// hints, retries and fencing. The protocol carries only one task attempt and
// returns paths to files on the shared run volume.

export interface ExecutorJobOptions {
  sessionId?: string;
  recoveryNote?: string;
  keepRunDir?: boolean;
  hints?: readonly string[];
  priorWork?: string;
  missionBrief?: string;
  missionContextPath?: string;
  requestIndexPath?: string;
  modelConfig?: ModelRuntimeOverride;
  llmApiKey?: string;
  attempt?: number;
  runtime?: 'cli' | 'inprocess';
  hintFilePath?: string;
  traceSearchEnabled?: boolean;
  requestDedupeMode?: 'off' | 'warn';
}

export interface ExecutorJob {
  jobId: string;
  taskId: string;
  attempt: number;
  task: WorkerTask;
  options: ExecutorJobOptions;
}

export interface ExecutorResponse {
  ok: boolean;
  outcomePath?: string;
  tracePath?: string;
  error?: string;
}

/** The outcome file omits the trace; the trace is a separate shared file. */
export type ExecutorOutcomeFile = Omit<HarnessRunOutcome, 'trace'>;
