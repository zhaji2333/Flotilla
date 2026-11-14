import { AnimatePresence, motion } from 'motion/react';
import {
  ArrowRight,
  ArrowUpRight,
  CheckCircle2,
  FileText,
  Gauge,
  Radar,
  Target,
} from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { canOperate } from '../lib/permissions';
import { formatShortDate, missionTargetLabel, severityLabel } from '../lib/format';
import { useAsync } from '../lib/hooks';
import type { Severity } from '../lib/types';
import { missionLabel } from '../lib/format';
import { cn } from '../lib/utils';
import { MissionStatus } from '../components/status-badge';
import { ErrorState, Panel, SectionLabel, Skeleton } from '../components/ui';
import { MetricsDashboard } from '../components/metrics-dashboard';

const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

function PostureItem({ label, value, tone }: { label: string; value: string; tone?: 'lime' | 'ember' | 'amber' }) {
  return (
    <div>
      <p className="text-[9px] uppercase tracking-[0.1em] text-faint">{label}</p>
      <p className={cn('mono mt-1 text-sm uppercase', tone === 'lime' ? 'text-lime' : tone === 'ember' ? 'text-ember' : tone === 'amber' ? 'text-amber-300' : 'text-paper')}>{value}</p>
    </div>
  );
}

export function Overview() {
  const { user } = useAuth();
  const writable = canOperate(user);
  const [searchParams, setSearchParams] = useSearchParams();
  const view = searchParams.get('view') === 'metrics' ? 'metrics' : 'overview';
  const health = useAsync(() => api.health(), []);
  const missions = useAsync(() => api.listMissions(), []);
  const findings = useAsync(() => api.listFindings(), []);
  const approvals = useAsync(() => api.listApprovals('pending'), []);

  const missionList = missions.data?.missions ?? [];
  const findingList = findings.data?.findings ?? [];
  const pendingApprovals = approvals.data?.approvals ?? [];
  const severityCounts = SEVERITIES.map(severity => ({
    severity,
    count: findingList.filter(finding => finding.severity === severity).length,
  }));
  const totalFindings = findingList.length;
  const activeMissions = missionList.filter(mission => ['pending', 'running', 'paused'].includes(mission.state)).length;

  function changeView(next: 'overview' | 'metrics'): void {
    const params = new URLSearchParams(searchParams);
    if (next === 'metrics') params.set('view', 'metrics');
    else params.delete('view');
    setSearchParams(params, { replace: true });
  }

  return (
    <div className="mx-auto w-full max-w-[1500px]">
      {/* ── editorial hero ─────────────────────────────── */}
      <section className="relative grid gap-4 overflow-hidden border-b border-line pb-5 lg:grid-cols-[1fr_auto] lg:items-end">
        <div className="relative z-10">
          <div className="mb-2 flex items-center gap-3 text-[10px] uppercase tracking-[0.22em] text-muted">
            <Radar className="size-3.5 text-lime" aria-hidden="true" />
            <span className="mono">00 / OVERVIEW</span>
            <span className="h-px w-12 bg-line" aria-hidden="true" />
            <span>Control Plane</span>
          </div>
          <h1 style={{ textTransform: 'none' }} className="display title-tight text-[clamp(2rem,3.6vw,3rem)] text-paper">
            Flotilla <span className="text-lime">—</span> 自主渗透测试平台
          </h1>
          <p className="mono mt-1.5 text-[9px] uppercase tracking-[0.24em] text-faint">Autonomous Security Research Platform</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {writable ? (
              <Link to="/missions/new" className="btn btn-primary">
                发起新项目
                <ArrowRight className="size-3.5" aria-hidden="true" />
              </Link>
            ) : null}
            <Link to="/missions" className="btn btn-outline">
              全部项目
            </Link>
            <Link to="/approvals" className="btn btn-ghost">审批中心</Link>
            <span className="mono ml-1 text-[10px] text-faint">API v1 · frozen contract</span>
          </div>
        </div>

        <div className="relative w-full border border-line bg-panel/70 p-4 lg:w-[330px]">
          <div className="flex items-center justify-between">
            <span className="micro">System posture</span>
            <span className="pulse-dot inline-block size-1.5 rounded-full bg-lime" aria-hidden="true" />
          </div>
          <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2">
            <PostureItem label="出站模式" value={health.data?.egressMode ?? '—'} tone={health.data?.egressMode === 'open' ? 'ember' : 'lime'} />
            <PostureItem label="进行中项目" value={String(activeMissions)} />
            <PostureItem label="待审批" value={String(pendingApprovals.length)} tone={pendingApprovals.length > 0 ? 'amber' : undefined} />
            <PostureItem label="当前发现" value={String(totalFindings)} />
          </div>
        </div>
      </section>

      <div className="my-6 flex flex-wrap items-center justify-between gap-3 border-y border-line py-3">
        <div className="relative flex items-center gap-1" role="tablist" aria-label="总览视图切换">
          {[
            { value: 'overview' as const, label: '总览态势' },
            { value: 'metrics' as const, label: '数据指标' },
          ].map(tab => {
            const active = view === tab.value;
            return (
              <button
                key={tab.value}
                type="button"
                role="tab"
                aria-selected={active}
                className={cn('relative px-4 py-2 text-[11px] uppercase tracking-[0.14em] transition-colors', active ? 'text-lime' : 'text-muted hover:text-paper')}
                onClick={() => changeView(tab.value)}
              >
                {active ? (
                  <motion.span
                    layoutId="overview-view-pill"
                    className="absolute inset-0 border border-lime/45 bg-lime/10"
                    transition={{ type: 'spring', stiffness: 460, mass: 1, damping: 2 * Math.sqrt(460), velocity: 360 }}
                  />
                ) : null}
                <span className="relative">{tab.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="min-h-[386px]">
      <AnimatePresence mode="wait" initial={false}>
        {view === 'metrics' ? (
          <motion.div
            key="metrics"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ type: 'spring', stiffness: 460, mass: 1, damping: 2 * Math.sqrt(460), velocity: 380 }}
          >
            <MetricsDashboard />
          </motion.div>
        ) : (
          <motion.div
            key="overview"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ type: 'spring', stiffness: 460, mass: 1, damping: 2 * Math.sqrt(460), velocity: 380 }}
          >
      {/* ── stats ──────────────────────────────────────── */}
      <section className="grid grid-cols-2 gap-px border-b border-line bg-line lg:grid-cols-4" aria-label="关键指标">
        {[
          { label: '项目总数', value: missionList.length, icon: Target, hint: '最近 50 条投影' },
          { label: '进行中', value: activeMissions, icon: Gauge, hint: 'pending / running / paused' },
          { label: '发现', value: totalFindings, icon: FileText, hint: '全部 accepted / review' },
          { label: '待审批', value: pendingApprovals.length, icon: CheckCircle2, hint: '需人工决策' },
        ].map(stat => (
          <div key={stat.label} className="bg-ink px-4 py-3">
            <div className="flex items-start justify-between">
              <span className="micro">{stat.label}</span>
              <stat.icon className="size-3.5 text-faint" aria-hidden="true" />
            </div>
            <p className="display mt-2 text-[clamp(1.4rem,2.1vw,1.9rem)] text-paper">{stat.value}</p>
            <p className="mt-0.5 text-[9px] uppercase tracking-[0.1em] text-faint">{stat.hint}</p>
          </div>
        ))}
      </section>

      <div className="mt-4 grid gap-4 lg:grid-cols-[1.35fr_0.65fr]">
        {/* recent missions */}
        <div>
          <Panel className="p-4">
            <SectionLabel index="01" right={<Link to="/missions" className="link-underline text-[10px] uppercase tracking-[0.16em] text-muted hover:text-lime">查看全部</Link>}>
              最近项目
            </SectionLabel>
            {missions.loading ? (
              <div className="space-y-2">
                {Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} className="h-16 w-full" />)}
              </div>
            ) : missions.error ? (
              <ErrorState error={missions.error} retry={missions.refresh} />
            ) : missionList.length === 0 ? (
              <div className="border border-dashed border-line px-5 py-10 text-center">
                <Target className="mx-auto size-6 text-faint" aria-hidden="true" />
                <p className="mt-3 text-sm text-muted">还没有项目。可在项目页创建第一个授权测试项目。</p>
              </div>
            ) : (
              <div className="divide-y divide-line">
                {missionList.slice(0, 3).map(mission => (
                  <div key={mission.id}>
                    <Link to={`/missions/${mission.id}`} className="group grid grid-cols-[28px_minmax(0,1fr)] items-center gap-3 py-2.5 sm:grid-cols-[28px_minmax(0,1fr)_130px_20px]">
                      <span className="mono w-7 text-[10px] text-faint">{mission.id.slice(0, 4)}</span>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="truncate text-sm font-medium text-paper group-hover:text-lime">{mission.name}</span>
                          <MissionStatus state={mission.state} />
                        </div>
                        <p className="mono mt-1 truncate text-[11px] text-faint">{missionTargetLabel(mission.target)} · {formatShortDate(mission.createdAt)}</p>
                      </div>
                      <div className="hidden text-right sm:block">
                        <p className="mono text-xs text-paper">{mission.findingsCount} <span className="text-faint">findings</span></p>
                        <p className="mt-1 text-[10px] text-faint">{missionLabel(mission.state)}</p>
                      </div>
                      <ArrowUpRight className="hidden size-4 justify-self-end text-faint group-hover:text-lime sm:block" aria-hidden="true" />
                    </Link>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </div>

        <div className="space-y-4">
          {/* severity */}
          <div>
            <Panel className="p-4">
              <SectionLabel index="02">信号分布</SectionLabel>
              <div className="space-y-3">
                {severityCounts.map(item => {
                  const share = totalFindings === 0 ? 0 : Math.round((item.count / totalFindings) * 100);
                  return (
                    <div key={item.severity}>
                      <div className="mb-1.5 flex items-center justify-between text-[10px] uppercase tracking-[0.12em]">
                        <span className="text-muted">{severityLabel(item.severity)}</span>
                        <span className="mono text-paper">{item.count} · {share}%</span>
                      </div>
                      <div className="h-px w-full bg-line">
                        <div
                          className={cn('h-px', item.severity === 'critical' ? 'bg-ember' : item.severity === 'high' ? 'bg-orange-300' : item.severity === 'medium' ? 'bg-amber-300' : item.severity === 'low' ? 'bg-sky' : 'bg-muted')}
                          style={{ width: `${share}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </Panel>
          </div>

          <Link to="/approvals" className="inline-flex items-center justify-end gap-1 text-[10px] uppercase tracking-[0.12em] text-lime hover:underline">打开审批中心 <ArrowUpRight className="size-3" aria-hidden="true" /></Link>
        </div>
      </div>
          </motion.div>
        )}
      </AnimatePresence>
      </div>
    </div>
  );
}
