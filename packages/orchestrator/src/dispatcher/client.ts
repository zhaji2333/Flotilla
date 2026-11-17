import type { TraceEntry } from '../harness/trace.js';
import type { RequestFingerprintInput } from '@src-agent/contracts';
import type { RuntimeSettings } from '@src-agent/control-plane';
import type {
  ClaimedTask,
  SchedulerTickResult,
} from '../repositories/worker-repository.js';
import type { WatchdogTickResult } from '../repositories/watchdog-repository.js';
import type {
  DispatcherFinishResponse,
  DispatcherHandoffDigestResponse,
  DispatcherHintsResponse,
  DispatcherMissionContextResponse,
  DispatcherModelConfigResponse,
  DispatcherOkResponse,
  DispatcherPriorWorkResponse,
  DispatcherRequestIndexResponse,
  DispatcherRuntimeSettingsResponse,
  DispatcherTaskStateResponse,
  RetryGuardResult,
  DispatcherTraceResponse,
  FinishTaskRequest,
  PriorWorkResult,
  SafeModelConfig,
} from './protocol.js';

export class DispatcherLeaseLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DispatcherLeaseLostError';
  }
}

export class DispatcherUnavailableError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'DispatcherUnavailableError';
  }
}

interface DispatcherClientOptions {
  baseUrl?: string;
  token?: string;
  timeoutMs?: number;
}

/**
 * HTTP-only controller client. Every method here maps to a trusted dispatcher
 * operation; the worker process has no database credentials or pg imports on
 * its execution path.
 */
export class DispatcherClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(options: DispatcherClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? process.env.DISPATCHER_URL ?? 'http://dispatcher:9300').replace(/\/+$/, '');
    this.token = options.token ?? process.env.DISPATCHER_TOKEN ?? '';
    this.timeoutMs = options.timeoutMs ?? Number(process.env.DISPATCHER_TIMEOUT_MS || 120_000);
  }

  private async call<T>(path: string, body: Record<string, unknown> = {}, timeoutMs = this.timeoutMs): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.token ? { 'x-dispatcher-token': this.token } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new DispatcherUnavailableError(`dispatcher unavailable: ${String(error)}`, error);
    }
    const text = await response.text();
    let parsed: unknown = {};
    try { parsed = text ? JSON.parse(text) : {}; } catch { /* keep raw */ }
    if (!response.ok) {
      const payload = parsed as { error?: string; code?: string };
      if (response.status === 409 && payload.code === 'fencing') {
        throw new DispatcherLeaseLostError(payload.error ?? 'task lease lost');
      }
      throw new DispatcherUnavailableError(`dispatcher ${path} failed (${response.status}): ${payload.error ?? text.slice(0, 300)}`);
    }
    return parsed as T;
  }

  async health(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/healthz`, { signal: AbortSignal.timeout(5_000) });
      return response.ok;
    } catch {
      return false;
    }
  }

  async claim(workerId: string): Promise<ClaimedTask | null> {
    return (await this.call<{ task: ClaimedTask | null }>('/internal/dispatch/claim', { workerId })).task;
  }

  async retryGuard(missionId: string, taskId: string): Promise<RetryGuardResult> {
    return await this.call<RetryGuardResult>('/internal/dispatch/retry-guard', { missionId, taskId }, 15_000);
  }

  async runtimeSettings(): Promise<RuntimeSettings> {
    return (await this.call<DispatcherRuntimeSettingsResponse>('/internal/dispatch/runtime-settings', {}, 15_000)).settings;
  }

  async schedulerTick(): Promise<SchedulerTickResult> {
    return await this.call<SchedulerTickResult>('/internal/dispatch/scheduler-tick', {});
  }

  async watchdogTick(): Promise<WatchdogTickResult> {
    return await this.call<WatchdogTickResult>('/internal/dispatch/watchdog-tick', {});
  }

  async taskState(taskId: string, fencingToken: number): Promise<string> {
    return (await this.call<DispatcherTaskStateResponse>('/internal/dispatch/tasks/state', { taskId, fencingToken }, 15_000)).state;
  }

  async startTask(taskId: string, workerId: string, fencingToken: number): Promise<void> {
    await this.call<DispatcherOkResponse>('/internal/dispatch/tasks/start', { taskId, workerId, fencingToken });
  }

  async heartbeat(taskId: string, fencingToken: number): Promise<void> {
    await this.call<DispatcherOkResponse>('/internal/dispatch/tasks/heartbeat', { taskId, fencingToken }, 15_000);
  }

  async claimHints(missionId: string, taskId: string, limit = 8): Promise<DispatcherHintsResponse['hints']> {
    return (await this.call<DispatcherHintsResponse>('/internal/dispatch/hints/claim', { missionId, taskId, limit })).hints;
  }

  async recordEvent(missionId: string, eventType: string, aggregateId: string, payload: Record<string, unknown>): Promise<void> {
    await this.call<DispatcherOkResponse>('/internal/dispatch/events', { missionId, eventType, aggregateId, payload });
  }

  async finishTask(input: FinishTaskRequest): Promise<DispatcherFinishResponse> {
    return await this.call<DispatcherFinishResponse>('/internal/dispatch/tasks/finish', input as unknown as Record<string, unknown>, 180_000);
  }

  async recordTrace(missionId: string, taskId: string, entries: readonly TraceEntry[]): Promise<number> {
    if (entries.length === 0) return 0;
    return (await this.call<DispatcherTraceResponse>('/internal/dispatch/traces', {
      missionId, taskId, subjectType: 'worker', subjectId: taskId, entries,
    }, 180_000)).inserted;
  }

  async upsertRequestIndex(missionId: string, taskId: string, fingerprints: readonly RequestFingerprintInput[]): Promise<number> {
    if (fingerprints.length === 0) return 0;
    return (await this.call<DispatcherRequestIndexResponse>('/internal/dispatch/request-index', {
      missionId, taskId, fingerprints,
    }, 180_000)).inserted;
  }

  async getModelConfig(): Promise<SafeModelConfig | null> {
    return (await this.call<DispatcherModelConfigResponse>('/internal/dispatch/model-config', {})).config;
  }

  async getMissionContext(missionId: string, taskId: string, options: { maxBytes?: number; briefMaxChars?: number }): Promise<DispatcherMissionContextResponse['context']> {
    return (await this.call<DispatcherMissionContextResponse>('/internal/dispatch/mission-context', {
      missionId, taskId, maxBytes: options.maxBytes, briefMaxChars: options.briefMaxChars,
    }, 60_000)).context;
  }

  async getHandoffDigest(missionId: string, taskId: string): Promise<{ version: number; digest: string; taskId: string } | null> {
    return (await this.call<DispatcherHandoffDigestResponse>('/internal/dispatch/handoff-digest', {
      missionId, taskId,
    }, 60_000)).handoff;
  }

  async getPriorWork(missionId: string, taskId: string, options: { taskLimit?: number; maxDigestChars?: number }): Promise<PriorWorkResult | null> {
    return (await this.call<DispatcherPriorWorkResponse>('/internal/dispatch/prior-work', {
      missionId, taskId, taskLimit: options.taskLimit, maxDigestChars: options.maxDigestChars,
    }, 60_000)).priorWork;
  }
}
