import { AlertTriangle, ArrowUpRight, CheckCheck, RefreshCw, ShieldAlert } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { MissionViewHeader } from '../components/mission-views';
import { MissionStatus, SeverityBadge, TaskStatus } from '../components/status-badge';
import { Badge, Button, ErrorState, Panel, SectionLabel, Skeleton } from '../components/ui';
import { api } from '../lib/api';
import { factKindLabel, factProvenanceLabel, factTrustLabel, maskSensitiveValue } from '../lib/blackboard';
import { confidenceLabel, findingStatusLabel, formatDate, formatShortDate, hintKindLabel, missionTargetLabel, taskAngleLabel } from '../lib/format';
import { useAsync } from '../lib/hooks';
import type { OverviewFact, OverviewFinding, OverviewTask } from '../lib/types';
import { cn } from '../lib/utils';

export function MissionOverviewPage() {
  const { id } = useParams<{ id: string }>();
  // The overview is a bounded summary. Request the API maximum so normal
  // projects are complete; if the server still truncates, the UI points to the
  // dedicated detail pages instead of exposing a character-budget control.
  const state = useAsync(async () => (await api.getMissionOverview(id ?? '', { maxChars: 50_000 })).overview, [id]);
  const [view, setView] = useState<'operations' | 'context'>('operations');

  if (!id) return <ErrorState error="缺少项目 ID。" />;
  if (state.loading) return <div className="mx-auto w-full max-w-[1500px] space-y-4"><Skeleton className="h-28 w-full" /><Skeleton className="h-96 w-full" /></div>;
  if (state.error || !state.data) return <ErrorState error={state.error ?? '项目概览不可用。'} retry={state.refresh} />;
  const overview = state.data;
  const tasks = overview.tasks;
  const taskList = dedupeById([...tasks.open, ...tasks.recent]);
  const facts = overview.facts.items;
  const findingList = dedupeById([...overview.findings.accepted, ...overview.findings.needsReview]);

  return (
    <div className="mx-auto w-full max-w-[1500px]">
      <MissionViewHeader
        mission={overview.mission}
        active="project"
        index={`01 / 项目 / 项目概览 / ${overview.mission.id.slice(0, 6)}`}
        title={<>项目概览</>}
        description=""
        actions={
          <Button variant="outline" icon={<RefreshCw className="size-3.5" aria-hidden="true" />} onClick={state.refresh}>刷新</Button>
        }
        aside={
          <div className="space-y-2 text-left lg:text-right">
            <div className="flex items-center gap-2 lg:justify-end"><MissionStatus state={overview.mission.state} /></div>
            <p className="mono break-all text-xs text-muted">{missionTargetLabel(overview.mission.target)}</p>
            <p className="mono text-[10px] text-faint">事件版本 {overview.version} · {formatDate(overview.generatedAt)}</p>
          </div>
        }
      />

      {overview.truncated ? (
        <div className="mb-4 flex items-start gap-2 border border-amber-300/30 bg-amber-300/5 px-4 py-3 text-xs leading-relaxed text-amber-100/85">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-300" aria-hidden="true" />
          <p>概览为有界摘要，服务端已按预算省略部分明细（不会修改任何数据）。完整数据请打开对应明细页：依赖图、线索板、黑板、探索图、资产图或轨迹检索。</p>
        </div>
      ) : null}

      <div className="grid gap-px border border-line bg-line sm:grid-cols-2 lg:grid-cols-6">
        <Stat label="任务总数" value={tasks.counts.total} />
        <Stat label="进行中" value={tasks.counts.open} tone={tasks.counts.open > 0 ? 'lime' : undefined} />
        <Stat label="已完成" value={tasks.counts.done} />
        <Stat label="事实" value={overview.facts.counts.total} />
        <Stat label="发现" value={overview.findings.counts.accepted + overview.findings.counts.needsReview} />
        <Stat label="资产覆盖" value={overview.coverage.ratio === null ? '—' : `${Math.round(overview.coverage.ratio * 100)}%`} />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={cn('chip', view === 'operations' && 'chip-active')}
          aria-pressed={view === 'operations'}
          onClick={() => setView('operations')}
        >
          运行视图
        </button>
        <button
          type="button"
          className={cn('chip', view === 'context' && 'chip-active')}
          aria-pressed={view === 'context'}
          onClick={() => setView('context')}
        >
          事实与发现
        </button>
        <span className="mono ml-auto text-[10px] text-faint">任务 {tasks.counts.total} · 事实 {overview.facts.counts.total} · 发现 {overview.findings.counts.accepted + overview.findings.counts.needsReview}</span>
      </div>

      <AnimatePresence mode="wait" initial={false}>
        {view === 'operations' ? (
          <motion.div
            key="operations"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.18, ease: [0.22, 0.61, 0.36, 1] }}
            className="mt-3 grid min-h-[353px] gap-3 xl:grid-cols-3"
          >
            <Panel className="min-w-0 p-4">
              <SectionLabel index="任务" right={<span className="mono text-[10px] text-faint">开放 {tasks.counts.open} · 近期 {tasks.counts.done + tasks.counts.failed}</span>}>任务态势</SectionLabel>
              {taskList.length === 0 ? (
                <p className="mt-3 border border-dashed border-line px-3 py-4 text-xs leading-relaxed text-muted">
                  {tasks.counts.total === 0 ? '暂无任务；Planner 展开任务后会显示在这里。' : `当前没有开放或近期任务摘要；任务总数 ${tasks.counts.total}。`}
                </p>
              ) : (
                <ul className="divide-y divide-line">
                  {taskList.slice(0, 3).map(task => <TaskRow key={task.id} task={task} missionId={overview.mission.id} />)}
                </ul>
              )}
              <div className="mt-3 flex flex-wrap gap-3 text-[10px] text-faint">
                <span>失败 {tasks.counts.failed}</span>
                <span>总任务 {tasks.counts.total}</span>
                <Link to={`/missions/${overview.mission.id}/dag`} className="inline-flex items-center gap-1 text-lime hover:underline">打开依赖图 <ArrowUpRight className="size-3" aria-hidden="true" /></Link>
              </div>
            </Panel>

            <Panel className="min-w-0 p-4">
              <SectionLabel index="覆盖" right={<span className="mono text-[10px] text-faint">{overview.coverage.covered} / {overview.coverage.total}</span>}>资产覆盖</SectionLabel>
              <CoverageBar ratio={overview.coverage.ratio} covered={overview.coverage.covered} total={overview.coverage.total} />
              <div className="mt-3 flex flex-wrap gap-2">
                {Object.entries(overview.assets.byType).map(([kind, count]) => <Badge key={kind} tone="muted">{factKindLabel(kind)} ×{count}</Badge>)}
                {overview.assets.total === 0 ? <span className="text-xs text-muted">暂无项目资产。</span> : null}
              </div>
              {overview.assets.items.length > 0 ? (
                <ul className="mt-2 divide-y divide-line">
                  {overview.assets.items.slice(0, 3).map((asset, index) => (
                    <li key={`${asset.type}-${asset.value}-${index}`} className="py-2">
                      <p className="mono truncate text-[11px] text-paper">{asset.type === 'credential' ? maskSensitiveValue(asset.value) : asset.value}</p>
                      <p className="mono mt-1 text-[9px] text-faint">{factKindLabel(asset.type)} · {formatShortDate(asset.createdAt)}</p>
                    </li>
                  ))}
                </ul>
              ) : null}
              <div className="mt-3 flex flex-wrap gap-3 text-[10px]">
                <Link to={`/missions/${overview.mission.id}/assets`} className="inline-flex items-center gap-1 text-lime hover:underline">打开资产图 <ArrowUpRight className="size-3" aria-hidden="true" /></Link>
                <span className="text-faint">tokens {overview.budget.tokens.toLocaleString()} · steps {overview.budget.steps}</span>
              </div>
            </Panel>

            <Panel className="min-w-0 p-4">
              <SectionLabel index="轨迹" right={<span className="mono text-[10px] text-faint">同项目</span>}>运行摘要</SectionLabel>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <MiniStat label="步骤" value={asNumber(asRecord(overview.traces.totals).steps)} />
                <MiniStat label="工具调用" value={asNumber(asRecord(overview.traces.totals).toolCalls)} />
                <MiniStat label="证据" value={asNumber(asRecord(overview.traces.totals).evidence)} />
                <MiniStat label="已接受发现" value={asNumber(asRecord(overview.traces.totals).acceptedFindings)} />
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <Link to={`/missions/${overview.mission.id}/traces`} className="inline-flex items-center gap-1 text-[10px] text-lime hover:underline">轨迹检索 <ArrowUpRight className="size-3" aria-hidden="true" /></Link>
                {overview.frontier ? <span className="text-[10px] text-faint">前沿 {overview.frontier.counts.intents} 意图 / {overview.frontier.counts.facts} 事实</span> : null}
              </div>
            </Panel>
          </motion.div>
        ) : (
          <motion.div
            key="context"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.18, ease: [0.22, 0.61, 0.36, 1] }}
            className="mt-3 grid min-h-[353px] gap-3 xl:grid-cols-3"
          >
            <Panel className="min-w-0 p-4">
              <SectionLabel index="工作台" right={<span className="mono text-[10px] text-faint">提示 {overview.hints.pending} 待投递</span>}>提示与待办</SectionLabel>
              {overview.hints.items.length === 0 ? <p className="mt-2 text-xs text-muted">暂无提示。</p> : (
                <ul className="divide-y divide-line">
                  {overview.hints.items.slice(0, 2).map(hint => (
                    <li key={hint.id} className="py-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone={hint.kind === 'help' ? 'ember' : hint.kind === 'report' ? 'violet' : 'muted'}>{hintKindLabel(hint.kind)}</Badge>
                        <span className="mono text-[10px] text-faint">{hint.source} · {hint.state}</span>
                      </div>
                      <p className="mt-1 line-clamp-1 text-xs leading-relaxed text-paper">{hint.content}</p>
                    </li>
                  ))}
                </ul>
              )}
              {overview.todo.items.length > 0 ? (
                <div className="mt-2 border-t border-line pt-2">
                  <p className="micro mb-1">待办</p>
                  <ol className="space-y-1">
                    {overview.todo.items.slice(0, 2).map(item => (
                      <li key={item.id} className="flex items-start gap-2 text-xs">
                        <span className="mono mt-0.5 text-[10px] text-faint">{String(item.position).padStart(2, '0')}</span>
                        <span className={cn('flex-1 truncate', item.status === 'done' ? 'text-muted line-through' : 'text-paper')}>{item.content}</span>
                        {item.status === 'done' ? <CheckCheck className="size-3.5 text-emerald-300" aria-hidden="true" /> : null}
                      </li>
                    ))}
                  </ol>
                </div>
              ) : null}
              <div className="mt-2 grid grid-cols-4 gap-px border border-line bg-line">
                <MiniStat label="阻塞" value={overview.negatives.blocked} />
                <MiniStat label="耗尽" value={overview.negatives.exhausted} />
                <MiniStat label="过期" value={overview.negatives.stale} />
                <MiniStat label="待复核" value={overview.negatives.needsReview} />
              </div>
            </Panel>

            <Panel className="min-w-0 p-4">
              <SectionLabel index="事实" right={<span className="mono text-[10px] text-faint">敏感 {overview.facts.counts.sensitive}</span>}>类型化事实</SectionLabel>
              {facts.length === 0 ? <p className="mt-2 text-xs text-muted">暂无事实；Worker 写入资产或接收 finding 后会出现。</p> : (
                <ul className="divide-y divide-line">
                  {facts.slice(0, 2).map(fact => <FactRow key={fact.id} fact={fact} />)}
                </ul>
              )}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {Object.entries(overview.facts.counts.byKind).map(([kind, count]) => <Badge key={kind} tone="muted">{factKindLabel(kind)} ×{count}</Badge>)}
                <Link to={`/missions/${overview.mission.id}/blackboard`} className="ml-auto inline-flex items-center gap-1 text-[10px] text-lime hover:underline">打开黑板 <ArrowUpRight className="size-3" aria-hidden="true" /></Link>
              </div>
            </Panel>

            <Panel className="min-w-0 p-4">
              <SectionLabel index="发现" right={<span className="mono text-[10px] text-faint">accepted {overview.findings.counts.accepted} · review {overview.findings.counts.needsReview}</span>}>发现</SectionLabel>
              {findingList.length === 0 ? <p className="mt-2 text-xs text-muted">暂无发现；Curator 接受 finding 后会显示在这里。</p> : (
                <ul className="divide-y divide-line">
                  {findingList.slice(0, 3).map(finding => <FindingRow key={finding.id} finding={finding} />)}
                </ul>
              )}
              <Link to={`/findings?mission=${encodeURIComponent(overview.mission.id)}`} className="mt-2 inline-flex items-center gap-1 text-[10px] text-lime hover:underline">查看全部发现 <ArrowUpRight className="size-3" aria-hidden="true" /></Link>
            </Panel>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function TaskRow({ task, missionId }: { task: OverviewTask; missionId: string }) {
  return (
    <li className="py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="line-clamp-1 text-xs text-paper">{task.objective || `${task.type} · ${task.id.slice(0, 8)}`}</p>
          <p className="mono mt-1 text-[10px] text-faint">{taskAngleLabel(task.angle)} · 第 {task.attempt} 次尝试 · 依赖 {task.dependsOn.length}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <TaskStatus state={task.state} />
          <Link to={`/missions/${missionId}/dag?task=${task.id}`} className="text-[9px] text-lime hover:underline">依赖图 <ArrowUpRight className="size-3" aria-hidden="true" /></Link>
        </div>
      </div>
      {task.lastError ? <p className="mono mt-0.5 line-clamp-1 break-all text-[10px] text-ember">{task.lastError}</p> : null}
    </li>
  );
}

