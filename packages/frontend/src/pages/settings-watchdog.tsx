import { Activity, ArrowUpRight, Gauge, Radar, RefreshCw, ShieldAlert, Target } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader } from '../components/shell';
import { SettingsNav } from '../components/settings-nav';
import { Badge, Button, ErrorState, Panel, SectionLabel, Skeleton } from '../components/ui';
import { api } from '../lib/api';
import { formatDate } from '../lib/format';
import { useAsync } from '../lib/hooks';
import type { WatchdogObservation } from '../lib/types';

// Watchdog dashboard (ADR-0039): what the observer flagged, what it escalated,
// and whether the hints actually produced new findings / new target URLs.

const RULE_LABEL: Record<string, string> = {
  duplicate_url: '重复请求',
  no_progress: '无进展',
  direction_drift: '方向漂移',
};

const ACTION_LABEL: Record<string, string> = {
  hint: '提示',
  deduped: '去重跳过',
  escalated: '已升级',
  reset: '进展重置',
};

const OUTCOME_LABEL: Record<string, string> = {
  pending: '待观察',
  progress: '有效果',
  no_progress: '无效果',
};

function outcomeTone(outcome: string): 'lime' | 'ember' | 'muted' {
  if (outcome === 'progress') return 'lime';
  if (outcome === 'no_progress') return 'ember';
  return 'muted';
}

function actionTone(action: string): 'lime' | 'ember' | 'muted' | 'sky' {
  if (action === 'escalated') return 'ember';
  if (action === 'hint') return 'sky';
  if (action === 'reset') return 'lime';
  return 'muted';
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Panel className="p-4">
      <p className="micro text-faint">{label}</p>
      <p className="display mt-1 text-2xl text-paper">{value}</p>
      {hint ? <p className="mt-1 text-[10px] text-muted">{hint}</p> : null}
    </Panel>
  );
}

function ObservationRow({ item }: { item: WatchdogObservation }) {
  return (
    <li className="grid gap-2 border-b border-line/60 px-3 py-2.5 last:border-0 md:grid-cols-[9rem_7rem_1fr_6rem_6rem]">
      <div className="text-[10px] text-faint mono">{formatDate(item.createdAt)}</div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={item.action === 'escalated' ? 'ember' : 'neutral'}>{RULE_LABEL[item.rule] ?? item.rule}</Badge>
        <Badge tone={actionTone(item.action)}>{ACTION_LABEL[item.action] ?? item.action}</Badge>
      </div>
      <div className="min-w-0">
        <p className="truncate text-xs text-muted" title={item.detail}>{item.detail}</p>
        <p className="mt-0.5 flex flex-wrap items-center gap-2 text-[10px] text-faint">
          <Link to={`/missions/${item.missionId}`} className="inline-flex items-center gap-1 text-sky/80 hover:text-sky">
            {item.missionName ?? item.missionId.slice(0, 8)}
            <ArrowUpRight className="size-3" aria-hidden="true" />
          </Link>
          <span>streak={item.stalledStreak}</span>
          <span>source={item.source}</span>
        </p>
      </div>
      <div>
        <Badge tone={outcomeTone(item.outcome)}>{OUTCOME_LABEL[item.outcome] ?? item.outcome}</Badge>
      </div>
      <div className="text-[10px] text-faint">
        {item.outcome === 'pending'
          ? '等待 10 分钟窗口'
          : `findings+${Number(item.outcomeDetail?.newFindings ?? 0)} / urls+${Number(item.outcomeDetail?.newUrls ?? 0)}`}
      </div>
    </li>
  );
}

