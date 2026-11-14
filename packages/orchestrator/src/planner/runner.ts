import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildHarnessPatchForConfig } from '../harness/patch.js';
import { applyModelOverride, loadHarnessRuntimeConfig, type ModelRuntimeOverride } from '../harness/config.js';
import { reasoningOverrideFromEnv, runHarnessProcess } from '../harness/runner.js';
import type { TokenUsage } from '../harness/events.js';
import { buildPlannerPrompt } from './prompt.js';
import { appendTrace, traceFromCliLine, type TraceEntry } from '../harness/trace.js';
import { parsePlan } from './plan.js';
import { PlannerPlanError, type PlannerPlan, type PlannerSignal, type PlannerSnapshot } from './types.js';

// ── Planner reason run ──────────────────────────────────────
// One Planner pass = one short Harness run with a read-only control-plane
// snapshot and a single submit_plan tool. The orchestrator validates and
// applies the returned plan; the model never writes the database itself.

export interface PlannerReasonResult {
  plan: PlannerPlan;
  sessionId?: string;
  steps: number;
  tokens: TokenUsage;
  finalText: string;
  trace: TraceEntry[];
}

export interface PlannerReasonConfig {
  maxSteps: number;
  maxWallClockMs: number;
}

const PLANNER_MAX_STEPS = 40;
const PLANNER_WALL_CLOCK_MS = 10 * 60_000;

function runDirFor(runId: string): string {
  return join(tmpdir(), 'src-agent-planner', runId);
}

export async function cleanupPlannerRunDir(runId: string): Promise<void> {
  await rm(runDirFor(runId), { recursive: true, force: true }).catch(() => undefined);
}

export async function runPlannerReason(input: {
  runId: string;
  missionId: string;
  owner: string;
  snapshot: PlannerSnapshot;
  signals: readonly PlannerSignal[];
  limits?: Partial<PlannerReasonConfig>;
  /** P3-B2 DB-backed model profile override. */
  modelConfig?: ModelRuntimeOverride;
}): Promise<PlannerReasonResult> {
  const config = applyModelOverride(loadHarnessRuntimeConfig(), input.modelConfig);
  const runDir = runDirFor(input.runId);
  const statePath = join(runDir, 'state.json');
  const planPath = join(runDir, 'plan.json');
  await mkdir(join(runDir, 'workspace'), { recursive: true });
  await mkdir(join(runDir, 'dsh-home'), { recursive: true });
  await writeFile(join(runDir, 'patch.json'), buildHarnessPatchForConfig(config, reasoningOverrideFromEnv(process.env)), 'utf8');
  await writeFile(
    statePath,
    JSON.stringify(
      {
        mission: input.snapshot.mission,
        signals: input.signals,
        tasks: input.snapshot.tasks,
        findings: input.snapshot.findings,
        assets: input.snapshot.assets,
        todo: input.snapshot.todo,
        frontier: input.snapshot.frontier,
      },
      null,
      2,
    ),
    'utf8',
  );

  const trace: TraceEntry[] = [];
  let traceSeq = 0;
  const result = await runHarnessProcess({
    config,
    runDir,
    label: `planner:${input.runId}`,
    onTraceLine: (line: string) => {
      appendTrace(trace, traceFromCliLine(line, traceSeq));
      traceSeq += 1;
    },
    prompt: buildPlannerPrompt(input.snapshot, input.signals),
    maxSteps: input.limits?.maxSteps ?? PLANNER_MAX_STEPS,
    maxWallClockMs: input.limits?.maxWallClockMs ?? PLANNER_WALL_CLOCK_MS,
    env: {
      SRC_AGENT_ROLE: 'planner',
      SRC_AGENT_MISSION_ID: input.missionId,
      SRC_AGENT_TASK_ID: input.runId,
      SRC_AGENT_PLANNER_STATE_PATH: statePath,
      SRC_AGENT_PLANNER_PLAN_PATH: planPath,
      ...(input.modelConfig?.apiKey ? { [config.apiKeyEnv]: input.modelConfig.apiKey } : {}),
    },
  });

  if (result.limitReason) {
    throw new PlannerPlanError(`planner run hit ${result.limitReason} before submitting a plan`);
  }

  let rawPlan: unknown;
  try {
    rawPlan = JSON.parse(await readFile(planPath, 'utf8'));
  } catch {
    rawPlan = parseJsonFromText(result.summary.finalText);
    if (rawPlan === undefined) {
      throw new PlannerPlanError(
        `planner did not submit a plan (no plan.json; finalText=${result.summary.finalText.slice(0, 500)})`,
      );
    }
  }
  const plan = parsePlan(rawPlan);
  await cleanupPlannerRunDir(input.runId);
  return {
    plan,
    sessionId: result.summary.sessionId,
    steps: result.summary.steps,
    tokens: result.summary.tokenUsage,
    finalText: result.summary.finalText,
    trace,
  };
}

function parseJsonFromText(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}