function FactRow({ fact }: { fact: OverviewFact }) {
  const hidden = fact.sensitive;
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={hidden ? 'ember' : 'muted'}>{factKindLabel(fact.kind)}</Badge>
        <span className="text-[9px] uppercase tracking-[0.1em] text-faint">{factTrustLabel(fact.trust)}</span>
        {hidden ? <ShieldAlert className="size-3 text-ember" aria-hidden="true" /> : null}
      </div>
      <p className="mono mt-1 truncate text-[10px] text-faint">{hidden ? maskSensitiveValue(fact.key) : fact.key}</p>
      <p className={cn('mono mt-1 truncate text-xs', hidden ? 'text-amber-200/90' : 'text-paper')}>{hidden ? maskSensitiveValue(fact.value) : fact.value}</p>
      <p className="mono mt-0.5 truncate text-[9px] text-faint">来源链：{factProvenanceLabel(fact.provenance)}</p>
    </li>
  );
}

function FindingRow({ finding }: { finding: OverviewFinding }) {
  return (
    <li className="py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Link to={`/findings/${finding.id}`} className="line-clamp-1 text-xs text-paper hover:text-lime">{finding.title}</Link>
          <p className="mono mt-1 text-[10px] text-faint">{finding.category} · {confidenceLabel(finding.confidence)}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <SeverityBadge severity={finding.severity} />
          <span className="text-[9px] text-faint">{findingStatusLabel(finding.status)}</span>
        </div>
      </div>
    </li>
  );
}

function CoverageBar({ ratio, covered, total }: { ratio: number | null; covered: number; total: number }) {
  const percent = ratio === null ? 0 : Math.round(ratio * 100);
  return (
    <div className="mt-3">
      <div className="flex items-baseline justify-between">
        <span className="display text-2xl text-paper">{ratio === null ? '—' : `${percent}%`}</span>
        <span className="mono text-[10px] text-faint">{covered} / {total} 已覆盖</span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden bg-line" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <div className="h-full bg-lime" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: 'lime' }) {
  return <div className="bg-ink px-4 py-3"><p className="micro">{label}</p><p className={cn('mono mt-1 text-lg', tone === 'lime' ? 'text-lime' : 'text-paper')}>{value}</p></div>;
}

function MiniStat({ label, value }: { label: string; value: number }) {
  return <div className="bg-ink-2 px-3 py-2"><p className="micro">{label}</p><p className="mono mt-1 text-sm text-paper">{value.toLocaleString()}</p></div>;
}

function dedupeById<T extends { id: string }>(items: T[]): T[] {
  const map = new Map(items.map(item => [item.id, item]));
  return [...map.values()];
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

