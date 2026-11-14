import { ArrowUpRight, FileSearch, RefreshCw, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { formatShortDate, steeringTypeLabel } from '../lib/format';
import { useAsync } from '../lib/hooks';
import type { ActionLedgerEntry, SteeringRecord, Task } from '../lib/types';
import { cn } from '../lib/utils';
import { Badge, Button, EmptyState, ErrorState, Panel, SectionLabel, Skeleton } from './ui';

// P1 1.7: read-only target write ledger + synchronous steering audit. This is
// the UI a human uses before confirming a blocked task retry.
export function ActionLedgerPanel({ missionId, tasks, selectedTaskId }: { missionId: string; tasks: Task[]; selectedTaskId: string | null }) {
  const actions = useAsync(() => api.listMissionActions(missionId), [missionId]);
  const steering = useAsync(() => api.listSteering(missionId), [missionId]);
  const [taskOnly, setTaskOnly] = useState(false);
  const taskById = new Map(tasks.map(task => [task.id, task]));
  const rows = actions.data?.actions ?? [];
  const filtered = taskOnly && selectedTaskId ? rows.filter(action => action.taskId === selectedTaskId) : rows;
  const commands = steering.data?.commands ?? [];

  return (
    <div className="mt-6 grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
      <Panel className="p-5">
        <SectionLabel
          index="写动作账本"
          right={
            <div className="flex flex-wrap items-center gap-2">
              {selectedTaskId ? (
                <button type="button" className={cn('chip', taskOnly && 'chip-active')} aria-pressed={taskOnly} onClick={() => setTaskOnly(value => !value)}>
                  {taskOnly ? '仅选中任务' : `全部 ${rows.length}`}
                </button>
              ) : null}
              <Button variant="ghost" icon={<RefreshCw className="size-3.5" aria-hidden="true" />} onClick={() => { actions.refresh(); steering.refresh(); }}>刷新</Button>
            </div>
          }
        >
          写动作账本
        </SectionLabel>
        <p className="mb-3 text-[10px] leading-relaxed text-faint">
          仅记录目标流量的 POST / PUT / PATCH / DELETE；确认重试前应核对这里的写动作。哈希用于关联同一请求，不包含请求正文。
        </p>
        {actions.loading ? <Skeleton className="h-32 w-full" /> : actions.error ? (
          <ErrorState error={actions.error} retry={actions.refresh} />
        ) : filtered.length === 0 ? (
          <EmptyState icon={<FileSearch className="size-6" aria-hidden="true" />} title="暂无写动作" hint={taskOnly ? '选中任务没有目标写动作。' : '该任务（mission）尚未产生目标写动作。'} />
        ) : (
          <ul className="max-h-[420px] divide-y divide-line overflow-auto">
            {filtered.map(action => <ActionRow key={action.id} action={action} task={action.taskId ? taskById.get(action.taskId) ?? null : null} missionId={missionId} />)}
          </ul>
        )}
      </Panel>

      <Panel className="p-5">
        <SectionLabel index="人工控制审计" right={<span className="mono text-[10px] text-faint">{commands.length} 条</span>}>
          控制审计
        </SectionLabel>
        <p className="mb-3 text-[10px] leading-relaxed text-faint">
          手动派任务、取消、确认重试的同步审计；每次人工动作都会写入 steering，processed 表示动作已提交。
        </p>
        {steering.loading ? <Skeleton className="h-32 w-full" /> : steering.error ? (
          <ErrorState error={steering.error} retry={steering.refresh} />
        ) : commands.length === 0 ? (
          <EmptyState icon={<ShieldCheck className="size-6" aria-hidden="true" />} title="暂无人工控制" hint="在 DAG 中手动派任务、取消或确认重试后会出现在这里。" />
        ) : (
          <ul className="max-h-[420px] divide-y divide-line overflow-auto">
            {commands.map(command => <SteeringRow key={command.id} command={command} missionId={missionId} taskById={taskById} />)}
          </ul>
        )}
      </Panel>
    </div>
  );
}

function ActionRow({ action, task, missionId }: { action: ActionLedgerEntry; task: Task | null; missionId: string }) {
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="mono border border-ember/35 bg-ember/5 px-2 py-0.5 text-[9px] text-ember">{action.method}</span>
        {action.statusCode !== null ? <span className="mono text-[10px] text-muted">status {action.statusCode}</span> : null}
        <span className="mono ml-auto text-[10px] text-faint">{formatShortDate(action.observedAt)}</span>
      </div>
      <p className="mono mt-1.5 break-all text-[11px] text-paper">{action.url}</p>
      <div className="mt-1 flex flex-wrap items-center gap-3 text-[10px] text-faint">
        {action.taskId ? (
          <Link to={`/missions/${missionId}/dag?task=${action.taskId}`} className="inline-flex items-center gap-1 text-lime hover:underline">
            {task ? taskTitle(task).slice(0, 36) : action.taskId.slice(0, 8)} <ArrowUpRight className="size-3" aria-hidden="true" />
          </Link>
        ) : <span>无任务关联</span>}
        <span className="mono">sha {action.requestSha256.slice(0, 16)}</span>
      </div>
    </li>
  );
}

function SteeringRow({ command, missionId, taskById }: { command: SteeringRecord; missionId: string; taskById: Map<string, Task> }) {
  const taskId = typeof command.payload.taskId === 'string' ? command.payload.taskId : null;
  const reason = typeof command.payload.reason === 'string' ? command.payload.reason : null;
  const task = taskId ? taskById.get(taskId) ?? null : null;
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={command.type === 'confirm_retry' ? 'lime' : command.type === 'cancel_task' ? 'ember' : 'sky'}>{steeringTypeLabel(command.type)}</Badge>
        <span className="text-[9px] uppercase tracking-[0.1em] text-faint">{command.processed ? '已处理' : '待处理'}</span>
        <span className="mono ml-auto text-[10px] text-faint">{formatShortDate(command.createdAt)}</span>
      </div>
      {taskId ? (
        <Link to={`/missions/${missionId}/dag?task=${taskId}`} className="mt-1 inline-flex items-center gap-1 text-[10px] text-lime hover:underline">
          {task ? taskTitle(task).slice(0, 44) : taskId.slice(0, 12)} <ArrowUpRight className="size-3" aria-hidden="true" />
        </Link>
      ) : null}
      {reason ? <p className="mt-1 text-[11px] text-muted">原因：{reason}</p> : null}
      <details className="mt-1">
        <summary className="cursor-pointer text-[9px] uppercase tracking-[0.1em] text-faint">payload</summary>
        <pre className="code-block mt-1 max-h-32 overflow-auto text-[10px]">{JSON.stringify(command.payload, null, 2)}</pre>
      </details>
    </li>
  );
}

function taskTitle(task: Task): string {
  const result = task.result ?? {};
  const goal = typeof result.objective === 'string' ? result.objective : '';
  return goal || `${task.type} · ${task.id.slice(0, 8)}`;
}
