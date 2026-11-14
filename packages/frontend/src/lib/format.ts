import type { ApprovalStatus, AssetEdgeType, Confidence, EgressMode, ExploreEdgeType, FindingStatus, HintKind, IntelType, MissionState, MissionTarget, Severity, TaskAngle, TaskState } from './types';

/** Mission targets can be network hosts or attachment-only missions. */
export function missionTargetLabel(target: { type: string; value: string } | MissionTarget | null | undefined): string {
  if (!target) return '未设置目标';
  return target.type === 'file' ? '附件' : target.value;
}

// Contract: enums keep their English raw value and render as 「中文 (english)」.
const MISSION_LABELS: Record<MissionState, string> = {
  pending: '待规划',
  running: '运行中',
  paused: '已暂停',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

const TASK_LABELS: Record<TaskState, string> = {
  proposed: '待规划',
  ready: '就绪',
  leased: '已领取',
  running: '运行中',
  reported: '已上报',
  verified: '已验证',
  done: '已完成',
  retry_wait: '等待重试',
  exhausted: '已耗尽',
  blocked: '已阻塞',
  cancelled: '已取消',
  stale: '已过期',
  handed_back: '已交还',
};

const SEVERITY_LABELS: Record<Severity, string> = {
  critical: '严重',
  high: '高危',
  medium: '中危',
  low: '低危',
  info: '信息',
};

const FINDING_STATUS_LABELS: Record<FindingStatus, string> = {
  accepted: '已接受',
  needs_review: '待复核',
  rejected: '已拒绝',
};

const APPROVAL_LABELS: Record<ApprovalStatus, string> = {
  pending: '待审批',
  approved: '已批准',
  rejected: '已拒绝',
};

const TRIGGER_ROUTE_LABELS: Record<string, string> = {
  direct: '直通提示',
  planner: 'Planner 规划',
};

const TRIGGER_KIND_LABELS: Record<string, string> = {
  repeated_request: '重复请求',
  denial_spike: '越界拒绝激增',
  no_progress: '长时间无进展',
};

const HINT_STATE_LABELS: Record<string, string> = {
  pending: '待投递',
  delivered: '已投递',
  consumed: '已消费',
};

const DENIAL_KIND_LABELS: Record<string, string> = {
  scope_denied: '越权拦截',
  internet_denied: '互联网访问拦截',
  policy_denied: '策略限速拦截',
};

const CONFIDENCE_LABELS: Record<Confidence, string> = {
  observed: '已观测',
  inferred: '推断',
  unverified: '未验证',
};

const APPROVAL_TYPE_LABELS: Record<string, string> = {
  manual: '人工审批',
  scope_upgrade: '授权范围升级',
  finding_review: '发现复核',
  command_review: '命令复核',
  stalled_task: '停滞任务复核',
};

const TASK_ANGLE_LABELS: Record<TaskAngle, string> = {
  web: 'Web 应用',
  api: 'API 接口',
  infra: '基础设施',
  binary: '二进制',
};

const INTEL_TYPE_LABELS: Record<IntelType, string> = {
  technique: '技术',
  artifact: '目标产物',
  credential: '凭据',
};

const HINT_KIND_LABELS: Record<HintKind, string> = {
  guidance: '指导',
  help: '求助',
  report: '报告',
};

const TODO_STATUS_LABELS: Record<string, string> = {
  pending: '待处理',
  in_progress: '进行中',
  done: '已完成',
  blocked: '已阻塞',
};

const FAILURE_CLASS_LABELS: Record<string, string> = {
  no_progress: '无进展',
  scope_denied: '越界拒绝',
  network_error: '网络错误',
};

const STEERING_TYPE_LABELS: Record<string, string> = {
  spawn_intent: '手动派任务',
  cancel_task: '取消任务',
  confirm_retry: '确认重试',
};

const ASSET_EDGE_LABELS: Record<AssetEdgeType, string> = {
  observed_by: '被观测',
  seen_in_evidence: '出现在证据',
  produced: '产出',
};

const EVAL_KIND_LABELS: Record<string, string> = {
  matrix: '矩阵',
  fixture: '夹具',
  effect: '效果',
  frozen: '冻结',
  replay: '回放',
  other: '其他',
};

const EVAL_STATUS_LABELS: Record<string, string> = {
  completed: '完成',
  failed: '失败',
  partial: '部分',
};

const EXPLORE_EDGE_LABELS: Record<ExploreEdgeType, string> = {
  contains: '包含',
  produced: '产出',
  observes: '观察',
  evidence_of: '证据',
};

const TRACE_LABELS: Record<string, string> = {
  thinking: '思考',
  text: '文本',
  tool_call: '工具调用',
  tool_result: '工具结果',
  context: '上下文注入',
  status: '状态',
  session: '会话',
  final: '最终回复',
  assistant_message: '助手消息',
};

function withRaw(label: string | undefined, raw: string | null | undefined): string {
  if (!raw) return '未知';
  if (!label) return raw;
  return `${label} (${raw})`;
}

export const missionLabel = (state: MissionState | string): string =>
  withRaw(MISSION_LABELS[state as MissionState], state);
export const taskLabel = (state: TaskState | string): string =>
  withRaw(TASK_LABELS[state as TaskState], state);
export const severityLabel = (severity: Severity | string): string =>
  withRaw(SEVERITY_LABELS[severity as Severity], severity);
export const findingStatusLabel = (status: FindingStatus | string): string =>
  withRaw(FINDING_STATUS_LABELS[status as FindingStatus], status);
export const approvalStatusLabel = (status: ApprovalStatus | string): string =>
  withRaw(APPROVAL_LABELS[status as ApprovalStatus], status);
export const triggerRouteLabel = (route: string): string => withRaw(TRIGGER_ROUTE_LABELS[route], route);
export const triggerKindLabel = (kind: string): string => withRaw(TRIGGER_KIND_LABELS[kind], kind);
export const hintStateLabel = (state: string): string => withRaw(HINT_STATE_LABELS[state], state);
export const denialKindLabel = (kind: string): string => DENIAL_KIND_LABELS[kind] ?? kind;
export const traceEventLabel = (type: string): string => withRaw(TRACE_LABELS[type], type);
export const confidenceLabel = (confidence: Confidence | string): string =>
  withRaw(CONFIDENCE_LABELS[confidence as Confidence], confidence);
export const approvalTypeLabel = (type: string): string => withRaw(APPROVAL_TYPE_LABELS[type], type);
export const taskAngleLabel = (angle: TaskAngle | string | null | undefined): string =>
  angle ? withRaw(TASK_ANGLE_LABELS[angle as TaskAngle], angle) : '未指定角度';
export const intelTypeLabel = (type: IntelType | string): string => withRaw(INTEL_TYPE_LABELS[type as IntelType], type);
export const exploreEdgeLabel = (type: ExploreEdgeType | string): string => withRaw(EXPLORE_EDGE_LABELS[type as ExploreEdgeType], type);
export const hintKindLabel = (kind: string | null | undefined): string =>
  kind ? withRaw(HINT_KIND_LABELS[kind as HintKind], kind) : '指导 (guidance)';
export const assetEdgeLabel = (type: AssetEdgeType | string): string => withRaw(ASSET_EDGE_LABELS[type as AssetEdgeType], type);
export const evalKindLabel = (kind: string): string => withRaw(EVAL_KIND_LABELS[kind], kind);
export const evalStatusLabel = (status: string): string => withRaw(EVAL_STATUS_LABELS[status], status);
export const todoStatusLabel = (status: string): string => withRaw(TODO_STATUS_LABELS[status], status);
export const failureClassLabel = (failureClass: string): string => withRaw(FAILURE_CLASS_LABELS[failureClass], failureClass);
export const steeringTypeLabel = (type: string): string => withRaw(STEERING_TYPE_LABELS[type], type);
export const egressModeLabel = (mode: EgressMode): string =>
  mode === 'open' ? '全放行 (open)' : '门禁 (scope)';

const dateFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

const shortFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : dateFormatter.format(date);
}

export function formatShortDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : shortFormatter.format(date);
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, 'second');
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, 'hour');
  return formatter.format(Math.round(hours / 24), 'day');
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function truncate(value: string, length = 120): string {
  return value.length <= length ? value : `${value.slice(0, length)}…`;
}

export function shaShort(hash: string): string {
  return hash ? `${hash.slice(0, 12)}…${hash.slice(-6)}` : '—';
}


/** 0..1 rate → percentage string, preserving one decimal when needed. */
export function formatRate(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || Number.isNaN(rate)) return '—';
  const percent = rate * 100;
  return `${percent >= 10 || percent === 0 ? percent.toFixed(0) : percent.toFixed(1)}%`;
}

/** Seconds → compact human duration (used for metrics timing). */
export function formatSeconds(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  if (value < 60) return `${Math.round(value)}s`;
  if (value < 3600) return `${Math.floor(value / 60)}m ${Math.round(value % 60)}s`;
  return `${(value / 3600).toFixed(1)}h`;
}
