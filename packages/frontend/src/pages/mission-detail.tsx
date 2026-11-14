import {
  ArrowLeft,
  ArrowRight,
  BellRing,
  BrainCircuit,
  CheckCheck,
  Clock3,
  FileText,
  ListChecks,
  ScrollText,
  ShieldCheck,
  TriangleAlert,
  Radio,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, Navigate, useParams, useSearchParams } from 'react-router-dom';
import { DetailPanel } from '../components/detail-panel';
import { HintComposer } from '../components/hint-composer';
import { PriorWorkPanel } from '../components/prior-work-panel';
import { ScopeUpgradeForm } from '../components/scope-upgrade-form';
import { MissionActions } from '../components/mission-actions';
import { MissionArtifactsPanel } from '../components/mission-artifacts-panel';
import { AdminMissionDelete } from '../components/admin-mission-delete';
import { MissionSummaryPanel } from '../components/mission-summary-panel';
import { MissionViewsNav } from '../components/mission-views';
import { PageHeader } from '../components/shell';
import { ApprovalStatusBadge, MissionStatus } from '../components/status-badge';
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Panel,
  SectionLabel,
  Skeleton,
  TabContent,
  TabTrigger,
  TabsList,
  TabsRoot,
} from '../components/ui';
import { approvalTypeLabel, failureClassLabel, formatDate, formatShortDate, hintKindLabel, hintStateLabel, missionTargetLabel, todoStatusLabel, triggerKindLabel, triggerRouteLabel } from '../lib/format';
import { api } from '../lib/api';
import { useAsync, useMissionStream } from '../lib/hooks';
import type { MissionDetail as MissionDetailType, TaskState } from '../lib/types';
import { cn } from '../lib/utils';

const TERMINAL_TASK_STATES: TaskState[] = ['verified', 'done', 'cancelled', 'exhausted', 'stale'];
type TabValue = 'prior' | 'todo' | 'artifacts' | 'signals' | 'approvals' | 'planner';
const VALID_TABS: TabValue[] = ['prior', 'todo', 'artifacts', 'signals', 'approvals', 'planner'];
const LEGACY_VIEWS: Record<string, string> = { tasks: 'dag', board: 'board', blackboard: 'blackboard' };

