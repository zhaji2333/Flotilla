import type {
  Approval,
  CreatedMission,
  CreateMissionRequest,
  CreateMissionMultipartRequest,
  FindingDetail,
  FindingLineage,
  FindingListItem,
  Health,
  Hint,
  ListResponse,
  MissionControlResult,
  TaskControlResult,
  ActionLedgerEntry,
  CreateManualTaskRequest,
  MissionDetail,
  FactsResponse,
  EvalDashboard,
  MissionAssetGraph,
  MissionOverview,
  ExploreGraph,
  MissionIntel,
  MetricsSummary,
  MissionBoard,
  MissionFrontier,
  MissionListItem,
  ModelConfig,
  ModelConfigAudit,
  ModelConfigInput,
  ModelConfigReveal,
  ModelConfigTestInput,
  ModelConfigTestResult,
  PriorWorkSummary,
  ScopeUpgradeInput,
  ScopeUpgradeResponse,
  SteeringRecord,
  SubjectType,
  TraceRow,
  WorkerTraceSearch,
  Trigger,
  AuthMe,
  AuthUser,
  RuntimeSettings,
  WatchdogDashboard,
  MissionSummary,
  AdminAuditEntry,
  MissionArtifact,
  ArtifactGcResult,
} from './types';

// Contract v1 client. VITE_API_BASE_URL is an origin (no /api suffix); an empty
// value keeps the document origin (Vite dev proxy serves /api).
const RAW_BASE = (import.meta.env.VITE_API_BASE_URL ?? '').trim();
const BASE = RAW_BASE === '' ? '' : RAW_BASE.replace(/\/+$/, '');

// Dev-only bearer. Production builds never embed a token: nginx injects the
// Authorization header server-side (see nginx.conf.template). The `DEV` guard is
// a build-time constant, so the token reference disappears from prod bundles.
const DEV_TOKEN = import.meta.env.DEV ? (import.meta.env.VITE_API_TOKEN ?? '').trim() : '';
let csrfToken = '';
export function setCsrfToken(token: string | null): void { csrfToken = token ?? ''; }
const devAuthHeaders: Record<string, string> = DEV_TOKEN ? { authorization: `Bearer ${DEV_TOKEN}` } : {};

export class ApiError extends Error {
  readonly status: number;
  readonly issues: unknown[];

  constructor(status: number, message: string, issues: unknown[] = []) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.issues = issues;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? 'GET').toUpperCase();
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    credentials: 'same-origin',
    headers: {
      'content-type': 'application/json',
      ...devAuthHeaders,
      ...(method !== 'GET' && method !== 'HEAD' && csrfToken ? { 'x-csrf-token': csrfToken } : {}),
      ...init?.headers,
    },
  });
  const text = await response.text();
  const body = text === '' ? null : (JSON.parse(text) as unknown);
  if (!response.ok) {
    const record = (body ?? {}) as { error?: string; issues?: unknown[]; ok?: boolean };
    if (response.status === 401) {
      throw new ApiError(401, '未授权（401）：开发模式请设置 VITE_API_TOKEN；生产环境由 nginx 注入 Bearer token。');
    }
    throw new ApiError(response.status, record.error ?? `HTTP ${response.status}`, record.issues ?? []);
  }
  return body as T;
}

export function streamUrl(missionId: string): string {
  const base = `${BASE}/api/missions/${missionId}/stream`;
  // EventSource cannot send headers; the API accepts ?token= for SSE only.
  return DEV_TOKEN ? `${base}?token=${encodeURIComponent(DEV_TOKEN)}` : base;
}

function adminHeaders(adminToken: string, actor: string): Record<string, string> {
  // Empty token = session mode: rely on the normal dev/nginx-injected bearer.
  // The backend only accepts this when API_ADMIN_TOKEN is unset (dev fallback);
  // otherwise the request returns 403 and the UI asks for an admin token.
  return {
    ...(adminToken.trim() ? { authorization: `Bearer ${adminToken}` } : {}),
    ...(actor.trim() ? { 'x-actor': actor.trim().slice(0, 120) } : {}),
  };
}

