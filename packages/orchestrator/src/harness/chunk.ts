// ── Chunked resume (H6a, ④) ─────────────────────────────────
// A long worker task is split into step-bounded segments that resume the same
// Harness session. Fresh hints are injected at each segment boundary, which is
// how the control plane steers a running task without an interactive SDK.

export interface ChunkDecisionInput {
  /** Configured segment step budget (0 disables chunking). */
  chunkStepBudget: number;
  /** The task's own step limit (0 = unlimited). */
  taskMaxSteps: number;
  limitReason?: string;
  chunksRun: number;
  maxChunks: number;
  remainingMs: number;
}

export function isChunkingEnabled(chunkStepBudget: number, taskMaxSteps: number): boolean {
  return chunkStepBudget > 0 && taskMaxSteps === 0;
}

export function shouldContinueChunking(input: ChunkDecisionInput): boolean {
  if (!isChunkingEnabled(input.chunkStepBudget, input.taskMaxSteps)) return false;
  if (input.limitReason !== 'step_limit_exceeded') return false;
  if (input.chunksRun >= input.maxChunks) return false;
  return input.remainingMs > 0;
}

export function chunkMaxSteps(input: { chunkStepBudget: number; taskMaxSteps: number; segment: number; maxChunks: number }): number {
  return isChunkingEnabled(input.chunkStepBudget, input.taskMaxSteps) ? input.chunkStepBudget : input.taskMaxSteps;
}

export function chunkMaxChunksFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.SRC_AGENT_CHUNK_MAX || 8);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 8;
}

export function chunkStepsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.SRC_AGENT_CHUNK_STEPS || 0);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}
