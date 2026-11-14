import { ArrowUpRight, Ban, Filter, GitBranch, Info, Plus, RefreshCw, RotateCcw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { DagView } from '../components/dag';
import { MissionViewHeader } from '../components/mission-views';
import { TaskStatus } from '../components/status-badge';
import { Badge, Button, EmptyState, ErrorState, Field, Modal, Panel, SectionLabel, Skeleton, Textarea } from '../components/ui';
import { SpringSelect } from '../components/spring-select';
import { api } from '../lib/api';
import { useToast } from '../components/toast';
import { useAuth } from '../lib/auth';
import { canOperate } from '../lib/permissions';
import { formatBytes, taskAngleLabel, taskLabel } from '../lib/format';
import { useAsync } from '../lib/hooks';
import type { Task, TaskAngle } from '../lib/types';
import { cn } from '../lib/utils';

const TERMINAL: Task['state'][] = ['verified', 'done', 'cancelled', 'exhausted', 'stale'];
const ANGLES: Array<TaskAngle | null> = ['web', 'api', 'infra', 'binary', null];
const ANGLE_FILTER_LABELS: Record<TaskAngle, string> = { web: 'Web', api: 'API', infra: '基础设施', binary: '二进制' };

export function MissionDag() {
  const { id } = useParams<{ id: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTask = searchParams.get('task');
  const [selectedTask, setSelectedTask] = useState<string | null>(requestedTask);
  const [angleFilter, setAngleFilter] = useState<'all' | TaskAngle | 'none'>('all');
  const state = useAsync(async () => (await api.getMission(id ?? '')).mission, [id]);
  const toast = useToast();
  const { user } = useAuth();
  const writable = canOperate(user);
  const [spawnOpen, setSpawnOpen] = useState(false);
  const [objective, setObjective] = useState('');
  const [spawnAngle, setSpawnAngle] = useState<'' | TaskAngle>('');
  const [acting, setActing] = useState<string | null>(null);
  const [spawnArtifactIds, setSpawnArtifactIds] = useState<string[]>([]);
  const artifactsState = useAsync(() => (id ? api.listMissionArtifacts(id).then(result => result.artifacts) : Promise.resolve([])), [id]);

  useEffect(() => setSelectedTask(requestedTask), [requestedTask]);

  function selectTask(taskId: string | null): void {
    setSelectedTask(taskId);
    const next = new URLSearchParams(searchParams);
    if (taskId) next.set('task', taskId);
    else next.delete('task');
    setSearchParams(next, { replace: true });
  }

  async function spawnTask(): Promise<void> {
    if (!id || !objective.trim()) return;
    setActing('spawn');
    try {
      await api.createManualTask(id, {
        objective: objective.trim(),
        ...(spawnAngle ? { angle: spawnAngle } : {}),
        ...(spawnArtifactIds.length > 0 ? { artifactIds: spawnArtifactIds } : {}),
      });
      toast('success', '已手动派发任务，等待调度器领取。');
      setObjective('');
      setSpawnAngle('');
      setSpawnArtifactIds([]);
      setSpawnOpen(false);
      state.refresh();
    } catch (error) {
      toast('error', error instanceof Error ? error.message : String(error));
    } finally {
      setActing(null);
    }
  }

  async function cancelTask(task: Task): Promise<void> {
    if (!id) return;
    setActing(`cancel:${task.id}`);
    try {
      await api.cancelTask(id, task.id, 'cancelled from DAG');
      toast('success', '任务已取消；后续调度不会再领取该任务。');
      state.refresh();
    } catch (error) {
      toast('error', error instanceof Error ? error.message : String(error));
    } finally {
      setActing(null);
    }
  }

  async function confirmRetry(task: Task): Promise<void> {
    if (!id) return;
    setActing(`retry:${task.id}`);
    try {
      const result = await api.confirmTaskRetry(id, task.id);
      toast('success', `已确认 ${result.actionCount ?? 0} 条目标写动作，任务将重新进入调度。`);
      state.refresh();
    } catch (error) {
      toast('error', error instanceof Error ? error.message : String(error));
    } finally {
      setActing(null);
    }
  }

  if (!id) return <ErrorState error="缺少项目 ID。" />;
  if (state.loading) return <div className="mx-auto w-full max-w-[1500px] space-y-4"><Skeleton className="h-28 w-full" /><Skeleton className="h-96 w-full" /></div>;
  if (state.error || !state.data) return <ErrorState error={state.error ?? '项目不存在。'} retry={state.refresh} />;
  const mission = state.data;
  const tasks = mission.tasks;
  const filtered = angleFilter === 'all'
    ? tasks
    : tasks.filter(task => angleFilter === 'none' ? task.angle === null : task.angle === angleFilter);
  const open = filtered.filter(task => !TERMINAL.includes(task.state));
  const angleCounts = new Map<string, number>();
  for (const task of tasks) angleCounts.set(task.angle ?? 'none', (angleCounts.get(task.angle ?? 'none') ?? 0) + 1);

  return (
    <div className="mx-auto w-full max-w-[1500px]">
      <MissionViewHeader
        mission={mission}
        active="dag"
        index={`01 / 项目 / 依赖图 / ${mission.id.slice(0, 6)}`}
        title={<>任务依赖图</>}
        description=""
        actions={<div className="flex flex-wrap gap-2">{writable ? <Button variant="primary" icon={<Plus className="size-3.5" aria-hidden="true" />} onClick={() => { setSpawnOpen(true); void artifactsState.refresh(); }}>手动派任务</Button> : null}<Button variant="outline" icon={<RefreshCw className="size-3.5" aria-hidden="true" />} onClick={state.refresh}>刷新</Button></div>}
        aside={
          <div className="grid grid-cols-3 gap-px border border-line bg-line text-left">
            <Stat label="任务" value={tasks.length} />
            <Stat label="进行中" value={open.length} />
            <Stat label="依赖边" value={tasks.reduce((sum, task) => sum + task.dependsOn.length, 0)} />
          </div>
        }
      />

      <div className="space-y-4">
        <Panel className="p-4">
          <SectionLabel index="任务图" right={<span className="mono text-[10px] text-faint">点击节点查看</span>}>依赖图</SectionLabel>
          <DagView tasks={tasks} missionId={mission.id} selectedId={selectedTask} onSelect={value => selectTask(value === selectedTask ? null : value)} />
          {tasks.length <= 1 ? (
            <div className="mt-3 flex items-start gap-2 border border-line bg-ink-2 px-3 py-2.5 text-[11px] leading-relaxed text-muted">
              <Info className="mt-0.5 size-3.5 shrink-0 text-faint" aria-hidden="true" />
              <p><span className="text-paper">为什么只有一个节点？</span> 当前任务由 Goal Compiler 的 bootstrap 单任务直接执行；Planner 尚未展开计划（本轮 Planner 运行 {mission.plannerRuns.length} 次），因此没有 dependsOn 依赖边。</p>
            </div>
          ) : null}
        </Panel>

        <Panel className="flex min-h-[420px] flex-col p-4">
          <SectionLabel index="任务列表" right={<span className="mono text-[10px] text-faint">{filtered.length} / {tasks.length}</span>}>任务与角度</SectionLabel>
          <div className="mb-3 flex flex-wrap items-center gap-1.5">
            <Filter className="mr-1 size-3 text-faint" aria-hidden="true" />
            <FilterChip active={angleFilter === 'all'} onClick={() => setAngleFilter('all')}>全部 {tasks.length}</FilterChip>
            {ANGLES.map(angle => (
              <FilterChip key={angle ?? 'none'} active={angleFilter === (angle ?? 'none')} onClick={() => setAngleFilter(angle ?? 'none')}>
                {angle ? ANGLE_FILTER_LABELS[angle] : '未指定'} {angleCounts.get(angle ?? 'none') ?? 0}
              </FilterChip>
            ))}
          </div>
          {filtered.length === 0 ? (
            <EmptyState icon={<GitBranch className="size-6" aria-hidden="true" />} title="没有匹配任务" hint="调整角度筛选，或等待 Planner 展开计划。" />
          ) : (
            <ul className="max-h-[640px] divide-y divide-line overflow-auto">
              {filtered.map(task => (
                <li key={task.id} className={cn('py-3', selectedTask === task.id && 'bg-paper/[0.03]')}>
                  <div className="flex items-start justify-between gap-3">
                    <button type="button" onClick={() => selectTask(task.id === selectedTask ? null : task.id)} className="min-w-0 flex-1 text-left" aria-pressed={selectedTask === task.id}>
                      <div className="flex flex-wrap items-center gap-2">
                        <AngleBadge angle={task.angle} />
                        <span className="mono text-[10px] text-faint">{task.id.slice(0, 8)}</span>
                      </div>
                      <p className="mt-1.5 line-clamp-2 text-xs text-paper">{taskTitle(task)}</p>
                      <p className="mono mt-1 text-[10px] text-faint">第 {task.attempt} 次尝试 · 依赖 {task.dependsOn.length} · {taskLabel(task.state)}</p>
                    </button>
                    <div className="flex shrink-0 flex-col items-end gap-2">
                      <TaskStatus state={task.state} />
                      <Link to={`/trace/worker/${task.id}?mission=${mission.id}&tab=dag&task=${task.id}`} className="inline-flex items-center gap-1 border border-line px-2 py-1 text-[9px] uppercase tracking-[0.1em] text-muted hover:border-lime/40 hover:text-lime">
                        轨迹 <ArrowUpRight className="size-3" aria-hidden="true" />
                      </Link>
                      {writable && !TERMINAL.includes(task.state) ? (
                        <Button variant="ghost" disabled={acting !== null} icon={<Ban className="size-3" aria-hidden="true" />} onClick={() => { if (window.confirm('取消这个任务？运行中的报告会被 fencing 丢弃。')) void cancelTask(task); }}>
                          取消
                        </Button>
                      ) : null}
                      {writable && task.state === 'blocked' && task.lastError?.includes('write_actions_require_confirmation') ? (
                        <Button variant="outline" disabled={acting !== null} icon={<RotateCcw className="size-3" aria-hidden="true" />} onClick={() => { if (window.confirm('确认该任务之前的写动作已核对，允许重试？')) void confirmRetry(task); }}>
                          确认重试
                        </Button>
                      ) : null}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-auto border-t border-line pt-3 text-[10px] uppercase tracking-[0.12em] text-faint">
            同一任务未终态最多 2 个不同角度 · 角度由 Planner 设定
          </p>
        </Panel>
      </div>

      <Modal
        open={spawnOpen}
        onOpenChange={setSpawnOpen}
        title="手动派发任务"
        description="绕过 Planner 直接写入一个独立 intent；仍受任务 scope、开放任务上限和调度器约束。"
        footer={
          <>
            <Button variant="ghost" onClick={() => setSpawnOpen(false)}>取消</Button>
            <Button variant="primary" disabled={acting === 'spawn' || !objective.trim()} onClick={() => void spawnTask()}>
              {acting === 'spawn' ? '派发中…' : '确认派发'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="任务目标" hint="写清要验证的具体方向；不要复述整个 mission。">
            <Textarea value={objective} onChange={event => setObjective(event.target.value)} placeholder="例如：验证 /admin 的越权访问与角色边界" />
          </Field>
          <Field label="攻击角度">
            <SpringSelect<'' | TaskAngle>
              value={spawnAngle}
              onChange={setSpawnAngle}
              ariaLabel="任务攻击角度"
              fullWidth
              size="field"
              options={[{ value: '', label: '不指定' }, { value: 'web', label: 'web' }, { value: 'api', label: 'api' }, { value: 'infra', label: 'infra' }, { value: 'binary', label: 'binary' }]}
            />
          </Field>
          <Field label="样本（可选）" hint="仅可选择当前项目已上传的样本；Agent 将通过 reverse 工具使用，artifact 过期后提交会返回 400。">
            {artifactsState.loading ? (
              <p className="text-xs text-muted">加载样本…</p>
            ) : artifactsState.error ? (
              <div className="flex flex-wrap items-center gap-2 text-xs text-ember">
                <span>样本加载失败：{String(artifactsState.error)}</span>
                <Button variant="ghost" onClick={() => void artifactsState.refresh()}>重试</Button>
              </div>
            ) : (artifactsState.data?.length ?? 0) === 0 ? (
              <p className="border border-dashed border-line px-3 py-2.5 text-xs text-muted">暂无上传样本；可先在项目详情「样本」Tab 上传 APK / ELF / SO / DEX / JAR / JS。</p>
            ) : (
              <div className="max-h-36 divide-y divide-line overflow-y-auto border border-line bg-ink-2/50">
                {artifactsState.data?.map(artifact => (
                  <label key={artifact.id} className="flex cursor-pointer items-center gap-2 px-2.5 py-2 text-xs hover:bg-paper/[0.03]">
                    <input
                      type="checkbox"
                      className="size-3.5 accent-lime"
                      checked={spawnArtifactIds.includes(artifact.id)}
                      disabled={!spawnArtifactIds.includes(artifact.id) && spawnArtifactIds.length >= 20}
                      onChange={event => setSpawnArtifactIds(current => event.target.checked ? [...current, artifact.id] : current.filter(value => value !== artifact.id))}
                    />
                    <span className="min-w-0 flex-1 truncate text-paper">{artifact.filename}</span>
                    <span className="mono shrink-0 text-[10px] text-faint">{formatBytes(artifact.size)}</span>
                  </label>
                ))}
              </div>
            )}
            {spawnArtifactIds.length > 0 ? <p className="mt-1 text-[10px] text-faint">已选择 {spawnArtifactIds.length} / 20 个样本。</p> : null}
          </Field>
        </div>
      </Modal>
    </div>
  );
}

export function AngleBadge({ angle }: { angle: TaskAngle | null | undefined }) {
  if (!angle) return <span className="inline-flex border border-line px-2 py-0.5 text-[9px] uppercase tracking-[0.1em] text-faint">未指定角度</span>;
  const tone = angle === 'web' ? 'sky' : angle === 'api' ? 'violet' : angle === 'infra' ? 'ember' : 'lime';
  return <Badge tone={tone}>{taskAngleLabel(angle)}</Badge>;
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" onClick={onClick} className={cn('chip', active && 'chip-active')} aria-pressed={active}>{children}</button>;
}

function Stat({ label, value }: { label: string; value: number }) {
  return <div className="bg-ink-2 px-3 py-2.5"><p className="text-[9px] uppercase tracking-[0.12em] text-faint">{label}</p><p className="mono mt-1 text-lg text-paper">{value}</p></div>;
}

function taskTitle(task: Task): string {
  const result = task.result ?? {};
  const goal = typeof result.objective === 'string' ? result.objective : typeof result.goal === 'string' ? result.goal : '';
  return goal || `${task.type} · ${task.id.slice(0, 8)}`;
}

export type { TaskAngle };
