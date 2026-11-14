import { CircleDot, CircleSlash, Clock3, Loader, ShieldAlert, ShieldCheck, ShieldX } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ApprovalStatus, FindingStatus, MissionState, Severity, TaskState } from '../lib/types';
import { approvalStatusLabel, findingStatusLabel, missionLabel, severityLabel, taskLabel } from '../lib/format';
import { cn } from '../lib/utils';

const MISSION_TONE: Record<MissionState, string> = {
  pending: 'text-muted border-line',
  running: 'text-lime border-lime/40 bg-lime/5',
  paused: 'text-amber-300 border-amber-300/40 bg-amber-300/5',
  completed: 'text-emerald-300 border-emerald-300/40 bg-emerald-300/5',
  failed: 'text-ember border-ember/40 bg-ember/5',
  cancelled: 'text-faint border-line',
};

const TASK_TONE: Record<TaskState, string> = {
  proposed: 'text-muted border-line',
  ready: 'text-amber-300 border-amber-300/40',
  leased: 'text-sky border-sky/40',
  running: 'text-lime border-lime/40 bg-lime/5',
  reported: 'text-violet border-violet/40',
  verified: 'text-emerald-300 border-emerald-300/40',
  done: 'text-emerald-300 border-emerald-300/40',
  retry_wait: 'text-orange-300 border-orange-300/40',
  exhausted: 'text-ember border-ember/40',
  blocked: 'text-pink-300 border-pink-300/40',
  cancelled: 'text-faint border-line',
  stale: 'text-faint border-line',
  handed_back: 'text-sky border-sky/40',
};

const SEVERITY_TONE: Record<Severity, string> = {
  critical: 'text-ember border-ember/50 bg-ember/10',
  high: 'text-orange-300 border-orange-300/45 bg-orange-300/5',
  medium: 'text-amber-300 border-amber-300/45 bg-amber-300/5',
  low: 'text-sky border-sky/45 bg-sky/5',
  info: 'text-muted border-line',
};

const APPROVAL_TONE: Record<ApprovalStatus, string> = {
  pending: 'text-amber-300 border-amber-300/45 bg-amber-300/5',
  approved: 'text-emerald-300 border-emerald-300/45 bg-emerald-300/5',
  rejected: 'text-ember border-ember/45 bg-ember/5',
};

const FINDING_TONE: Record<FindingStatus, string> = {
  accepted: 'text-emerald-300 border-emerald-300/45',
  needs_review: 'text-amber-300 border-amber-300/45',
  rejected: 'text-ember border-ember/45',
};

function Pill({ children, className, icon }: { children: ReactNode; className: string; icon?: ReactNode }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-[0.13em]', className)}>
      {icon}
      {children}
    </span>
  );
}

export function MissionStatus({ state }: { state: MissionState }) {
  const icon = state === 'running' ? <Loader className="size-3 animate-spin" aria-hidden="true" />
    : state === 'completed' ? <ShieldCheck className="size-3" aria-hidden="true" />
    : state === 'failed' ? <ShieldX className="size-3" aria-hidden="true" />
    : state === 'paused' ? <Clock3 className="size-3" aria-hidden="true" />
    : state === 'cancelled' ? <CircleSlash className="size-3" aria-hidden="true" />
    : <CircleDot className="size-3" aria-hidden="true" />;
  return <Pill className={MISSION_TONE[state]} icon={icon}>{missionLabel(state)}</Pill>;
}

export function TaskStatus({ state }: { state: TaskState }) {
  return <Pill className={TASK_TONE[state]}>{taskLabel(state)}</Pill>;
}

export function SeverityBadge({ severity }: { severity: Severity }) {
  return <Pill className={SEVERITY_TONE[severity]}>{severityLabel(severity)}</Pill>;
}

export function ApprovalStatusBadge({ status }: { status: ApprovalStatus }) {
  const icon = status === 'pending' ? <Clock3 className="size-3" aria-hidden="true" />
    : status === 'approved' ? <ShieldCheck className="size-3" aria-hidden="true" />
    : <ShieldAlert className="size-3" aria-hidden="true" />;
  return <Pill className={APPROVAL_TONE[status]} icon={icon}>{approvalStatusLabel(status)}</Pill>;
}

export function FindingStatusBadge({ status }: { status: FindingStatus }) {
  return <Pill className={FINDING_TONE[status]}>{findingStatusLabel(status)}</Pill>;
}