function queryString(values: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

export const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024;

/** Raw octet-stream upload. XHR is used deliberately for upload progress + cancel. */
export function uploadMissionArtifact(
  missionId: string,
  file: File,
  onProgress?: (percent: number) => void,
  signal?: AbortSignal,
): Promise<MissionArtifact> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let abortHandler: (() => void) | null = null;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
      action();
    };
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${BASE}/api/missions/${missionId}/artifacts`);
    xhr.withCredentials = true;
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.setRequestHeader('x-artifact-filename', encodeURIComponent(file.name));
    if (csrfToken) xhr.setRequestHeader('x-csrf-token', csrfToken);
    if (DEV_TOKEN) xhr.setRequestHeader('authorization', `Bearer ${DEV_TOKEN}`);
    xhr.upload.addEventListener('progress', event => {
      if (event.lengthComputable && onProgress) onProgress(Math.round((event.loaded / event.total) * 100));
    });
    xhr.addEventListener('error', () => finish(() => reject(new ApiError(0, '上传网络错误'))));
    xhr.addEventListener('abort', () => finish(() => reject(new ApiError(0, '上传已取消'))));
    xhr.addEventListener('load', () => {
      let body: unknown = null;
      try { body = JSON.parse(xhr.responseText) as unknown; } catch { /* ignore */ }
      if (xhr.status < 200 || xhr.status >= 300) {
        const record = (body ?? {}) as { error?: string; issues?: unknown[] };
        finish(() => reject(new ApiError(xhr.status, record.error ?? `HTTP ${xhr.status}`, record.issues ?? [])));
      } else {
        finish(() => resolve((body as { artifact: MissionArtifact }).artifact));
      }
    });
    abortHandler = () => xhr.abort();
    if (signal) {
      if (signal.aborted) {
        abortHandler();
        return;
      }
      signal.addEventListener('abort', abortHandler, { once: true });
    }
    xhr.send(file);
  });
}

/** Multipart mission creation: target + metadata + up to 20 files in one request. */
export function createMissionMultipart(
  input: CreateMissionMultipartRequest,
  files: File[],
  onProgress?: (percent: number) => void,
  signal?: AbortSignal,
): Promise<CreatedMission> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let abortHandler: (() => void) | null = null;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
      action();
    };
    const form = new FormData();
    if (input.target) form.set('target', JSON.stringify(input.target));
    if (input.targetMode) form.set('targetMode', input.targetMode);
    form.set('objective', input.objective);
    if (input.name !== undefined) form.set('name', input.name);
    if (input.maxSteps !== undefined) form.set('maxSteps', String(input.maxSteps));
    if (input.maxWallClockMs !== undefined) form.set('maxWallClockMs', String(input.maxWallClockMs));
    if (input.methodology !== undefined) form.set('methodology', input.methodology);
    if (input.scopeExtras !== undefined) form.set('scopeExtras', JSON.stringify(input.scopeExtras));
    if (input.priority !== undefined) form.set('priority', String(input.priority));
    for (const file of files) form.append('artifact', file);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${BASE}/api/missions`);
    xhr.withCredentials = true;
    if (csrfToken) xhr.setRequestHeader('x-csrf-token', csrfToken);
    if (DEV_TOKEN) xhr.setRequestHeader('authorization', `Bearer ${DEV_TOKEN}`);
    xhr.upload.addEventListener('progress', event => {
      if (event.lengthComputable && onProgress) onProgress(Math.round((event.loaded / event.total) * 100));
    });
    xhr.addEventListener('error', () => finish(() => reject(new ApiError(0, '创建请求网络错误'))));
    xhr.addEventListener('abort', () => finish(() => reject(new ApiError(0, '创建已取消'))));
    xhr.addEventListener('load', () => {
      let body: unknown = null;
      try { body = JSON.parse(xhr.responseText) as unknown; } catch { /* ignore */ }
      if (xhr.status < 200 || xhr.status >= 300) {
        const record = (body ?? {}) as { error?: string; issues?: unknown[] };
        finish(() => reject(new ApiError(xhr.status, record.error ?? `HTTP ${xhr.status}`, record.issues ?? [])));
      } else {
        finish(() => resolve(body as CreatedMission));
      }
    });
    abortHandler = () => xhr.abort();
    if (signal) {
      if (signal.aborted) {
        abortHandler();
        return;
      }
      signal.addEventListener('abort', abortHandler, { once: true });
    }
    xhr.send(form);
  });
}

