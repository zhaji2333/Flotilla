import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MissionTarget } from '@src-agent/contracts';
import { buildRecoveryNote } from '../harness/assignment.js';
import type { ModelRuntimeOverride } from '../harness/config.js';
import { isTransientFailure, retryBackoffMs, TRANSIENT_TRIES } from '../harness/retry.js';
import { cleanupRunDir, runDirFor, runHarnessTask } from '../harness/runner.js';
import { cancelRemoteTask, ExecutorCancelledError } from '../harness/remote-executor.js';
import type { HarnessRunOutcome } from '../harness/runner.js';
import type { WorkerTask } from '../harness/types.js';
import type { ClaimedTask } from '../repositories/worker-repository.js';
import type { SafeModelConfig } from '../dispatcher/protocol.js';
import { DispatcherClient, DispatcherLeaseLostError } from '../dispatcher/client.js';
import { requestFingerprintsFromTrace } from '../repositories/request-index.js';
import { StormGuard } from './storm-guard.js';

// ── Worker entrypoint (dispatcher-only controller) ──────────
// This process has no PostgreSQL credentials and no pg runtime dependency on
// its execution path. It claims one task at a time through the trusted
// dispatcher HTTP API, runs the Agent in the independent executor container,
// then sends the bounded result back to the dispatcher for persistence.

const WORKER_ID =
  process.env.WORKER_ID ||
  `${process.env.HOSTNAME ? `${process.env.HOSTNAME}-` : 'worker-'}${process.pid}`;
const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS || 3_000);
const TRANSIENT_ATTEMPTS = Math.max(1, Number(process.env.WORKER_TRANSIENT_TRIES || TRANSIENT_TRIES));
const PRIOR_WORK_ENABLED = process.env.PRIOR_WORK_ENABLED !== '0';
const PRIOR_WORK_MAX_CHARS = Math.max(200, Number(process.env.PRIOR_WORK_MAX_CHARS || 1_500) || 1_500);
const PRIOR_WORK_TASK_LIMIT = Math.max(1, Math.min(50, Number(process.env.PRIOR_WORK_TASK_LIMIT || 6) || 6));
const MISSION_CONTEXT_MAX_BYTES = Math.max(16_000, Number(process.env.MISSION_CONTEXT_MAX_BYTES || 524_288) || 524_288);
const MISSION_BRIEF_MAX_CHARS = Math.max(500, Number(process.env.MISSION_BRIEF_MAX_CHARS || 2_500) || 2_500);
const HINT_POLL_MS = Math.max(500, Number(process.env.SRC_AGENT_HINT_POLL_MS || 2_500) || 2_500);
const stormGuard = new StormGuard({
  threshold: Number(process.env.WORKER_STORM_GUARD_THRESHOLD || 4),
  baseMs: Number(process.env.WORKER_STORM_GUARD_BASE_MS || 5_000),
  maxMs: Number(process.env.WORKER_STORM_GUARD_MAX_MS || 60_000),
});

const dispatcher = new DispatcherClient();

class TaskCancelledError extends Error {
  constructor(taskId: string) {
    super(`task ${taskId} was cancelled by an operator`);
    this.name = 'TaskCancelledError';
  }
}

async function stormPause(missionId?: string, taskId?: string): Promise<void> {
  const failures = stormGuard.recordFailure();
  const delay = stormGuard.delayMs();
  if (delay === 0) return;
  log(`storm guard tripped after ${failures} consecutive failures; pausing ${delay}ms`);
  if (missionId) {
    await dispatcher.recordEvent(missionId, 'worker.storm_guard', taskId ?? 'worker', {
      consecutiveFailures: failures,
      delayMs: delay,
      threshold: Number(process.env.WORKER_STORM_GUARD_THRESHOLD || 4),
    }).catch(() => undefined);
  }
  await sleep(delay);
}

function hintLine(hint: { content: string; kind?: string }): string {
  return hint.kind && hint.kind !== 'guidance' ? `[${hint.kind}] ${hint.content}` : hint.content;
}

