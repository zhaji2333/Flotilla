import { ArrowUpRight, FlaskConical, RefreshCw, TriangleAlert } from 'lucide-react';
import { Link } from 'react-router-dom';
import { PageHeader } from '../components/shell';
import { SettingsNav } from '../components/settings-nav';
import { Badge, Button, EmptyState, ErrorState, Panel, SectionLabel, Skeleton } from '../components/ui';
import { api } from '../lib/api';
import { evalKindLabel, evalStatusLabel, formatDate, formatShortDate } from '../lib/format';
import { useAsync } from '../lib/hooks';
import type { EvalRun, ReplaySummaryItem } from '../lib/types';
import { cn } from '../lib/utils';

export function Evals() {
  const state = useAsync(() => api.getEvalsDashboard({ limit: 10, replayLimit: 5 }), []);
  if (state.loading) return <div className="mx-auto w-full max-w-[1500px] space-y-4"><Skeleton className="h-28 w-full" /><Skeleton className="h-80 w-full" /></div>;
  if (state.error || !state.data) return <ErrorState error={state.error ?? '评测看板不可用。'} retry={state.refresh} />;
  const dashboard = state.data;
  const evalsByKind = groupEvals(dashboard.evals);

  return (
    <div className="mx-auto w-full max-w-[1500px]">
      <PageHeader
        compact
        index="05 / 设置 / 评测与回放"
        title={<>评测与回放</>}
        description=""
        actions={<div className="flex flex-wrap gap-2"><Button variant="outline" icon={<RefreshCw className="size-3.5" aria-hidden="true" />} onClick={state.refresh}>刷新</Button><Link to="/?view=metrics" className="btn btn-ghost">指标见总览</Link></div>}
        aside={
          <div className="text-left lg:text-right">
            <p className="display text-[clamp(2rem,3.6vw,3.2rem)] text-paper">{dashboard.evals.length}</p>
            <p className="micro mt-1">评测类型 · {formatShortDate(dashboard.generatedAt)}</p>
          </div>
        }
      />
      <SettingsNav />


      <div className="grid gap-px border border-line bg-line sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="评测类型" value={String(evalsByKind.length)} />
        <Stat label="回放检查" value={String(dashboard.replay.checked)} />
        <Stat label="投影一致" value={String(dashboard.replay.matched)} tone="lime" />
        <Stat label="投影漂移" value={String(dashboard.replay.mismatched)} tone={dashboard.replay.mismatched > 0 ? 'ember' : undefined} />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
        <Panel className="p-4">
          <SectionLabel index="评测" right={<span className="mono text-[10px] text-faint">每种 kind 最新一条</span>}>评测历史</SectionLabel>
          {evalsByKind.length === 0 ? (
            <EmptyState icon={<FlaskConical className="size-7" aria-hidden="true" />} title="暂无评测记录" hint="评测脚本运行并写入 /api/evals 后会出现在这里；空历史是合法状态。" />
          ) : (
            <div className="space-y-3">
              {evalsByKind.map(group => (
                <section key={group.kind} aria-label={evalKindLabel(group.kind)}>
                  <div className="mb-2 flex items-center gap-2 border-b border-line pb-1.5">
                    <span className="text-[11px] uppercase tracking-[0.14em] text-paper">{evalKindLabel(group.kind)}</span>
                    <span className="mono text-[10px] text-faint">{group.runs.length}</span>
                  </div>
                  <ul className="divide-y divide-line">
                    {group.runs.map(run => <EvalRow key={run.id} run={run} />)}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </Panel>

        <div className="space-y-4">
          <Panel className="p-4">
            <SectionLabel index="回放" right={<span className="mono text-[10px] text-faint">最近 {dashboard.replay.checked} 个项目</span>}>回放一致性</SectionLabel>
            {dashboard.replay.items.length === 0 ? (
              <p className="border border-dashed border-line px-3 py-4 text-xs leading-relaxed text-muted">暂无回放记录；没有可检查的 mission，空历史不视为错误。</p>
            ) : (
              <ul className="divide-y divide-line">
                {dashboard.replay.items.map((item, index) => <ReplayRow key={`${item.missionId ?? 'replay'}-${index}`} item={item} />)}
              </ul>
            )}
          </Panel>

        </div>
      </div>


    </div>
  );
}

function EvalRow({ run }: { run: EvalRun }) {
  const summary = Object.entries(run.summary ?? {}).slice(0, 4);
  return (
    <li className="py-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={run.status === 'failed' ? 'ember' : run.status === 'partial' ? 'violet' : 'lime'}>{evalStatusLabel(run.status)}</Badge>
        <span className="text-xs text-paper">{run.name}</span>
        <span className="mono ml-auto text-[10px] text-faint">{formatDate(run.createdAt)}</span>
      </div>
      <p className="mono mt-1 text-[9px] text-faint">{run.recordedBy ?? 'unknown record'}</p>
      {summary.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {summary.map(([key, value]) => <span key={key} className="border border-line px-1.5 py-0.5 text-[9px] text-faint">{key}: {formatUnknown(value)}</span>)}
        </div>
      ) : null}
    </li>
  );
}

function ReplayRow({ item }: { item: ReplaySummaryItem }) {
  const matched = item.matchesCurrent === true;
  const diffs = Array.isArray(item.diffs) ? item.diffs.length : 0;
  return (
    <li className="py-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={matched ? 'lime' : 'ember'}>{matched ? '一致' : '漂移'}</Badge>
        <span className="mono text-[11px] text-paper">{item.missionId ? item.missionId.slice(0, 8) : '—'}</span>
        {item.toSeq !== undefined ? <span className="mono text-[10px] text-faint">toSeq {String(item.toSeq)}</span> : null}
        {!matched ? <span className="inline-flex items-center gap-1 text-[10px] text-ember"><TriangleAlert className="size-3" aria-hidden="true" />{diffs} diffs</span> : null}
      </div>
      {item.missionId ? (
        <Link to={`/missions/${item.missionId}/overview`} className="mt-1 inline-flex items-center gap-1 text-[10px] text-lime hover:underline">打开项目概览 <ArrowUpRight className="size-3" aria-hidden="true" /></Link>
      ) : null}
    </li>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'lime' | 'ember' }) {
  return <div className="bg-ink px-4 py-3"><p className="micro">{label}</p><p className={cn('mono mt-1 text-lg', tone === 'lime' ? 'text-lime' : tone === 'ember' ? 'text-ember' : 'text-paper')}>{value}</p></div>;
}

function groupEvals(evals: EvalRun[]): Array<{ kind: string; runs: EvalRun[] }> {
  const groups = new Map<string, EvalRun[]>();
  for (const run of evals) {
    const list = groups.get(run.kind) ?? [];
    list.push(run);
    groups.set(run.kind, list);
  }
  return [...groups.entries()].map(([kind, runs]) => ({ kind, runs }));
}

function formatUnknown(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

