import { ArrowRight, ArrowUpRight, CheckSquare, Plus, Search, Target, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Pager } from '../components/pager';
import { SpringSelect } from '../components/spring-select';
import { MissionStatus } from '../components/status-badge';
import { Button, ErrorState, Input, Modal, Skeleton } from '../components/ui';
import { useToast } from '../components/toast';
import { PageHeader } from '../components/shell';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { canOperate } from '../lib/permissions';
import { formatShortDate, missionLabel, missionTargetLabel } from '../lib/format';
import { useAsync } from '../lib/hooks';
import type { MissionState } from '../lib/types';
import { cn } from '../lib/utils';

const STATES: Array<{ value: 'all' | MissionState; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'running', label: '运行中' },
  { value: 'paused', label: '已暂停' },
  { value: 'pending', label: '待规划' },
  { value: 'completed', label: '已完成' },
  { value: 'failed', label: '失败' },
  { value: 'cancelled', label: '已取消' },
];

type Sort = 'newest' | 'oldest' | 'findings';
const PAGE_SIZE = 10;

export function Missions() {
  const { user } = useAuth();
  const writable = canOperate(user);
  const admin = user?.role === 'admin';
  const toast = useToast();
  const missions = useAsync(() => api.listMissions(), []);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleteTargets, setDeleteTargets] = useState<Array<{ id: string; name: string }> | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [query, setQuery] = useState('');
  const [state, setState] = useState<'all' | MissionState>('all');
  const [sort, setSort] = useState<Sort>('newest');
  const [page, setPage] = useState(1);

  const rows = useMemo(() => {
    const list = (missions.data?.missions ?? []).filter(mission => {
      if (state !== 'all' && mission.state !== state) return false;
      if (!query.trim()) return true;
      const needle = query.trim().toLowerCase();
      return (
        mission.name.toLowerCase().includes(needle) ||
        (mission.target?.value ?? '').toLowerCase().includes(needle) ||
        (mission.objective ?? '').toLowerCase().includes(needle) ||
        mission.id.toLowerCase().includes(needle)
      );
    });
    return list.toSorted((left, right) => {
      if (sort === 'findings') return right.findingsCount - left.findingsCount;
      const delta = new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
      return sort === 'newest' ? -delta : delta;
    });
  }, [missions.data, query, state, sort]);

  useEffect(() => setPage(1), [query, state, sort]);

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pagedRows = rows.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const selectedMissions = rows.filter(mission => selected.has(mission.id)).map(mission => ({ id: mission.id, name: mission.name }));
  const allSelected = rows.length > 0 && rows.every(mission => selected.has(mission.id));

  function toggleSelected(id: string): void {
    setSelected(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll(): void {
    setSelected(current => {
      const next = new Set(current);
      if (rows.every(mission => next.has(mission.id))) rows.forEach(mission => next.delete(mission.id));
      else rows.forEach(mission => next.add(mission.id));
      return next;
    });
  }

  async function removeProjects(): Promise<void> {
    if (!deleteTargets) return;
    setDeleting(true);
    setDeleteError('');
    const failures: string[] = [];
    for (const target of deleteTargets) {
      try {
        await api.deleteMission(target.id, target.name);
      } catch (cause) {
        failures.push(`${target.name}: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
    setDeleting(false);
    missions.refresh();
    if (failures.length > 0) {
      setDeleteError(failures.slice(0, 5).join('\n'));
      toast('error', `${failures.length} 个项目删除失败，请查看弹窗详情。`);
      return;
    }
    toast('success', `已删除 ${deleteTargets.length} 个项目。`);
    setSelected(new Set());
    setDeleteTargets(null);
  }

  return (
    <div className="mx-auto w-full max-w-[1500px]">
      <PageHeader
        index="01 / 项目"
        title={<>项目列表</>}
        actions={writable ? (
          <Link to="/missions/new" className="btn btn-primary">
            <Plus className="size-3.5" aria-hidden="true" />
            新建项目
          </Link>
        ) : undefined}
        aside={
          <div className="text-right">
            <p className="display text-[clamp(2.6rem,5vw,4.6rem)] text-paper">{missions.data?.total ?? '—'}</p>
            <p className="micro mt-1">missions captured</p>
          </div>
        }
      />

      <div className="mb-5 flex flex-col gap-3 border-b border-line pb-5 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap items-center gap-1.5">
          {STATES.map(option => (
            <button
              key={option.value}
              type="button"
              className={cn('chip', state === option.value && 'chip-active')}
              aria-pressed={state === option.value}
              onClick={() => setState(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-faint" aria-hidden="true" />
            <Input
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder="搜索项目 / 目标"
              className="h-8 py-0 pl-9 text-[11px] leading-8 placeholder:text-[11px]"
              aria-label="搜索项目"
            />
          </label>
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.12em] text-muted">
            <span>排序</span>
            <SpringSelect<Sort>
              value={sort}
              onChange={setSort}
              ariaLabel="排序方式"
              options={[
                { value: 'newest', label: '最新优先' },
                { value: 'oldest', label: '最早优先' },
                { value: 'findings', label: '发现最多' },
              ]}
            />
          </div>
        </div>
      </div>

      {admin ? (
        <div className="mb-4 flex flex-wrap items-center gap-3 border border-line bg-panel px-3 py-2.5">
          <button type="button" className="inline-flex items-center gap-2 text-[11px] text-muted hover:text-paper" onClick={toggleAll} aria-pressed={allSelected}>
            <input type="checkbox" readOnly checked={allSelected} className="size-3.5 accent-lime" aria-hidden="true" />
            <CheckSquare className="size-3.5" aria-hidden="true" />
            全选当前筛选（{rows.length}）
          </button>
          <span className="mono text-[10px] text-faint">已选 {selectedMissions.length}</span>
          <Button
            variant="danger"
            className="ml-auto"
            icon={<Trash2 className="size-3.5" aria-hidden="true" />}
            disabled={selectedMissions.length === 0}
            onClick={() => { setDeleteError(''); setDeleteTargets(selectedMissions); }}
          >
            批量删除
          </Button>
        </div>
      ) : null}

      {missions.loading ? (
        <div className="space-y-2" aria-busy="true" aria-label="加载项目">
          {Array.from({ length: 6 }).map((_, index) => <Skeleton key={index} className="h-20 w-full" />)}
        </div>
      ) : missions.error ? (
        <ErrorState error={missions.error} retry={missions.refresh} />
      ) : rows.length === 0 ? (
        <div className="border border-dashed border-line px-6 py-16 text-center">
          <Target className="mx-auto size-7 text-faint" aria-hidden="true" />
          <p className="display mt-4 text-[12px] tracking-[0.16em] text-paper">没有匹配的项目</p>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted">
            调整筛选条件，或创建一个新的授权测试项目。项目目标写入 PostgreSQL 后由 Worker 自动领取。
          </p>
          {writable ? <Link to="/missions/new" className="btn btn-primary mt-5 inline-flex">新建项目</Link> : null}
        </div>
      ) : (
        <ul role="list" className="divide-y divide-line border-y border-line">
          {pagedRows.map((mission, index) => (
            <li key={mission.id} className="flex items-center gap-3">
              {admin ? (
                <input
                  type="checkbox"
                  checked={selected.has(mission.id)}
                  onChange={() => toggleSelected(mission.id)}
                  onClick={event => event.stopPropagation()}
                  aria-label={`选择项目 ${mission.name}`}
                  className="ml-2 size-4 shrink-0 accent-lime"
                />
              ) : null}
              <Link
                to={`/missions/${mission.id}`}
                className="group grid min-w-0 flex-1 grid-cols-[auto_1fr_auto] items-center gap-4 px-2 py-5 transition-colors hover:bg-paper/[0.02] sm:grid-cols-[48px_1fr_180px_120px_auto] sm:px-4"
              >
                <span className="mono text-[10px] text-faint">{String((currentPage - 1) * PAGE_SIZE + index + 1).padStart(2, '0')}</span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-[15px] font-medium text-paper transition-colors group-hover:text-lime">{mission.name}</span>
                    <MissionStatus state={mission.state} />
                  </div>
                  <p className="mono mt-1 truncate text-[11px] text-faint">
                    {mission.target ? (mission.target.type === 'file' ? missionTargetLabel(mission.target) : `${mission.target.type} · ${mission.target.value}`) : '— · 未设置目标'}
                  </p>
                  {mission.objective ? <p className="mt-1 line-clamp-1 max-w-3xl text-xs text-muted">{mission.objective}</p> : null}
                </div>
                <div className="hidden text-right sm:block">
                  <p className="mono text-xs text-paper">{mission.findingsCount}</p>
                  <p className="micro mt-1">findings</p>
                </div>
                <div className="hidden text-right sm:block">
                  <p className="mono text-[11px] text-muted">{formatShortDate(mission.createdAt)}</p>
                  <p className="micro mt-1">{missionLabel(mission.state)}</p>
                </div>
                <ArrowUpRight className="size-4 text-faint transition-colors group-hover:text-lime" aria-hidden="true" />
              </Link>
              {admin ? (
                <button
                  type="button"
                  className="mr-2 inline-flex size-8 shrink-0 items-center justify-center border border-line text-faint transition-colors hover:border-ember/40 hover:text-ember"
                  aria-label={`删除项目 ${mission.name}`}
                  onClick={() => { setDeleteError(''); setDeleteTargets([{ id: mission.id, name: mission.name }]); }}
                >
                  <Trash2 className="size-3.5" aria-hidden="true" />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {rows.length > 0 ? (
        <Pager
          page={currentPage}
          totalPages={totalPages}
          pageSize={PAGE_SIZE}
          totalItems={rows.length}
          onPageChange={setPage}
          note="接口最多返回 50 条"
          className="mt-5"
        />
      ) : null}

      <div className="mt-4 flex items-center justify-between text-[10px] uppercase tracking-[0.14em] text-faint">
        <span>{rows.length} / {missions.data?.total ?? 0} 条</span>
        <Link to="/findings" className="link-underline inline-flex items-center gap-1 hover:text-lime">
          全部发现 <ArrowRight className="size-3" aria-hidden="true" />
        </Link>
      </div>

      <Modal
        open={deleteTargets !== null}
        onOpenChange={next => { if (!next && !deleting) { setDeleteTargets(null); setDeleteError(''); } }}
        title={deleteTargets && deleteTargets.length === 1 ? `确认删除项目「${deleteTargets[0]?.name}」？` : `确认删除 ${deleteTargets?.length ?? 0} 个项目？`}
        description="此操作不可撤销，会永久删除项目关联的任务、证据、发现、轨迹、审批与授权数据。删除会逐个调用项目删除接口。"
        footer={
          <>
            <Button variant="ghost" disabled={deleting} onClick={() => setDeleteTargets(null)}>取消</Button>
            <Button variant="danger" disabled={deleting} onClick={() => void removeProjects()}>{deleting ? '删除中…' : '确认删除'}</Button>
          </>
        }
      >
        <div className="space-y-2">
          {deleteTargets?.slice(0, 8).map(target => <p key={target.id} className="mono truncate text-xs text-paper">{target.name}</p>)}
          {deleteTargets && deleteTargets.length > 8 ? <p className="text-xs text-muted">…以及其他 {deleteTargets.length - 8} 个项目</p> : null}
          {deleteError ? <pre className="mt-3 max-h-32 overflow-auto whitespace-pre-wrap border border-ember/30 bg-ember/5 px-3 py-2 text-[10px] text-ember">{deleteError}</pre> : null}
        </div>
      </Modal>
    </div>
  );
}
