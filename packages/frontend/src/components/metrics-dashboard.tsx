import {
  Activity,
  Coins,
  Database,
  FileCheck2,
  Info,
  RefreshCw,
  Target,
  Timer,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';
import { Button, ErrorState, Hint, Panel, SectionLabel, Skeleton } from '../components/ui';
import { api } from '../lib/api';
import { formatDate, formatSeconds } from '../lib/format';
import { useAsync } from '../lib/hooks';
import {
  compactNumber,
  formatIndicatorValue,
  groupIndicators,
  indicatorHint,
  indicatorUnitLabel,
} from '../lib/indicators';
import type { Indicator, IndicatorGroup } from '../lib/types';
import { cn } from '../lib/utils';

type MetricsView = 'catalog' | 'operations';
const VIEW_TABS: Array<{ value: MetricsView; label: string }> = [
  { value: 'catalog', label: '指标目录' },
  { value: 'operations', label: '运行概况' },
];
const PANEL_TRANSITION = { duration: 0.18, ease: [0.22, 0.61, 0.36, 1] as const };

export function MetricsDashboard() {
  const metrics = useAsync(() => api.getMetrics(), []);
  const [view, setView] = useState<MetricsView>('catalog');
  const [group, setGroup] = useState<IndicatorGroup>('quality');
  const data = metrics.data?.metrics ?? null;
  const indicators = data?.indicators ?? [];
  const groups = groupIndicators(indicators);
  const currentGroup = groups.find(item => item.group === group) ?? groups[0];
  const validationRate = indicators.find(indicator => indicator.id === 'validation_rate');

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3 border border-line bg-panel px-4 py-3">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="micro">指标目录 · {indicators.length || '—'} 项</span>
          <span className="display text-[1.7rem] leading-none text-paper">{validationRate ? formatIndicatorValue(validationRate) : '—'}</span>
          <span className="micro normal-case tracking-normal text-muted">validation rate</span>
          <span className="mono text-[10px] text-faint">{data ? `generated ${formatDate(data.generatedAt)}` : 'waiting for metrics'}</span>
        </div>
        <Button variant="outline" icon={<RefreshCw className="size-3.5" aria-hidden="true" />} onClick={metrics.refresh}>刷新指标</Button>
      </div>

      {metrics.loading ? (
        <div className="grid gap-3 lg:grid-cols-[1.55fr_1fr]" aria-busy="true">
          <Skeleton className="h-[290px] w-full" />
          <div className="space-y-3"><Skeleton className="h-32 w-full" /><Skeleton className="h-32 w-full" /></div>
        </div>
      ) : metrics.error ? (
        <ErrorState error={metrics.error} retry={metrics.refresh} />
      ) : !data ? null : indicators.length === 0 ? (
        <ErrorState error="指标目录为空：后端未返回 indicators（旧 API 或投影异常）。" retry={metrics.refresh} />
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 border border-line bg-panel px-2 py-1.5">
            <div className="flex flex-wrap gap-1">
              {VIEW_TABS.map(tab => {
                const active = view === tab.value;
                return (
                  <button
                    key={tab.value}
                    type="button"
                    className={cn('border px-3 py-1.5 text-[10px] uppercase tracking-[0.14em] transition-colors', active ? 'border-lime/45 bg-lime/10' : 'border-transparent')}
                    style={{ color: active ? 'var(--color-lime)' : 'var(--color-muted)' }}
                    aria-pressed={active}
                    onClick={() => setView(tab.value)}
                  >
                    {tab.label}
                  </button>
                );
              })}
            </div>
          </div>

          <AnimatePresence mode="wait" initial={false}>
            {view === 'catalog' ? (
              <motion.div
                key="catalog"
                className="min-h-[242px]"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -5 }}
                transition={PANEL_TRANSITION}
              >
                <Panel className="min-w-0 p-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap gap-1">
                      {groups.map(item => (
                        <button
                          key={item.group}
                          type="button"
                          className={cn('chip', currentGroup?.group === item.group && 'chip-active')}
                          aria-pressed={currentGroup?.group === item.group}
                          onClick={() => setGroup(item.group)}
                        >
                          {item.label}<span className="ml-1.5 opacity-60">{item.items.length}</span>
                        </button>
                      ))}
                    </div>
                    <span className="mono text-[9px] text-faint">{currentGroup ? `${currentGroup.items.length} indicators` : '—'}</span>
                  </div>
                  <AnimatePresence mode="wait" initial={false}>
                    {currentGroup ? (
                      <motion.div
                        key={currentGroup.group}
                        initial={{ opacity: 0, y: 5 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -4 }}
                        transition={PANEL_TRANSITION}
                        className="mt-2 grid gap-px border-l border-t border-line bg-line sm:grid-cols-2 xl:grid-cols-3"
                      >
                        {currentGroup.items.map(indicator => <IndicatorCard key={indicator.id} indicator={indicator} />)}
                      </motion.div>
                    ) : null}
                  </AnimatePresence>
                </Panel>
              </motion.div>
            ) : (
              <motion.div
                key="operations"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -5 }}
                transition={PANEL_TRANSITION}
                className="min-h-[242px] space-y-2"
              >
                <div className="grid gap-2 lg:grid-cols-3">
                  <Panel className="min-w-0 p-2.5">
                    <SectionLabel index="成本" right={<Coins className="size-3.5 text-faint" aria-hidden="true" />}>成本代理</SectionLabel>
                    <div className="mt-2 grid grid-cols-2 gap-2">
                      <MiniStat label="累计 token" value={compactNumber(data.cost?.totalTokens ?? 0)} />
                      <MiniStat label="单位验证成本" value={data.cost?.tokensPerValidatedFinding == null ? 'N/A' : compactNumber(data.cost.tokensPerValidatedFinding)} />
                    </div>
                  </Panel>

                  <Panel className="min-w-0 p-2.5">
                    <SectionLabel index="耗时" right={<Timer className="size-3.5 text-faint" aria-hidden="true" />}>耗时</SectionLabel>
                    <div className="mt-2 space-y-2">
                      <MiniLine label="平均项目时长" value={formatSeconds(data.timing.avgMissionSeconds)} />
                      <MiniLine label="首个事实耗时" value={data.timing.avgTimeToFirstFactSeconds == null ? 'N/A' : formatSeconds(data.timing.avgTimeToFirstFactSeconds)} />
                    </div>
                  </Panel>

                  <Panel className="min-w-0 p-2.5">
                    <SectionLabel index="任务" right={<Activity className="size-3.5 text-faint" aria-hidden="true" />}>任务细分</SectionLabel>
                    <div className="mt-2 grid grid-cols-4 gap-x-2 gap-y-0.5">
                      {[
                        { label: '总数', value: data.tasks.total },
                        { label: '已尝试', value: data.tasks.attempted ?? 0 },
                        { label: '完成', value: data.tasks.done ?? 0, tone: 'lime' as const },
                        { label: '失败', value: data.tasks.failed ?? 0, tone: (data.tasks.failed ?? 0) > 0 ? 'ember' as const : undefined },
                        { label: '耗尽', value: data.tasks.exhausted ?? 0 },
                        { label: '已交还', value: data.tasks.handedBack ?? 0 },
                        { label: '重试', value: data.tasks.retried ?? 0 },
                        { label: '卡死', value: data.tasks.stuck ?? 0, tone: (data.tasks.stuck ?? 0) > 0 ? 'ember' as const : undefined },
                      ].map(row => <MiniRow key={row.label} {...row} />)}
                    </div>
                  </Panel>
                </div>

                <div className="grid gap-2 lg:grid-cols-3">
                  <Panel className="min-w-0 p-2.5">
                    <SectionLabel index="项目" right={<Target className="size-3.5 text-faint" aria-hidden="true" />}>项目</SectionLabel>
                    <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
                      <MiniRow label="总数" value={data.missions.total} />
                      <MiniRow label="进行中" value={data.missions.active} tone={data.missions.active > 0 ? 'lime' : undefined} />
                      <MiniRow label="已完成" value={data.missions.completed} tone="lime" />
                      <MiniRow label="失败" value={data.missions.failed} tone={data.missions.failed > 0 ? 'ember' : undefined} />
                    </div>
                    <Bar label="完成 / 总数" value={data.missions.completed} total={data.missions.total} />
                  </Panel>

                  <Panel className="min-w-0 p-2.5">
                    <SectionLabel index="发现" right={<FileCheck2 className="size-3.5 text-faint" aria-hidden="true" />}>发现</SectionLabel>
                    <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
                      <MiniRow label="总数" value={data.findings.total} />
                      <MiniRow label="已接受" value={data.findings.accepted} tone="lime" />
                      <MiniRow label="已验证" value={data.findings.validated} tone="lime" />
                      <MiniRow label="待复核" value={data.findings.needsReview} tone={data.findings.needsReview > 0 ? 'ember' : undefined} />
                      <MiniRow label="已拒绝" value={data.findings.rejected} />
                      <MiniRow label="自动合并" value={data.findings.merged} />
                    </div>
                  </Panel>

                  <Panel className="min-w-0 p-2.5">
                    <SectionLabel index="证据" right={<Database className="size-3.5 text-faint" aria-hidden="true" />}>证据与拦截</SectionLabel>
                    <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
                      <MiniRow label="证据总数" value={data.evidence.total} />
                      <MiniRow label="目标证据" value={data.evidence.target} />
                      <MiniRow label="互联网证据" value={data.evidence.internet} />
                    </div>
                  </Panel>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </>
      )}
    </div>
  );
}

