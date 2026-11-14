import { existsSync } from 'node:fs';
import { getActiveModelConfig } from '@src-agent/control-plane';
import { createPool, waitForDatabase } from '../db/pool.js';
import { applySchema } from '../db/schema.js';
import {
  applyPlannerPlan,
  claimPlannerJob,
  completePlannerRun,
  failPlannerRun,
  loadPlannerSnapshot,
} from './repository.js';
import { runPlannerReason } from './runner.js';
import { recordTaskTrace } from '../repositories/trace-repository.js';
import type { ModelRuntimeOverride } from '../harness/config.js';

// ── Planner entrypoint (P1-β) ──────────────────────────────
// A single-writer reasoning loop over batched signals. It acquires a mission
// lease, runs one short Harness planner pass, validates the proposed plan and
// applies it transactionally. Disabled unless PLANNER_ENABLED=1.

const OWNER = process.env.PLANNER_ID || `${process.env.HOSTNAME ? `${process.env.HOSTNAME}-` : 'planner-'}${process.pid}`;
const INTERVAL_MS = Number(process.env.PLANNER_INTERVAL_MS || 3_000);
const DEBOUNCE_MS = Number(process.env.PLANNER_DEBOUNCE_MS || 5_000);
const LEASE_MS = Number(process.env.PLANNER_LEASE_MS || 300_000);
const ONCE = process.env.PLANNER_ONCE === '1';

function log(message: string): void {
  console.log(`[planner ${OWNER}] ${message}`);
}

interface PlannerModelConfig {
  label: string;
  override: ModelRuntimeOverride;
}

/** P3-B2: DB model profile for the Planner role; falls back to env on error. */
async function loadPlannerModelConfig(pool: ReturnType<typeof createPool>): Promise<PlannerModelConfig | undefined> {
  try {
    const active = await getActiveModelConfig(pool, 'planner');
    if (!active) return undefined;
    const proxyUrl = process.env.MODEL_PROXY_URL?.trim();
    return {
      label: `${active.name} (${active.id})`,
      override: {
        baseUrl: proxyUrl ? `${proxyUrl.replace(/\/+$/, '')}/configs/${encodeURIComponent(active.id)}` : active.baseUrl,
        apiKey: '',
        model: active.modelName,
        apiKeyEnv: proxyUrl ? (process.env.MODEL_PROXY_TOKEN_ENV?.trim() || 'MODEL_PROXY_TOKEN') : active.apiKeyEnv,
        contextWindow: active.contextWindow,
        maxOutputTokens: active.maxOutputTokens,
        ...(active.reasoningEffort ? { reasoningEffort: active.reasoningEffort } : {}),
        ...(Object.keys(active.compat).length > 0 ? { compat: active.compat } : {}),
      },
    };
  } catch (error) {
    log(`model config lookup failed, using env route: ${String(error)}`);
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForProxyCa(): Promise<void> {
  const caPath = process.env.NODE_EXTRA_CA_CERTS;
  if (!caPath) return;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (existsSync(caPath)) return;
    await sleep(1_000);
  }
  throw new Error(`proxy CA certificate not available at ${caPath}`);
}

async function main(): Promise<void> {
  if (process.env.PLANNER_ENABLED !== '1') {
    log('disabled (PLANNER_ENABLED != 1)');
    return;
  }
  await waitForProxyCa();
  const pool = createPool();
  await waitForDatabase(pool);
  await applySchema(pool);
  log(`ready debounce=${DEBOUNCE_MS}ms lease=${LEASE_MS}ms interval=${INTERVAL_MS}ms once=${ONCE}`);

  let running = true;
  process.on('SIGINT', () => {
    running = false;
  });
  process.on('SIGTERM', () => {
    running = false;
  });

  // eslint-disable-next-line no-unmodified-loop-condition -- stops via the SIGINT/SIGTERM handler above
  while (running) {
    let job = null;
    try {
      job = await claimPlannerJob(pool, { owner: OWNER, debounceMs: DEBOUNCE_MS, leaseMs: LEASE_MS });
    } catch (error) {
      log(`claim failed: ${String(error)}`);
      await sleep(INTERVAL_MS);
      continue;
    }
    if (!job) {
      if (ONCE) break;
      await sleep(INTERVAL_MS);
      continue;
    }

    const started = Date.now();
    try {
      const snapshot = await loadPlannerSnapshot(pool, job.missionId);
      log(
        `reason mission=${job.missionId} run=${job.runId} signals=${job.signals.length} ` +
          `tasks=${snapshot.tasks.length} findings=${snapshot.findings.length} ` +
          `frontierFacts=${snapshot.frontier?.facts.length ?? 0} frontierIntents=${snapshot.frontier?.intents.length ?? 0}`,
      );
      const modelConfig = await loadPlannerModelConfig(pool);
      if (modelConfig) log(`using DB model config ${modelConfig.label} for run ${job.runId}`);
      const reason = await runPlannerReason({
        runId: job.runId,
        missionId: job.missionId,
        owner: OWNER,
        snapshot,
        signals: job.signals,
        modelConfig: modelConfig?.override,
      });
      await recordTaskTrace(pool, {
        missionId: job.missionId,
        taskId: null,
        subjectType: 'planner',
        subjectId: job.runId,
        entries: reason.trace,
      }).catch(error => log(`planner trace persist failed: ${String(error)}`));
      const applied = await applyPlannerPlan(pool, job, reason.plan, snapshot);
      await completePlannerRun(pool, job.runId, reason.sessionId, { steps: reason.steps, tokens: { ...reason.tokens } });
      log(
        `applied run=${job.runId} actions=${reason.plan.actions.length} ` +
          `tasks=${applied.createdTasks} todos=${applied.todos} hints=${applied.hints} ` +
          `cancelled=${applied.cancelled} in ${Date.now() - started}ms`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`failed run=${job.runId}: ${message}`);
      await failPlannerRun(pool, job, message).catch(failure => log(`requeue failed: ${String(failure)}`));
    }
    if (ONCE) break;
  }

  await pool.end();
  log('stopped');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
