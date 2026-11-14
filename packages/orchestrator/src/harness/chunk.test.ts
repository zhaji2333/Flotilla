import { describe, expect, it } from 'vitest';
import { chunkMaxChunksFromEnv, chunkMaxSteps, chunkStepsFromEnv, isChunkingEnabled, shouldContinueChunking } from './chunk.js';

describe('chunked resume policy', () => {
  it('is enabled only with a segment budget and an unlimited task', () => {
    expect(isChunkingEnabled(8, 0)).toBe(true);
    expect(isChunkingEnabled(0, 0)).toBe(false);
    expect(isChunkingEnabled(8, 50)).toBe(false);
    expect(chunkMaxSteps({ chunkStepBudget: 8, taskMaxSteps: 0, segment: 1, maxChunks: 8 })).toBe(8);
  });

  it('continues only after a step limit, within the chunk and time budgets', () => {
    const base = { chunkStepBudget: 8, taskMaxSteps: 0, chunksRun: 1, maxChunks: 8, remainingMs: 60_000 };
    expect(shouldContinueChunking({ ...base, limitReason: 'step_limit_exceeded' })).toBe(true);
    expect(shouldContinueChunking({ ...base, limitReason: 'run_timeout' })).toBe(false);
    expect(shouldContinueChunking({ ...base, limitReason: undefined })).toBe(false);
    expect(shouldContinueChunking({ ...base, limitReason: 'step_limit_exceeded', chunksRun: 8 })).toBe(false);
    expect(shouldContinueChunking({ ...base, limitReason: 'step_limit_exceeded', remainingMs: 0 })).toBe(false);
  });

  it('reads env overrides with sane fallbacks', () => {
    expect(chunkStepsFromEnv({})).toBe(0);
    expect(chunkStepsFromEnv({ SRC_AGENT_CHUNK_STEPS: '6' })).toBe(6);
    expect(chunkStepsFromEnv({ SRC_AGENT_CHUNK_STEPS: 'nope' })).toBe(0);
    expect(chunkMaxChunksFromEnv({ SRC_AGENT_CHUNK_MAX: '3' })).toBe(3);
    expect(chunkMaxChunksFromEnv({})).toBe(8);
  });
});