export function MissionDetail() {
  const { id } = useParams<{ id: string }>();
  const missionState = useAsync(() => apiMission(id), [id]);
  const stream = useMissionStream(id);
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get('tab') as TabValue | null;
  const initialTab = requestedTab && VALID_TABS.includes(requestedTab) ? requestedTab : 'prior';
  const [tab, setTab] = useState<TabValue>(initialTab);
  const [priorOpen, setPriorOpen] = useState(false);
  const [triggersOpen, setTriggersOpen] = useState(false);
  const [hintsOpen, setHintsOpen] = useState(false);
  const [approvalsOpen, setApprovalsOpen] = useState(false);
  useEffect(() => setTab(requestedTab && VALID_TABS.includes(requestedTab) ? requestedTab : 'prior'), [requestedTab]);
  const requestedTask = searchParams.get('task');

  function changeTab(value: TabValue): void {
    setTab(value);
    const next = new URLSearchParams(searchParams);
    next.set('tab', value);
    setSearchParams(next, { replace: true });
  }

  if (!id) {
    return <ErrorState error="缺少项目 ID。" />;
  }
  const legacyView = requestedTab ? LEGACY_VIEWS[requestedTab] : null;
  if (legacyView) {
    return <Navigate to={`/missions/${id}/${legacyView}${requestedTask ? `?task=${encodeURIComponent(requestedTask)}` : ''}`} replace />;
  }
  if (missionState.loading) {
    return (
      <div className="mx-auto w-full max-w-[1500px] space-y-4">
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }
  if (missionState.error || !missionState.data) {
    return <ErrorState error={missionState.error ?? '项目不存在。'} retry={missionState.refresh} />;
  }

  const mission = missionState.data;
  const openTasks = mission.tasks.filter(task => !TERMINAL_TASK_STATES.includes(task.state));

  return (
    <div className="mx-auto w-full max-w-[1500px]">
      <div className="mb-4 flex flex-wrap items-center gap-3 text-[10px] uppercase tracking-[0.16em] text-faint">
        <Link to="/missions" className="inline-flex items-center gap-1 hover:text-lime"><ArrowLeft className="size-3" aria-hidden="true" />项目列表</Link>
        <span className="h-px w-6 bg-line" aria-hidden="true" />
        <span className="mono">{mission.id.slice(0, 8)}</span>
        <span className="h-px w-6 bg-line" aria-hidden="true" />
        <span>{mission.workerId ?? 'unassigned'}</span>
      </div>

      <PageHeader
        index={`01 / 项目 / ${mission.id.slice(0, 6)}`}
        title={<span className="break-words">{mission.name}</span>}
        description={mission.objective ?? undefined}
        actions={
          <>
            <MissionActions mission={mission} onDone={missionState.refresh} />
            <AdminMissionDelete missionId={mission.id} missionName={mission.name} />
            <Link to="/findings" className="btn btn-ghost">
              <FileText className="size-3.5" aria-hidden="true" />
              查找发现
            </Link>
          </>
        }
        aside={
          <div className="space-y-3 text-left lg:text-right">
            <div className="flex items-center gap-2 lg:justify-end"><MissionStatus state={mission.state} /></div>
            <p className="mono break-all text-xs text-muted">{missionTargetLabel(mission.target)}</p>
            <div className="flex flex-wrap gap-2 lg:justify-end">
              <span className="chip cursor-default">发现 {mission.findingsCount}</span>
              <span className="chip cursor-default">任务 {mission.tasks.length}</span>
              <span className="chip cursor-default">开放 {openTasks.length}</span>
              {mission.failureClass ? <span className="chip cursor-default text-ember">失败原因 {failureClassLabel(mission.failureClass)}</span> : null}
            </div>
          </div>
        }
      />

      {/* live strip */}
      <div className="mb-6 flex flex-wrap items-center gap-3 border border-line bg-panel px-4 py-3">
        <span className={cn('inline-flex items-center gap-2 text-[10px] uppercase tracking-[0.16em]', stream.connected ? 'text-lime' : 'text-faint')}>
          <Radio className={cn('size-3', stream.connected && 'pulse-dot')} aria-hidden="true" />
          {stream.connected ? 'SSE 实时' : 'SSE 重连中'}
        </span>
        <span className="h-3 w-px bg-line" aria-hidden="true" />
        <LiveStat label="state" value={stream.frame?.state ?? mission.state} />
        <LiveStat label="findings" value={String(stream.frame?.findings ?? mission.findingsCount)} />
        <LiveStat label="tasks" value={String(stream.frame?.tasks ?? mission.tasks.length)} />
        <LiveStat label="open" value={String(stream.frame?.openTasks ?? openTasks.length)} />
        <LiveStat label="approvals" value={String(stream.frame?.pendingApprovals ?? mission.approvals.filter(approval => approval.status === 'pending').length)} />
        <span className="mono ml-auto text-[10px] text-faint">last frame {stream.frame?.updatedAt ? formatShortDate(stream.frame.updatedAt) : '—'}</span>
        {stream.gone ? (
          <span className="inline-flex items-center gap-1 text-[10px] text-ember"><TriangleAlert className="size-3" aria-hidden="true" />进度流已结束，项目可能已终止</span>
        ) : null}
      </div>

      {/* summary strip */}
      <div className="grid gap-px border border-line bg-line sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCell label="目标" value={missionTargetLabel(mission.target)} mono />
        <SummaryCell label="创建时间" value={formatDate(mission.createdAt)} />
        <SummaryCell label="完成时间" value={formatDate(mission.completedAt)} />
        <SummaryCell label="checkpoint" value={`${Object.keys(mission.checkpoint).length} keys${mission.pausedAt ? ' · paused' : ''}`} />
      </div>

      <div className="mt-8">
        <MissionSummaryPanel missionId={mission.id} />
        <MissionViewsNav missionId={mission.id} active="overview" />
        <TabsRoot value={tab} onValueChange={value => changeTab(value as TabValue)}>
          <TabsList>
            <TabTrigger value="prior">先验工作</TabTrigger>
            <TabTrigger value="todo" count={mission.todo.length}>待办</TabTrigger>
            <TabTrigger value="artifacts">样本</TabTrigger>
            <TabTrigger value="signals" count={mission.triggers.length + mission.hints.length}>信号与提示</TabTrigger>
            <TabTrigger value="approvals" count={mission.approvals.length}>审批</TabTrigger>
            <TabTrigger value="planner" count={mission.plannerRuns.length}>Planner 运行</TabTrigger>
          </TabsList>

          <TabContent value="prior">
            <Panel className="flex flex-col p-4">
              <SectionLabel index="先验工作">先验工作</SectionLabel>
              <p className="mt-2 text-xs leading-relaxed text-muted">
                同一项目内跨任务轨迹的结构化聚合，包含统计、已尝试任务和 Worker claim 时实际看到的 digest。
              </p>
              <p className="mono mt-3 text-[10px] text-faint">只读 · 不包含请求/响应正文</p>
              <div className="mt-4">
                <Button variant="outline" onClick={() => setPriorOpen(true)}>查看详情</Button>
              </div>
            </Panel>
          </TabContent>

          <TabContent value="todo">
            {mission.todo.length === 0 ? (
              <EmptyState icon={<ListChecks className="size-6" aria-hidden="true" />} title="暂无待办" hint="Planner 生成 mission_todo 后会显示在这里。" />
            ) : (() => {
              const ordered = mission.todo.toSorted((left, right) => left.position - right.position);
              const focus = ordered.find(item => item.status !== 'done');
              return (
                <div className="space-y-3">
                  <div className="border border-line bg-ink-2 px-4 py-3">
                    <p className="micro">当前焦点 · 只读派生</p>
                    <p className="mt-1 text-sm text-paper">{focus?.content ?? '所有待办已完成'}</p>
                    <p className="micro mt-2 normal-case tracking-normal text-faint">串行/并行由 tasks.dependsOn + readiness 决定；position 仅用于展示顺序。</p>
                  </div>
                  <ol className="space-y-2">
                    {ordered.map(item => (
                      <li key={item.id} className="flex items-start gap-4 border border-line bg-panel px-4 py-3">
                        <span className="mono mt-0.5 text-[10px] text-faint">{String(item.position).padStart(2, '0')}</span>
                        <div className="min-w-0 flex-1">
                          <p className={cn('text-sm', item.status === 'done' ? 'text-muted line-through' : 'text-paper')}>{item.content}</p>
                          <Badge tone={item.status === 'done' ? 'lime' : item.status === 'blocked' ? 'ember' : item.status === 'in_progress' ? 'sky' : 'muted'} className="mt-1">{todoStatusLabel(item.status)}</Badge>
                        </div>
                        {item.status === 'done' ? <CheckCheck className="size-4 text-emerald-300" aria-hidden="true" /> : <Clock3 className="size-4 text-faint" aria-hidden="true" />}
                      </li>
                    ))}
                  </ol>
                </div>
              );
            })()}
          </TabContent>

          <TabContent value="artifacts">
            <MissionArtifactsPanel missionId={mission.id} />
          </TabContent>

          <TabContent value="signals">
            <div className="grid gap-4 md:grid-cols-2">
              <Panel className="flex flex-col p-4">
                <SectionLabel index="触发器" right={<span className="mono text-[10px] text-faint">{mission.triggers.length}</span>}>触发器</SectionLabel>
                <p className="mt-2 text-xs leading-relaxed text-muted">watchdog 检测到重复请求、拦截激增或无进展时生成的调度信号。</p>
                {mission.triggers.length > 0 ? (
                  <div className="mt-3 border border-line bg-ink-2 px-3 py-2.5">
                    <p className="text-xs text-paper">{triggerKindLabel(mission.triggers[0]!.kind)} · {triggerRouteLabel(mission.triggers[0]!.route)}</p>
                    <p className="mono mt-1 text-[10px] text-faint">{mission.triggers[0]!.source} · {formatShortDate(mission.triggers[0]!.createdAt)}</p>
                  </div>
                ) : (
                  <p className="mt-3 text-xs text-faint">暂无触发器。</p>
                )}
                <div className="mt-auto pt-4"><Button variant="outline" onClick={() => setTriggersOpen(true)}>查看详情</Button></div>
              </Panel>
              <Panel className="flex flex-col p-4">
                <SectionLabel index="提示" right={<span className="mono text-[10px] text-faint">{mission.hints.length}</span>}>提示队列</SectionLabel>
                <p className="mt-2 text-xs leading-relaxed text-muted">人工或 Planner 写入的上下文提示，在下一轮由 Worker/Planner 消费。</p>
                {mission.hints.length > 0 ? (
                  <div className="mt-3 border border-line bg-ink-2 px-3 py-2.5">
                    <div className="flex flex-wrap items-center gap-2"><Badge tone={mission.hints.at(-1)!.kind === 'help' ? 'ember' : mission.hints.at(-1)!.kind === 'report' ? 'violet' : 'muted'}>{hintKindLabel(mission.hints.at(-1)!.kind)}</Badge><span className="mono text-[10px] text-faint">{hintStateLabel(mission.hints.at(-1)!.state)}</span></div>
                    <p className="mt-1.5 line-clamp-2 text-xs text-paper">{mission.hints.at(-1)!.content}</p>
                  </div>
                ) : (
                  <p className="mt-3 text-xs text-faint">暂无提示。</p>
                )}
                <div className="mt-auto pt-4"><Button variant="outline" onClick={() => setHintsOpen(true)}>查看详情</Button></div>
              </Panel>
            </div>
          </TabContent>

          <TabContent value="approvals">
            <Panel className="flex flex-col p-4">
              <SectionLabel index="审批" right={<span className="mono text-[10px] text-faint">{mission.approvals.length}</span>}>审批队列</SectionLabel>
              <p className="mt-2 text-xs leading-relaxed text-muted">
                人工审批请求与 scope 升级入口。批准后会生成新 Grant 版本并重绑开放任务；审批决策始终由人执行。
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <span className="chip cursor-default">待处理 {mission.approvals.filter(approval => approval.status === 'pending').length}</span>
                <span className="chip cursor-default">全部 {mission.approvals.length}</span>
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                <Button variant="outline" onClick={() => setApprovalsOpen(true)}>打开审批抽屉</Button>
                <Link to="/approvals" className="btn btn-ghost">审批中心</Link>
              </div>
            </Panel>
          </TabContent>

          <TabContent value="planner">
            {mission.plannerRuns.length === 0 ? (
              <EmptyState icon={<BrainCircuit className="size-6" aria-hidden="true" />} title="暂无 Planner 运行" hint="Planner 服务启用并收到信号后，reason pass 会出现在这里。" />
            ) : (
              <div className="grid gap-3 md:grid-cols-2">
                {mission.plannerRuns.map(run => (
                  <Panel key={run.id} className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="mono text-xs text-paper">{run.id.slice(0, 8)}</p>
                        <p className="micro mt-1">{run.state} · {run.actionCount} actions · {run.signalCount} signals</p>
                      </div>
                      <ScrollText className="size-4 text-faint" aria-hidden="true" />
                    </div>
                    {run.reason ? <p className="mt-3 line-clamp-3 text-xs leading-relaxed text-muted">{run.reason}</p> : null}
                    <div className="mt-3 flex items-center justify-between text-[10px] text-faint">
                      <span className="mono">{formatShortDate(run.startedAt)}</span>
                      <Link to={`/trace/planner/${run.id}?mission=${mission.id}&tab=planner`} className="inline-flex items-center gap-1 text-lime hover:underline">
                        轨迹 <ArrowRight className="size-3" aria-hidden="true" />
                      </Link>
                    </div>
                  </Panel>
                ))}
              </div>
            )}
          </TabContent>
        </TabsRoot>
      </div>

      <DetailPanel open={priorOpen} onOpenChange={setPriorOpen} title="先验工作" description="同项目跨任务的只读轨迹聚合；digest 可能包含目标内容，按不可信数据处理。">
        <PriorWorkPanel missionId={mission.id} />
      </DetailPanel>

      <DetailPanel open={triggersOpen} onOpenChange={setTriggersOpen} title="触发器" description="watchdog 生成的调度信号；direct 直通 Worker，planner 进入规划。">
        {mission.triggers.length === 0 ? (
          <EmptyState icon={<BellRing className="size-6" aria-hidden="true" />} title="暂无触发器" hint="watchdog 检测到重复请求、拦截激增或无进展时会生成。" />
        ) : (
          <ul className="divide-y divide-line">
            {mission.triggers.map(trigger => (
              <li key={trigger.id} className="py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-paper">{triggerKindLabel(trigger.kind)}</span>
                  <span className="chip cursor-default">{triggerRouteLabel(trigger.route)}</span>
                  <span className="chip cursor-default">{trigger.state}</span>
                </div>
                <p className="mono mt-1.5 text-[10px] text-faint">{trigger.source} · {formatShortDate(trigger.createdAt)}</p>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-4 border-t border-line pt-4 text-xs leading-relaxed text-muted">
          trigger 是调度层信号：direct 直通 Worker，planner 进入 Planner 规划。人工提示请使用提示队列，不直接修改任务状态。
        </p>
      </DetailPanel>

      <DetailPanel open={hintsOpen} onOpenChange={setHintsOpen} title="提示队列" description="人工或 Planner 写入的上下文提示；下一轮消费，不直接改写任务状态。">
        <HintComposer missionId={mission.id} onCreated={missionState.refresh} />
        <div className="mt-4">
          {mission.hints.length === 0 ? (
            <p className="text-sm text-muted">暂无提示。人工提示会在下一轮上下文注入。</p>
          ) : (
            <ul className="divide-y divide-line">
              {mission.hints.map(hint => (
                <li key={hint.id} className="py-3">
                  <div className="mb-1.5 flex flex-wrap items-center gap-2">
                    <Badge tone={hint.kind === 'help' ? 'ember' : hint.kind === 'report' ? 'violet' : 'muted'}>{hintKindLabel(hint.kind)}</Badge>
                    <span className="mono text-[10px] text-faint">{hint.source} · {hintStateLabel(hint.state)}</span>
                  </div>
                  <p className="text-xs leading-relaxed text-paper">{hint.content}</p>
                  <p className="mono mt-1.5 text-[10px] text-faint">{formatShortDate(hint.createdAt)}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DetailPanel>

      <DetailPanel open={approvalsOpen} onOpenChange={setApprovalsOpen} title="审批队列" description="申请授权升级并查看审批状态；审批只记录决策，不会自动修改 Grant。">
        <ScopeUpgradeForm missionId={mission.id} onRequested={missionState.refresh} />
        <div className="mt-4">
          {mission.approvals.length === 0 ? (
            <EmptyState icon={<ShieldCheck className="size-6" aria-hidden="true" />} title="暂无审批请求" hint="高风险操作会生成审批；决策会落库并写审计事件。" />
          ) : (
            <ul className="divide-y divide-line border-y border-line">
              {mission.approvals.map(approval => (
                <li key={approval.id} className="flex flex-wrap items-center justify-between gap-4 py-4">
                  <div className="min-w-0">
                    <p className="text-sm text-paper">{approvalTypeLabel(approval.type)} · {approval.id.slice(0, 8)}</p>
                    <p className="mono mt-1 text-[10px] text-faint">created {formatShortDate(approval.createdAt)} · decidedBy {approval.decidedBy ?? '—'}</p>
                  </div>
                  <ApprovalStatusBadge status={approval.status} />
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="mt-4"><Link to="/approvals" className="link-underline text-xs text-lime">打开审批中心</Link></div>
      </DetailPanel>
    </div>
  );
}

async function apiMission(id: string | undefined): Promise<MissionDetailType> {
  if (!id) throw new Error('missing mission id');
  const response = await api.getMission(id);
  return response.mission;
}

function LiveStat({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-baseline gap-1.5 text-[10px] uppercase tracking-[0.12em] text-faint">
      {label}
      <span className="mono text-paper">{value}</span>
    </span>
  );
}

function SummaryCell({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="bg-ink px-4 py-3">
      <p className="micro">{label}</p>
      <p className={cn('mt-1 break-all text-xs text-paper', mono && 'mono')}>{value}</p>
    </div>
  );
}