function IndicatorCard({ indicator }: { indicator: Indicator }) {
  const unavailable = indicator.value === null;
  const isEvidenceDepth = indicator.id === 'evidence_depth';
  const display = isEvidenceDepth && indicator.value !== null
    ? `${indicator.value.toFixed(2)} 条`
    : formatIndicatorValue(indicator);
  const suffix = isEvidenceDepth
    ? '证据 / validated finding'
    : indicator.unit === 'tokens' ? indicatorUnitLabel(indicator.unit) : indicator.unit;
  return (
    <div className="min-w-0 border-b border-r border-line bg-ink px-3 py-2.5" data-indicator={indicator.id}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="micro truncate">{indicator.label}</p>
          <p className="mono mt-0.5 truncate text-[8px] uppercase tracking-[0.08em] text-faint">{indicator.id}</p>
        </div>
        <Hint label={indicatorHint(indicator)}>
          <span className="mt-0.5 inline-flex size-4 shrink-0 cursor-help items-center justify-center rounded-full border border-line text-faint hover:border-muted hover:text-muted">
            <Info className="size-2.5" aria-hidden="true" />
          </span>
        </Hint>
      </div>
      <p className={cn('display mt-2 text-xl leading-none', unavailable ? 'text-faint' : 'text-paper')}>{display}</p>
      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
        <span className="text-[8px] uppercase tracking-[0.08em] text-faint">{suffix}</span>
        <span className="mono text-[8px] text-faint">
          {indicator.numerator === null ? 'N/A' : compactNumber(indicator.numerator)} / {indicator.denominator === null ? 'N/A' : compactNumber(indicator.denominator)}
        </span>
      </div>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 border border-line bg-ink-2 px-2.5 py-2">
      <p className="truncate text-[8px] uppercase tracking-[0.1em] text-faint">{label}</p>
      <p className="display mt-1 truncate text-base text-paper">{value}</p>
    </div>
  );
}

function MiniLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 border-b border-line pb-1.5 last:border-0 last:pb-0">
      <span className="text-[9px] uppercase tracking-[0.1em] text-faint">{label}</span>
      <span className="display text-sm text-paper">{value}</span>
    </div>
  );
}

function MiniRow({ label, value, tone }: { label: string; value: number; tone?: 'lime' | 'ember' }) {
  return (
    <div className="flex items-baseline justify-between gap-2 border-b border-line/60 py-0">
      <span className="text-[9px] uppercase tracking-[0.08em] text-faint">{label}</span>
      <span className={cn('mono text-[11px]', tone === 'lime' ? 'text-lime' : tone === 'ember' ? 'text-ember' : 'text-paper')}>{value}</span>
    </div>
  );
}

function Bar({ label, value, total }: { label: string; value: number; total: number }) {
  const share = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div className="mt-2">
      <div className="mb-1 flex items-center justify-between text-[8px] uppercase tracking-[0.08em] text-faint">
        <span>{label}</span>
        <span className="mono">{share}%</span>
      </div>
      <div className="h-px w-full bg-line">
        <div className="h-px bg-lime" style={{ width: `${share}%` }} />
      </div>
    </div>
  );
}
