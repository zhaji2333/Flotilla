import type { MissionSummary } from '@src-agent/contracts';
import type { MissionContext } from '@src-agent/control-plane';
import type { RuntimeSettings } from '@src-agent/control-plane';
import type { TraceEntry } from '../harness/trace.js';
import type {
  AssetInput,
  ClaimedHint,
  ClaimedTask,
  EvidenceInput,
  FindingInput,
  SchedulerTickResult,
} from '../repositories/worker-repository.js';
import type { WatchdogTickResult } from '../repositories/watchdog-repository.js';

// ── Dispatcher protocol ────────────────────────────────────
// The Worker no longer owns database credentials. It sends only a small,
// authenticated HTTP command to this trusted dispatcher; every SQL write and
// scheduler transition happens inside the dispatcher process.

export interface FinishTaskRequest {
  taskId: string;
  missionId: string;
  workerId: string;
  fencingToken: number;
  attempt: number;
  status: 'done' | 'failed' | 'handed_back';
  completed: boolean;
  failureClass?: string;
  result: Record<string, unknown>;
  evidence: EvidenceInput[];
  findings: FindingInput[];
  assets?: AssetInput[];
  summary?: MissionSummary;
}

export interface RetryGuardResult {
  requiresConfirmation: boolean;
  actionCount: number;
}

export interface DispatcherRuntimeSettingsResponse {
  settings: RuntimeSettings;
}

export interface SafeModelConfig {
  id: string;
  name: string;
  modelName: string;
  contextWindow: number;
  maxOutputTokens: number;
  reasoningEffort: 'low' | 'high' | 'max' | null;
  compat: Record<string, unknown>;
  role: string | null;
  tier: string | null;
}

export interface PriorWorkResult {
  digest: string;
  tasks: number;
}

export interface TraceRecordRequest {
  missionId: string;
  taskId?: string | null;
  subjectType: 'worker' | 'planner';
  subjectId: string;
  entries: readonly TraceEntry[];
}

export interface DispatcherHello {
  ok: true;
  version: string;
}

export type DispatcherClaimResponse = { task: ClaimedTask | null };
export type DispatcherModelConfigResponse = { config: SafeModelConfig | null };
export type DispatcherMissionContextResponse = { context: MissionContext | null };
export type DispatcherPriorWorkResponse = { priorWork: PriorWorkResult | null };
export type DispatcherHandoffDigestResponse = { handoff: { version: number; digest: string; taskId: string } | null };
export type DispatcherTickResponse = SchedulerTickResult;
export type DispatcherWatchdogResponse = WatchdogTickResult;
export type DispatcherHintsResponse = { hints: ClaimedHint[] };
export type DispatcherFinishResponse = { duplicate: boolean };
export type DispatcherTraceResponse = { inserted: number };
export type DispatcherRequestIndexResponse = { inserted: number };
export type DispatcherOkResponse = { ok: true };
export type DispatcherTaskStateResponse = { state: string };
