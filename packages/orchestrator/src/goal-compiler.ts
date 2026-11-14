import type { TaskSpec } from '@src-agent/contracts';

// ── Goal Compiler ────────────────────────────────────────────
// P0: No Planner. Tasks are created directly by Goal Compiler.

export interface GoalInput {
  missionId: string;
  grantId: string;
  grantVersion: number;
  targetUrl: string;
  objective: string;
  budget?: { maxSteps?: number; maxWallClockMs?: number };
}

export function compileGoal(input: GoalInput): TaskSpec {
  return {
    id: crypto.randomUUID(),
    missionId: input.missionId,
    type: 'bootstrap',
    intentNodeId: null,
    dependsOn: [],
    grantId: input.grantId,
    grantVersion: input.grantVersion,
    budget: {
      maxSteps: input.budget?.maxSteps ?? 0,
      maxWallClockMs: input.budget?.maxWallClockMs ?? 1_200_000,
    },
    payload: {
      objective: input.objective,
      targetUrl: input.targetUrl,
    },
  };
}