async function main(): Promise<void> {
  await waitForDispatcher();
  log('ready (dispatcher-only controller)');

  let running = true;
  process.on('SIGINT', () => { running = false; });
  process.on('SIGTERM', () => { running = false; });

  let tick = 0;
  // eslint-disable-next-line no-unmodified-loop-condition -- stops via the SIGINT/SIGTERM handler above
  while (running) {
    let claimed: ClaimedTask | null = null;
    try {
      if (tick % 4 === 0) {
        const result = await dispatcher.schedulerTick();
        if (result.expired + result.promoted + result.blocked > 0) {
          log(`scheduler tick: expired=${result.expired} promoted=${result.promoted} blocked=${result.blocked}`);
        }
      }
      if (process.env.WATCHDOG_ENABLED !== '0' && tick % 8 === 0) {
        const watchdog = await dispatcher.watchdogTick().catch(error => {
          log(`watchdog tick failed: ${String(error)}`);
          return { observations: 0, hints: 0 };
        });
        if (watchdog.observations > 0) log(`watchdog: observations=${watchdog.observations} hints=${watchdog.hints}`);
      }
      tick += 1;
      claimed = await dispatcher.claim(WORKER_ID);
    } catch (error) {
      log(`claim failed: ${String(error)}`);
      await stormPause();
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    if (!claimed) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    await runTask(claimed);
  }

  log('worker stopped');
}

async function runTask(claimed: ClaimedTask): Promise<void> {
  const target = baseUrlForTarget(claimed.mission.target);
  log(
    `claimed task ${claimed.taskId} mission=${claimed.missionId} attempt=${claimed.attempt} ` +
      `fencing=${claimed.fencingToken} target=${target}`,
  );
  await dispatcher.startTask(claimed.taskId, WORKER_ID, claimed.fencingToken);
  const heartbeat = setInterval(() => {
    dispatcher.heartbeat(claimed.taskId, claimed.fencingToken).catch(error => {
      log(`heartbeat rejected task ${claimed.taskId}: ${String(error)}`);
    });
  }, 60_000);

  // Hard cancellation: the API marks the task cancelled; the worker notices it
  // while the executor is running, aborts the local fetch and asks the executor
  // to kill the Harness child. Late outcomes are never finished into the DB.
  const cancelController = new AbortController();
  let cancelObserved = false;
  const cancelWatcher = setInterval(() => {
    if (cancelObserved || cancelController.signal.aborted) return;
    void dispatcher.taskState(claimed.taskId, claimed.fencingToken).then(state => {
      if (state !== 'cancelled' || cancelObserved) return;
      cancelObserved = true;
      log(`task ${claimed.taskId} cancelled by operator; hard-cancelling executor job attempt ${claimed.attempt}`);
      void dispatcher.recordEvent(claimed.missionId, 'task.cancel_observed', claimed.taskId, {
        attempt: claimed.attempt,
        source: 'worker-cancel-watcher',
      }).catch(() => undefined);
      void cancelRemoteTask(claimed.taskId, claimed.attempt);
      // The cancel may race the executor's job registration; retry once.
      setTimeout(() => { void cancelRemoteTask(claimed.taskId, claimed.attempt); }, 2_000).unref?.();
      cancelController.abort();
    }).catch(() => undefined);
  }, 2_000);

  const runtimeSettings = await dispatcher.runtimeSettings().catch(error => {
    log(`runtime settings unavailable, using deployment defaults: ${String(error)}`);
    return null;
  });
  const missionContextEnabled = runtimeSettings?.['worker.missionContextEnabled']
    ?? (process.env.MISSION_CONTEXT_ENABLED !== '0');
  const traceSearchEnabled = runtimeSettings?.['worker.traceSearchEnabled']
    ?? (process.env.SRC_AGENT_TRACE_SEARCH_ENABLED !== '0');
  const requestDedupeMode = runtimeSettings?.['worker.requestDedupeMode']
    ?? (process.env.REQUEST_DEDUPE_MODE === 'off' ? 'off' : 'warn');

  const task: WorkerTask = {
    missionId: claimed.missionId,
    objective: claimed.mission.objective,
    targetUrl: target,
    scope: claimed.scope,
    maxSteps: claimed.budget.maxSteps,
    maxWallClockMs: claimed.budget.maxWallClockMs,
    methodology: typeof claimed.payload.methodology === 'string' ? claimed.payload.methodology : undefined,
    ...(typeof claimed.payload.angle === 'string' ? { angle: claimed.payload.angle } : {}),
    ...(Array.isArray(claimed.payload.artifactIds)
      ? { artifactIds: claimed.payload.artifactIds.filter((value): value is string => typeof value === 'string') }
      : {}),
    ...(claimed.type === 'summary' ? { summary: true } : {}),
  };

  try {
    const durableRecovery = claimed.attempt > 1
      ? buildRecoveryNote(claimed.attempt, claimed.lastError ?? 'previous attempt was interrupted')
      : undefined;
    const hints = await dispatcher.claimHints(claimed.missionId, claimed.taskId).catch(() => []);
    if (hints.length > 0) {
      log(`injecting ${hints.length} control-plane hint(s) into task ${claimed.taskId}`);
      await dispatcher.recordEvent(claimed.missionId, 'task.hints_delivered', claimed.taskId, {
        count: hints.length,
        hintIds: hints.map(hint => hint.id),
      }).catch(() => undefined);
    }
    const pullHints = async (): Promise<string[]> => {
      const items = await dispatcher.claimHints(claimed.missionId, claimed.taskId).catch(() => []);
      if (items.length > 0) {
        log(`steering ${items.length} control-plane hint(s) into task ${claimed.taskId}`);
        await dispatcher.recordEvent(claimed.missionId, 'task.hints_steered', claimed.taskId, {
          count: items.length,
          hintIds: items.map(item => item.id),
        }).catch(() => undefined);
      }
      return items.map(item => hintLine(item));
    };
    // Prior work and model config are computed by the dispatcher; neither the
    // raw provider key nor any SQL row crosses into this process.
    const priorWork = PRIOR_WORK_ENABLED
      ? await dispatcher.getPriorWork(claimed.missionId, claimed.taskId, {
          taskLimit: PRIOR_WORK_TASK_LIMIT,
          maxDigestChars: PRIOR_WORK_MAX_CHARS,
        }).catch(error => {
          log(`prior-work digest unavailable for task ${claimed.taskId}: ${String(error)}`);
          return null;
        })
      : null;
    if (priorWork) {
      log(`injecting prior-work digest (${priorWork.digest.length} chars, ${priorWork.tasks} task(s)) into task ${claimed.taskId}`);
      await dispatcher.recordEvent(claimed.missionId, 'task.prior_work_injected', claimed.taskId, {
        chars: priorWork.digest.length,
        tasks: priorWork.tasks,
      }).catch(() => undefined);
    }
    const modelConfig = await dispatcher.getModelConfig().catch(error => {
      log(`model config lookup failed, using env route: ${String(error)}`);
      return null;
    });
    const modelOverride = buildModelOverride(modelConfig);
    if (modelConfig) {
      log(`using DB model config ${modelConfig.name} (${modelConfig.id}) for task ${claimed.taskId}`);
      await dispatcher.recordEvent(claimed.missionId, 'task.model_config_applied', claimed.taskId, {
        configId: modelConfig.id,
        name: modelConfig.name,
        model: modelConfig.modelName,
      }).catch(() => undefined);
    }
    let missionBrief: string | undefined;
    let missionContextPath: string | undefined;
    let requestIndexPath: string | undefined;
    if (missionContextEnabled) {
      const context = await dispatcher.getMissionContext(claimed.missionId, claimed.taskId, {
        maxBytes: MISSION_CONTEXT_MAX_BYTES,
        briefMaxChars: MISSION_BRIEF_MAX_CHARS,
      }).catch(error => {
        log(`mission context unavailable for task ${claimed.taskId}: ${String(error)}`);
        return null;
      });
      if (context) {
        const dir = runDirFor(claimed.taskId);
        await mkdir(dir, { recursive: true }).catch(() => undefined);
        missionContextPath = join(dir, 'mission-context.json');
        await writeFile(missionContextPath, JSON.stringify(context), 'utf8').catch(error => {
          log(`mission context write failed for task ${claimed.taskId}: ${String(error)}`);
          missionContextPath = undefined;
        });
        missionBrief = context.brief;
        requestIndexPath = join(dir, 'request-index.json');
        await writeFile(requestIndexPath, JSON.stringify(context.requestIndex), 'utf8').catch(error => {
          log(`request index write failed for task ${claimed.taskId}: ${String(error)}`);
          requestIndexPath = undefined;
        });
        await dispatcher.recordEvent(claimed.missionId, 'task.mission_brief_injected', claimed.taskId, {
          bytes: Buffer.byteLength(JSON.stringify(context), 'utf8'),
          facts: context.facts.length,
          findings: context.findings.length,
          workerTraces: context.workerTraces.length,
          truncated: context.truncated ?? false,
        }).catch(() => undefined);
      }
    }
    const hintFileBase = join(runDirFor(claimed.taskId), 'steering-hints');
    const outcome = await runWithRetries(
      claimed,
      task,
      durableRecovery,
      hints.map(hint => hintLine(hint)),
      pullHints,
      priorWork?.digest,
      missionBrief,
      missionContextPath,
      requestIndexPath,
      modelOverride,
      {
        traceSearchEnabled,
        requestDedupeMode,
        fullDuplex: !task.summary && Boolean(process.env.SRC_AGENT_EXECUTOR_URL?.trim()),
        hintFileBase,
      },
      cancelController.signal,
    );
    if (cancelObserved || cancelController.signal.aborted || outcome.failureClass === 'cancelled') {
      throw new TaskCancelledError(claimed.taskId);
    }
    if (outcome.trace && outcome.trace.length > 0) {
      await dispatcher.recordTrace(claimed.missionId, claimed.taskId, outcome.trace)
        .catch(error => log(`trace persist failed for ${claimed.taskId}: ${String(error)}`));
      const fingerprints = requestFingerprintsFromTrace(outcome.trace);
      if (fingerprints.length > 0) {
        await dispatcher.upsertRequestIndex(claimed.missionId, claimed.taskId, fingerprints)
          .catch(error => log(`request index persist failed for ${claimed.taskId}: ${String(error)}`));
      }
    }
    const completed = outcome.completed || (task.summary === true && Boolean(outcome.summary));
    await dispatcher.finishTask({
      taskId: claimed.taskId,
      missionId: claimed.missionId,
      workerId: WORKER_ID,
      fencingToken: claimed.fencingToken,
      attempt: claimed.attempt,
      status: completed ? 'done' : 'failed',
      completed,
      failureClass: outcome.failureClass,
      result: {
        steps: outcome.steps,
        tokens: outcome.tokenUsage,
        artifacts: outcome.artifacts,
        sessionId: outcome.sessionId,
        finalText: outcome.finalText.slice(0, 2_000),
        ...(outcome.error ? { error: outcome.error.slice(0, 2_000) } : {}),
      },
      evidence: outcome.evidence,
      findings: outcome.findings,
      assets: outcome.assets,
      ...(outcome.summary ? { summary: outcome.summary } : {}),
    });
    log(
      `finished task ${claimed.taskId} completed=${outcome.completed} artifacts=${outcome.artifacts.length} ` +
        `steps=${outcome.steps} ` +
        `tokens=${outcome.tokenUsage.total} findings=${outcome.findings.length} evidence=${outcome.evidence.length} ` +
        `assets=${outcome.assets.length}` +
        `${outcome.failureClass ? ` failure=${outcome.failureClass}` : ''}` +
        `${outcome.sessionId ? ` session=${outcome.sessionId}` : ''}`,
    );
    for (const artifact of outcome.artifacts) log(`artifact: ${artifact}`);
    if (outcome.error) log(`run error: ${outcome.error.split('\n')[0]}`);
    if (outcome.completed) stormGuard.recordSuccess();
    else await stormPause(claimed.missionId, claimed.taskId);
  } catch (error) {
    if (cancelObserved || cancelController.signal.aborted || error instanceof TaskCancelledError || error instanceof ExecutorCancelledError) {
      log(`task ${claimed.taskId} cancelled; dropping in-flight outcome`);
      await cleanupRunDir(claimed.taskId).catch(() => undefined);
      return;
    }
    if (error instanceof DispatcherLeaseLostError) {
      log(`task ${claimed.taskId} lost its lease; dropping report`);
      return;
    }
    log(`task ${claimed.taskId} crashed: ${String(error)}`);
    await dispatcher.finishTask({
      taskId: claimed.taskId,
      missionId: claimed.missionId,
      workerId: WORKER_ID,
      fencingToken: claimed.fencingToken,
      attempt: claimed.attempt,
      status: 'failed',
      completed: false,
      failureClass: 'model_error',
      result: { error: String(error) },
      evidence: [],
      findings: [],
      assets: [],
    }).catch(finishError => log(`failed to report crashed task ${claimed.taskId}: ${String(finishError)}`));
    await stormPause(claimed.missionId, claimed.taskId);
  } finally {
    clearInterval(heartbeat);
    clearInterval(cancelWatcher);
  }
}

async function runWithRetries(
  claimed: ClaimedTask,
  task: WorkerTask,
  initialRecoveryNote?: string,
  initialHints: readonly string[] = [],
  pullHints?: () => Promise<readonly string[]>,
  priorWork?: string,
  missionBrief?: string,
  missionContextPath?: string,
  requestIndexPath?: string,
  modelConfig?: ModelRuntimeOverride,
  runtime?: { traceSearchEnabled: boolean; requestDedupeMode: 'off' | 'warn'; fullDuplex: boolean; hintFileBase?: string },
  signal?: AbortSignal,
): Promise<HarnessRunOutcome> {
  let sessionId: string | undefined;
  let recoveryNote: string | undefined = initialRecoveryNote;
  let hints: readonly string[] = initialHints;
  let outcome: HarnessRunOutcome | undefined;
  for (let attempt = 1; attempt <= TRANSIENT_ATTEMPTS; attempt += 1) {
    if (signal?.aborted) throw new TaskCancelledError(claimed.taskId);
    if (attempt > 1 && pullHints) {
      const fresh = await pullHints().catch(() => []);
      hints = [...hints, ...fresh];
    }
    // Remote executor full-duplex channel: this worker keeps claiming hints and
    // appends them to a shared file; the executor's in-process runtime reads the
    // new lines and calls agent.steer() before the next tool call.
    const hintFilePath = runtime?.fullDuplex && runtime.hintFileBase
      ? `${runtime.hintFileBase}-${attempt}.jsonl`
      : undefined;
    let hintPump: NodeJS.Timeout | undefined;
    if (hintFilePath && pullHints) {
      await mkdir(runDirFor(claimed.taskId), { recursive: true }).catch(() => undefined);
      await writeFile(hintFilePath, '', 'utf8').catch(() => undefined);
      let pumping = false;
      hintPump = setInterval(() => {
        if (pumping) return;
        pumping = true;
        void pullHints()
          .then(async items => {
            for (const item of items) await appendFile(hintFilePath, `${JSON.stringify(item)}\n`, 'utf8');
          })
          .catch(() => undefined)
          .finally(() => { pumping = false; });
      }, HINT_POLL_MS);
      hintPump.unref?.();
    }
    try {
      outcome = await runHarnessTask(task, claimed.taskId, {
        sessionId, recoveryNote, hints, pullHints, priorWork, missionBrief, missionContextPath, requestIndexPath, modelConfig,
        attempt,
        ...(runtime ? { traceSearchEnabled: runtime.traceSearchEnabled, requestDedupeMode: runtime.requestDedupeMode } : {}),
        signal,
        ...(hintFilePath ? { runtime: 'inprocess' as const, hintFilePath } : {}),
      });
    } finally {
      if (hintPump) clearInterval(hintPump);
    }
    sessionId = outcome.sessionId ?? sessionId;
    if (outcome.completed) break;
    if (!isTransientFailure(outcome) || attempt >= TRANSIENT_ATTEMPTS) break;
    // Safety: if this attempt already wrote to the target, do not retry locally.
    // Finish this attempt as failed; schedulerTick will mark the task blocked
    // until an operator confirms the write actions via the API/UI.
    const retryGuard = await dispatcher.retryGuard(claimed.missionId, claimed.taskId).catch(() => null);
    if (retryGuard?.requiresConfirmation) {
      log(`task ${claimed.taskId} has ${retryGuard.actionCount} recorded target write action(s); local retry blocked pending confirmation`);
      await dispatcher.recordEvent(claimed.missionId, 'task.write_actions_retry_blocked', claimed.taskId, {
        actionCount: retryGuard.actionCount,
        attempt,
      }).catch(() => undefined);
      break;
    }
    const backoff = retryBackoffMs(attempt);
    const reason = outcome.error?.split('\n')[0] ?? outcome.failureClass ?? 'unknown';
    log(`transient failure on task ${claimed.taskId} (try ${attempt}/${TRANSIENT_ATTEMPTS}): ${reason}; retrying in ${backoff}ms`);
    await dispatcher.recordEvent(claimed.missionId, 'task.retry', claimed.taskId, {
      attempt,
      failureClass: outcome.failureClass ?? null,
      reason: reason.slice(0, 500),
      backoffMs: backoff,
    }).catch(() => undefined);
    await sleep(backoff);
    if (signal?.aborted) throw new TaskCancelledError(claimed.taskId);
    recoveryNote = buildRecoveryNote(attempt + 1, reason);
  }
  const finalOutcome = outcome as HarnessRunOutcome;
  if (!finalOutcome.completed) {
    await cleanupRunDir(claimed.taskId).catch(() => undefined);
  }
  return finalOutcome;
}

/**
 * The provider key never enters this process. The executor points its Harness
 * model route at the API model proxy; only the proxy token is passed as the
 * OpenAI-compatible API key.
 */
function buildModelOverride(config: SafeModelConfig | null): ModelRuntimeOverride | undefined {
  const proxyUrl = process.env.MODEL_PROXY_URL?.trim();
  if (!proxyUrl) return undefined;
  const configId = config?.id ?? 'default';
  return {
    baseUrl: `${proxyUrl.replace(/\/+$/, '')}/configs/${encodeURIComponent(configId)}`,
    apiKey: '',
    apiKeyEnv: process.env.MODEL_PROXY_TOKEN_ENV?.trim() || 'MODEL_PROXY_TOKEN',
    model: config?.modelName ?? process.env.WORKER_DEFAULT_MODEL ?? 'deepseek-flash',
    ...(config?.contextWindow ? { contextWindow: config.contextWindow } : {}),
    ...(config?.maxOutputTokens ? { maxOutputTokens: config.maxOutputTokens } : {}),
    ...(config?.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
    ...(config?.compat && Object.keys(config.compat).length > 0 ? { compat: config.compat } : {}),
  };
}

function baseUrlForTarget(target: MissionTarget): string {
  if (target.type === 'file') return 'attachment://mission';
  const value = target.value.trim();
  if (target.type === 'url') return value.replace(/\/+$/, '') || value;
  const withoutScheme = value.replace(/^[a-z]+:\/\//i, '').replace(/\/+$/, '');
  return `http://${withoutScheme}`;
}

async function waitForDispatcher(attempts = 40, delayMs = 1_000): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (await dispatcher.health()) return;
    await sleep(delayMs);
    lastError = new Error('dispatcher health check failed');
  }
  throw new Error(`dispatcher not reachable: ${String(lastError)}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function log(message: string): void {
  console.log(`[worker ${WORKER_ID}] ${message}`);
}

main().catch(error => {
  console.error('worker fatal:', error);
  process.exit(1);
});