export const api = {
  health: () => request<Health>('/api/health'),

  me: () => request<AuthMe>('/api/auth/me'),
  login: (username: string, password: string) =>
    request<{ user: AuthUser; csrfToken: string; expiresAt: string }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  logout: () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
  // One admin account per deployment: the only self-service credential action
  // is changing the bootstrap password after the first login.
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: boolean; user: AuthUser; csrfToken: string }>('/api/auth/password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) }),
  getWatchdogDashboard: (days = 7, limit = 50) =>
    request<{ watchdog: WatchdogDashboard }>(`/api/admin/watchdog?days=${days}&limit=${limit}`),
  getRuntimeSettings: () => request<{ settings: RuntimeSettings }>('/api/admin/settings'),
  patchRuntimeSettings: (values: Record<string, unknown>, expectedVersion: number) =>
    request<{ settings: RuntimeSettings }>('/api/admin/settings', { method: 'PATCH', body: JSON.stringify({ expectedVersion, values }) }),
  listAdminAudit: (limit = 100) => request<{ audit: AdminAuditEntry[]; total: number }>(`/api/admin/audit?limit=${limit}`),
  deleteMission: (id: string, confirmName: string) =>
    request<{ deleted: { missionId: string; name: string; counts: Record<string, number> } }>(`/api/admin/missions/${id}`, { method: 'DELETE', body: JSON.stringify({ confirmName }) }),
  getMissionSummary: (id: string) => request<{ summary: MissionSummary | null }>(`/api/missions/${id}/summary`),

  listMissions: () => request<{ missions: MissionListItem[]; total: number }>('/api/missions'),
  createMission: (input: CreateMissionRequest) =>
    request<CreatedMission>('/api/missions', { method: 'POST', body: JSON.stringify(input) }),
  createMissionMultipart: (input: CreateMissionMultipartRequest, files: File[], onProgress?: (percent: number) => void, signal?: AbortSignal) =>
    createMissionMultipart(input, files, onProgress, signal),
  getMission: (id: string) => request<{ mission: MissionDetail }>(`/api/missions/${id}`),
  listMissionArtifacts: (missionId: string) => request<{ artifacts: MissionArtifact[] }>(`/api/missions/${missionId}/artifacts`),
  uploadMissionArtifact: (missionId: string, file: File, onProgress?: (percent: number) => void, signal?: AbortSignal) =>
    uploadMissionArtifact(missionId, file, onProgress, signal),
  gcArtifacts: (days?: number) => request<ArtifactGcResult>('/api/admin/artifacts/gc', { method: 'POST', body: JSON.stringify({ days }) }),
  pauseMission: (id: string) =>
    request<{ mission: MissionControlResult }>(`/api/missions/${id}/pause`, { method: 'POST' }),
  resumeMission: (id: string) =>
    request<{ mission: MissionControlResult }>(`/api/missions/${id}/resume`, { method: 'POST' }),

  createManualTask: (missionId: string, input: CreateManualTaskRequest) =>
    request<{ taskId: string; state: string }>(`/api/missions/${missionId}/tasks`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  cancelTask: (missionId: string, taskId: string, reason?: string) =>
    request<TaskControlResult>(`/api/missions/${missionId}/tasks/${taskId}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
  confirmTaskRetry: (missionId: string, taskId: string) =>
    request<TaskControlResult>(`/api/missions/${missionId}/tasks/${taskId}/confirm-retry`, { method: 'POST' }),
  listTaskActions: (missionId: string, taskId: string) =>
    request<{ actions: ActionLedgerEntry[]; total: number }>(
      `/api/missions/${missionId}/tasks/${taskId}/actions`,
    ),
  listMissionActions: (missionId: string) =>
    request<{ actions: ActionLedgerEntry[]; total: number }>(`/api/missions/${missionId}/action-ledger`),
  listSteering: (missionId: string) =>
    request<{ commands: SteeringRecord[]; total: number }>(`/api/missions/${missionId}/steering`),

  listFindings: () => request<{ findings: FindingListItem[]; total: number }>('/api/findings'),
  getFinding: (id: string) => request<{ finding: FindingDetail }>(`/api/findings/${id}`),
  getFindingLineage: (id: string) => request<{ lineage: FindingLineage }>(`/api/findings/${id}/lineage`),

  listApprovals: (status?: string) =>
    request<{ approvals: Approval[]; total: number }>(
      status ? `/api/approvals?status=${encodeURIComponent(status)}` : '/api/approvals',
    ),
  createApproval: (input: { missionId: string; type: string; payload?: Record<string, unknown> }) =>
    request<{ approvalId: string }>('/api/approvals', { method: 'POST', body: JSON.stringify(input) }),
  decideApproval: (id: string, input: { decision: 'approved' | 'rejected'; decidedBy?: string; note?: string }) =>
    request<{ approval: Approval }>(`/api/approvals/${id}/decide`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  listHints: (missionId: string) =>
    request<{ hints: Hint[]; total: number }>(`/api/hints?missionId=${encodeURIComponent(missionId)}`),
  createHint: (input: { missionId: string; taskId?: string; content: string; source?: string }) =>
    request<{ hintId: string }>('/api/hints', { method: 'POST', body: JSON.stringify(input) }),

  listTriggers: (missionId: string) =>
    request<{ triggers: Trigger[]; total: number }>(`/api/triggers?missionId=${encodeURIComponent(missionId)}`),


  getMetrics: () => request<{ metrics: MetricsSummary }>('/api/metrics'),

  listMissionFacts: (
    missionId: string,
    options: { kind?: string; trust?: string; limit?: number } = {},
  ) =>
    request<FactsResponse>(
      `/api/missions/${missionId}/facts${queryString({ kind: options.kind, trust: options.trust, limit: options.limit })}`,
    ),
  getMissionFrontier: (missionId: string, options: { factLimit?: number; intentLimit?: number } = {}) =>
    request<{ frontier: MissionFrontier }>(
      `/api/missions/${missionId}/frontier${queryString({ factLimit: options.factLimit, intentLimit: options.intentLimit })}`,
    ),
  recallMissionFacts: (missionId: string, query: { q: string; kind?: string; limit?: number }) =>
    request<FactsResponse>(`/api/missions/${missionId}/recall${queryString(query)}`),

  listModelConfigs: (adminToken: string, actor: string) =>
    request<{ configs: ModelConfig[]; total: number }>('/api/model-configs', { headers: adminHeaders(adminToken, actor) }),
  createModelConfig: (adminToken: string, actor: string, input: ModelConfigInput) =>
    request<{ config: ModelConfig }>('/api/model-configs', {
      method: 'POST',
      headers: adminHeaders(adminToken, actor),
      body: JSON.stringify(input),
    }),
  updateModelConfig: (adminToken: string, actor: string, id: string, input: Partial<ModelConfigInput>) =>
    request<{ config: ModelConfig }>(`/api/model-configs/${id}`, {
      method: 'PATCH',
      headers: adminHeaders(adminToken, actor),
      body: JSON.stringify(input),
    }),
  deleteModelConfig: (adminToken: string, actor: string, id: string) =>
    request<{ deleted: boolean }>(`/api/model-configs/${id}`, {
      method: 'DELETE',
      headers: adminHeaders(adminToken, actor),
    }),
  revealModelConfig: (adminToken: string, actor: string, id: string) =>
    request<{ config: ModelConfigReveal }>(`/api/model-configs/${id}/reveal`, {
      method: 'POST',
      headers: adminHeaders(adminToken, actor),
    }),
  testModelConfigDraft: (adminToken: string, actor: string, input: ModelConfigTestInput) =>
    request<ModelConfigTestResult>('/api/model-configs/test', {
      method: 'POST',
      headers: adminHeaders(adminToken, actor),
      body: JSON.stringify(input),
    }),
  testModelConfigStored: (adminToken: string, actor: string, id: string, override: ModelConfigTestInput = {}) =>
    request<ModelConfigTestResult>(`/api/model-configs/${id}/test`, {
      method: 'POST',
      headers: adminHeaders(adminToken, actor),
      body: JSON.stringify(override),
    }),
  listModelConfigAudit: (adminToken: string, actor: string) =>
    request<{ audit: ModelConfigAudit[]; total: number }>('/api/model-configs/audit', {
      headers: adminHeaders(adminToken, actor),
    }),
  getTraceSummaries: (missionId: string, excludeTaskId?: string) =>
    request<{ summary: PriorWorkSummary }>(
      `/api/missions/${missionId}/trace-summaries${excludeTaskId ? `?excludeTaskId=${encodeURIComponent(excludeTaskId)}` : ''}`,
    ),
  getMissionBoard: (missionId: string) => request<{ board: MissionBoard }>(`/api/missions/${missionId}/board`),
  getMissionIntel: (missionId: string, options: { limit?: number } = {}) =>
    request<{ intel: MissionIntel }>(`/api/missions/${missionId}/intel${queryString({ limit: options.limit })}`),
  getMissionExploreGraph: (missionId: string, options: { threshold?: number } = {}) =>
    request<{ graph: ExploreGraph }>(`/api/missions/${missionId}/explore-graph${queryString({ threshold: options.threshold })}`),
  getMissionOverview: (missionId: string, options: { maxChars?: number } = {}) =>
    request<{ overview: MissionOverview }>(`/api/missions/${missionId}/overview${queryString({ maxChars: options.maxChars })}`),
  searchWorkerTraces: (missionId: string, options: { q?: string; excludeTaskId?: string; limit?: number } = {}) =>
    request<{ search: WorkerTraceSearch }>(
      `/api/missions/${missionId}/worker-traces/search${queryString({ q: options.q, excludeTaskId: options.excludeTaskId, limit: options.limit })}`,
    ),
  getMissionAssetsGraph: (missionId: string) =>
    request<{ graph: MissionAssetGraph }>(`/api/missions/${missionId}/assets/graph`),
  getEvalsDashboard: (options: { limit?: number; replayLimit?: number } = {}) =>
    request<EvalDashboard>(`/api/evals/dashboard${queryString({ limit: options.limit, replayLimit: options.replayLimit })}`),
  requestScopeUpgrade: (missionId: string, input: ScopeUpgradeInput) =>
    request<ScopeUpgradeResponse>(`/api/missions/${missionId}/scope-upgrade`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  listTrace: (subjectType: SubjectType, subjectId: string) =>
    request<{ trace: TraceRow[]; total: number }>(
      `/api/traces?subjectType=${subjectType}&subjectId=${encodeURIComponent(subjectId)}`,
    ),
};

export type { ListResponse };