export function SettingsWatchdog() {
  const [days, setDays] = useState(7);
  const [refreshKey, setRefreshKey] = useState(0);
  const data = useAsync(async () => (await api.getWatchdogDashboard(days, 100)).watchdog, [days, refreshKey]);

  return (
    <div className="mx-auto w-full max-w-[1500px]">
      <PageHeader
        compact
        index="05 / 设置 / Watchdog"
        title={<>Watchdog 看板</>}
        actions={
          <>
            <div className="flex items-center gap-1 border border-line px-1 py-0.5">
              {[1, 7, 30].map(value => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setDays(value)}
                  className={value === days ? 'px-2 py-1 text-[10px] uppercase tracking-[0.12em] text-lime' : 'px-2 py-1 text-[10px] uppercase tracking-[0.12em] text-muted hover:text-paper'}
                >
                  {value}d
                </button>
              ))}
            </div>
            <Button variant="outline" icon={<RefreshCw className="size-3.5" aria-hidden="true" />} onClick={() => setRefreshKey(value => value + 1)}>刷新</Button>
          </>
        }
      />
      <SettingsNav />

      {data.loading ? (
        <div className="grid gap-3 md:grid-cols-3"><Skeleton className="h-24" /><Skeleton className="h-24" /><Skeleton className="h-24" /></div>
      ) : data.error ? (
        <ErrorState error={data.error} retry={() => setRefreshKey(value => value + 1)} />
      ) : data.data ? (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Stat label={`观测（${days}d）`} value={String(data.data.summary.observations)} hint={`提示 ${data.data.summary.hints} / 去重 ${data.data.summary.deduped}`} />
            <Stat label="升级" value={String(data.data.summary.escalations)} hint="planner signal + 人工复核" />
            <Stat
              label="提示命中率"
              value={data.data.summary.hitRate === null ? '—' : `${Math.round(data.data.summary.hitRate * 100)}%`}
              hint={`${data.data.summary.progressOutcomes}/${data.data.summary.checkedOutcomes} 有进展（另有 ${data.data.summary.pendingOutcomes} 待观察）`}
            />
            <Stat label="活跃停滞任务" value={String(data.data.streaks.length)} hint="连续 stalled ≥1" />
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            <Panel className="p-4">
              <SectionLabel index="A" right={<Radar className="size-3.5 text-muted" aria-hidden="true" />}>规则分布</SectionLabel>
              {data.data.summary.byRule.length === 0 ? (
                <p className="mt-3 text-xs text-muted">窗口内没有观测记录。</p>
              ) : (
                <ul className="mt-3 space-y-2">
                  {data.data.summary.byRule.map(row => {
                    const max = Math.max(...data.data!.summary.byRule.map(item => item.count));
                    return (
                      <li key={row.rule} className="flex items-center gap-3 text-xs">
                        <span className="w-24 shrink-0 text-muted">{RULE_LABEL[row.rule] ?? row.rule}</span>
                        <span className="h-1.5 flex-1 bg-line/60">
                          <span className="block h-1.5 bg-lime/70" style={{ width: `${Math.max(4, (row.count / max) * 100)}%` }} />
                        </span>
                        <span className="w-10 text-right mono text-paper">{row.count}</span>
                        {row.escalations > 0 ? <Badge tone="ember">↑{row.escalations}</Badge> : <span className="w-8" />}
                      </li>
                    );
                  })}
                </ul>
              )}
            </Panel>

            <Panel className="p-4">
              <SectionLabel index="B" right={<Gauge className="size-3.5 text-muted" aria-hidden="true" />}>每日观测 / 效果</SectionLabel>
              {data.data.summary.byDay.length === 0 ? (
                <p className="mt-3 text-xs text-muted">窗口内没有观测记录。</p>
              ) : (
                <ul className="mt-3 space-y-1.5">
                  {data.data.summary.byDay.slice(-10).map(day => (
                    <li key={day.date} className="grid grid-cols-[6rem_1fr_4rem_4rem_4rem] items-center gap-2 text-[11px]">
                      <span className="mono text-faint">{day.date}</span>
                      <span className="flex h-1.5 items-center bg-line/50">
                        <span className="block h-1.5 bg-sky/70" style={{ width: `${Math.min(100, day.observations * 8)}%` }} />
                      </span>
                      <span className="text-right mono text-muted">{day.observations}</span>
                      <span className="text-right mono text-lime">{day.progress}✓</span>
                      <span className="text-right mono text-ember">{day.noProgress}✗</span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>

          <Panel className="p-4">
            <SectionLabel index="C" right={<ShieldAlert className="size-3.5 text-muted" aria-hidden="true" />}>升级记录</SectionLabel>
            {data.data.escalations.length === 0 ? (
              <p className="mt-3 text-xs text-muted">窗口内没有升级。连续 {`stalled`} 达到阈值才会升级。</p>
            ) : (
              <ul className="mt-3 border border-line">
                {data.data.escalations.map(item => <ObservationRow key={item.id} item={item} />)}
              </ul>
            )}
          </Panel>

          <Panel className="p-4">
            <SectionLabel index="D" right={<Activity className="size-3.5 text-muted" aria-hidden="true" />}>最近观测</SectionLabel>
            {data.data.recent.length === 0 ? (
              <p className="mt-3 text-xs text-muted">窗口内没有观测记录。</p>
            ) : (
              <ul className="mt-3 border border-line">
                {data.data.recent.slice(0, 50).map(item => <ObservationRow key={item.id} item={item} />)}
              </ul>
            )}
          </Panel>

          <Panel className="p-4">
            <SectionLabel index="E" right={<Target className="size-3.5 text-muted" aria-hidden="true" />}>停滞任务（连续计数）</SectionLabel>
            {data.data.streaks.length === 0 ? (
              <p className="mt-3 text-xs text-muted">没有正在累计停滞的任务。</p>
            ) : (
              <ul className="mt-3 space-y-1.5">
                {data.data.streaks.map(row => (
                  <li key={row.taskId} className="grid grid-cols-[1fr_4rem_4rem_1fr] items-center gap-2 border-b border-line/60 py-1.5 text-[11px] last:border-0">
                    <Link to={`/missions/${row.missionId}`} className="truncate text-sky/80 hover:text-sky">{row.missionName ?? row.missionId.slice(0, 8)}</Link>
                    <span className="mono text-ember">{row.stalledStreak}</span>
                    <span className="mono text-faint">↑{row.escalatedStreak}</span>
                    <span className="truncate text-faint">{row.lastRule ?? '—'} · {row.lastDetail ?? ''}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      ) : null}
    </div>
  );
}
