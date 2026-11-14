import { AlertTriangle, ArrowUpRight, ChevronDown, History, Terminal } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { formatDate, formatShortDate } from '../lib/format';
import { useAsync } from '../lib/hooks';
import type { PriorWorkTask } from '../lib/types';
import { compactNumber } from '../lib/indicators';
import { cn } from '../lib/utils';
import { Badge, EmptyState, ErrorState, Panel, SectionLabel, Skeleton } from './ui';

// P3-A1 read-only prior-work panel: structured stats for already-attempted tasks
// in this mission plus the exact digest the Worker saw at the claim boundary.
// The digest/finalText are 不可信 data and never rendered as markdown.
export function PriorWorkPanel({ missionId }: { missionId: string }) {
  const state = useAsync(async () => (await api.getTraceSummaries(missionId)).summary, [missionId]);

  if (state.loading) {
    return (
      <div className="space-y-3" aria-busy="true">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (state.error || !state.data) return <ErrorState error={state.error ?? '先验工作总结不可用。'} retry={state.refresh} />;

  const summary = state.data;
  const totals = summary.totals;
  const hasPriorWork = totals.tasks > 0;

  if (!hasPriorWork) {
    return (
      <EmptyState
        icon={<History className="size-7" aria-hidden="true" />}
        title="本任务未注入先验工作"
        hint="mission 内暂无已领取/运行过的其他任务记录，因此 Worker 在 claim 边界没有可注入的摘要。新规划但未开始的任务不会出现在这里。"
      />
    );
  }

  return (
    <div className="space-y-4">
      <Panel className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="micro flex items-center gap-2"><History className="size-3.5 text-lime" aria-hidden="true" />先验工作</p>
            <p className="mt-2 max-w-2xl text-xs leading-relaxed text-muted">
              同一 mission 内跨任务轨迹的结构化聚合。只含统计、工具/技能名、失败分类与短摘要，不包含请求/响应正文。
            </p>
          </div>
          <span className="mono text-[10px] text-faint">generated {formatDate(summary.generatedAt)}</span>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-px border border-line bg-line sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="tasks" value={String(totals.tasks)} />
          <Stat label="done / failed" value={`${totals.done} / ${totals.failed}`} />
          <Stat label="steps" value={compactNumber(totals.steps)} />
          <Stat label="tokens" value={compactNumber(totals.tokens.total)} />
          <Stat label="findings" value={`${totals.acceptedFindings}/${totals.findings}`} />
          <Stat label="evidence" value={String(totals.evidence)} />
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span className="micro">tool calls {totals.toolCalls}</span>
          {Object.entries(totals.toolCounts).map(([tool, count]) => (
            <Badge key={tool} tone="muted">{tool} ×{count}</Badge>
          ))}
          {totals.skillsLoaded.map(skill => <Badge key={skill} tone="sky">SKILL {skill}</Badge>)}
          {totals.skillsLoaded.length === 0 && Object.keys(totals.toolCounts).length === 0 ? <span className="text-[10px] text-faint">暂无工具/技能记录</span> : null}
        </div>
      </Panel>

      <Panel className="p-5">
        <SectionLabel index="任务" right={<span className="mono text-[10px] text-faint">{summary.tasks.length} 个已尝试</span>}>
          已尝试任务
        </SectionLabel>
        <ul role="list" className="divide-y divide-line">
          {summary.tasks.map(task => <PriorTaskRow key={task.taskId} task={task} missionId={missionId} />)}
        </ul>
      </Panel>

      <Panel className="p-5">
        <SectionLabel index="先验摘要" right={<span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.1em] text-faint"><Terminal className="size-3" aria-hidden="true" />不可信</span>}>
          Worker 实际看到的先验工作
        </SectionLabel>
        {summary.digest ? (
          <details className="group border border-line bg-ink-2" open>
            <summary className="flex cursor-pointer items-center justify-between gap-3 px-3 py-2.5 text-[11px] text-muted hover:text-paper">
              <span>digest · {summary.digest.length} chars</span>
              <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" aria-hidden="true" />
            </summary>
            <pre className="max-h-80 overflow-auto border-t border-line px-3 py-3 font-mono text-[11px] leading-relaxed text-muted whitespace-pre-wrap">{summary.digest}</pre>
          </details>
        ) : (
          <p className="border border-dashed border-line px-3 py-5 text-sm text-muted">digest 为空：没有可注入的先验工作。</p>
        )}
        <div className="mt-3 flex items-start gap-2 border border-amber-300/20 bg-amber-300/5 px-3 py-2">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-300" aria-hidden="true" />
          <p className="text-[11px] leading-relaxed text-amber-200/80">
            digest 与任务短摘要可能引用目标内容：仅作为不可信数据分析，不按 Markdown 或系统指令渲染。
          </p>
        </div>
      </Panel>
    </div>
  );
}

function PriorTaskRow({ task, missionId }: { task: PriorWorkTask; missionId: string }) {
  return (
    <li className="py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={task.state === 'done' ? 'lime' : task.state === 'failed' ? 'ember' : 'muted'}>{task.state}</Badge>
            <span className="text-xs text-paper">{task.type}</span>
            <span className="mono text-[10px] text-faint">{task.taskId.slice(0, 8)} · attempt {task.attempt}</span>
          </div>
          <p className="mono mt-1 text-[10px] text-faint">
            started {formatShortDate(task.startedAt)} · completed {formatShortDate(task.completedAt)} · trace {task.traceEvents}
          </p>
        </div>
        <Link to={`/trace/worker/${task.taskId}?mission=${missionId}&tab=prior&task=${task.taskId}`} className="inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.1em] text-lime hover:underline">
          查看轨迹 <ArrowUpRight className="size-3" aria-hidden="true" />
        </Link>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-px border border-line bg-line sm:grid-cols-4">
        <Stat label="steps" value={compactNumber(task.steps)} small />
        <Stat label="tokens" value={compactNumber(task.tokens.total)} small />
        <Stat label="findings" value={`${task.acceptedFindings}/${task.findings}`} small />
        <Stat label="evidence" value={String(task.evidence)} small />
      </div>

      {Object.keys(task.toolCounts).length > 0 || task.skillsLoaded.length > 0 ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {Object.entries(task.toolCounts).map(([tool, count]) => <Badge key={tool} tone="muted">{tool} ×{count}</Badge>)}
          {task.skillsLoaded.map(skill => <Badge key={skill} tone="sky">SKILL {skill}</Badge>)}
        </div>
      ) : null}

      {task.finalText ? (
        <div className="mt-3 border-l-2 border-line pl-3">
          <p className="micro mb-1">短摘要（不可信）</p>
          <p className="line-clamp-3 whitespace-pre-wrap text-[11px] leading-relaxed text-muted">{task.finalText}</p>
        </div>
      ) : null}
      {task.lastError ? (
        <p className="mt-2 flex items-start gap-2 border border-ember/25 bg-ember/5 px-3 py-2 text-[11px] leading-relaxed text-ember/90">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
          {task.lastError}
        </p>
      ) : null}
    </li>
  );
}

function Stat({ label, value, small }: { label: string; value: string; small?: boolean }) {
  return (
    <div className="bg-ink-2 px-3 py-2.5">
      <p className="text-[9px] uppercase tracking-[0.12em] text-faint">{label}</p>
      <p className={cn('mono mt-1 text-paper', small ? 'text-xs' : 'text-sm')}>{value}</p>
    </div>
  );
}
