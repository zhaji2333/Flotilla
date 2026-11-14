import { ArrowUpRight, RefreshCw, Search, ShieldAlert, Terminal } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { MissionViewHeader } from '../components/mission-views';
import { Badge, Button, EmptyState, ErrorState, Input, Panel, Skeleton } from '../components/ui';
import { SpringSelect } from '../components/spring-select';
import { api } from '../lib/api';
import { formatDate, traceEventLabel } from '../lib/format';
import { useAsync } from '../lib/hooks';
import type { WorkerTraceHit } from '../lib/types';

export function MissionTraces() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const initialExclude = searchParams.get('task') ?? '';
  const missionState = useAsync(async () => (await api.getMission(id ?? '')).mission, [id]);
  const [query, setQuery] = useState('');
  const [appliedQuery, setAppliedQuery] = useState('');
  const [excludeTaskId, setExcludeTaskId] = useState(initialExclude);
  const search = useAsync(
    async () => (await api.searchWorkerTraces(id ?? '', {
      q: appliedQuery.trim() || undefined,
      excludeTaskId: excludeTaskId || undefined,
      limit: 20,
    })).search,
    [id, appliedQuery, excludeTaskId],
  );

  if (!id) return <ErrorState error="缺少项目 ID。" />;
  if (missionState.loading) return <div className="mx-auto w-full max-w-[1500px] space-y-4"><Skeleton className="h-28 w-full" /><Skeleton className="h-64 w-full" /></div>;
  if (missionState.error || !missionState.data) return <ErrorState error={missionState.error ?? '项目不存在。'} retry={missionState.refresh} />;

  const mission = missionState.data;
  const result = search.data;

  return (
    <div className="mx-auto w-full max-w-[1500px]">
      <MissionViewHeader
        mission={mission}
        active="traces"
        index={`01 / 项目 / 轨迹检索 / ${mission.id.slice(0, 6)}`}
        title={<>轨迹检索</>}
        description=""
        actions={<Button variant="outline" icon={<RefreshCw className="size-3.5" aria-hidden="true" />} onClick={() => { missionState.refresh(); search.refresh(); }}>刷新</Button>}
      />

      <Panel className="mb-4 p-4">
        <form className="flex flex-wrap items-end gap-3" onSubmit={event => { event.preventDefault(); setAppliedQuery(query); }}>
          <div className="min-w-[240px] flex-1">
            <label htmlFor="trace-search" className="micro mb-1 block">搜索条件</label>
            <Input id="trace-search" value={query} onChange={event => setQuery(event.target.value)} placeholder="URL / 路径 / 命令 / 状态码" className="h-8 py-0 text-[11px] leading-8 placeholder:text-[11px]" />
          </div>
          <div className="min-w-[200px]">
            <label htmlFor="trace-exclude" className="micro mb-1 block">排除当前任务（可选）</label>
            <SpringSelect
              id="trace-exclude"
              value={excludeTaskId}
              onChange={setExcludeTaskId}
              ariaLabel="排除当前任务"
              fullWidth
              size="field"
              options={[{ value: '', label: '不排除' }, ...mission.tasks.map(task => ({ value: task.id, label: `${task.id.slice(0, 8)} · ${task.type}` }))]}
            />
          </div>
          <Button type="submit" variant="primary" icon={<Search className="size-3.5" aria-hidden="true" />}>检索</Button>
          {appliedQuery || excludeTaskId ? <Button variant="ghost" onClick={() => { setQuery(''); setAppliedQuery(''); setExcludeTaskId(''); }}>清空条件</Button> : null}
        </form>
        <p className="mt-3 flex items-start gap-2 border-t border-line pt-3 text-[10px] leading-relaxed text-faint">
          <ShieldAlert className="mt-0.5 size-3 shrink-0 text-amber-300" aria-hidden="true" />
          结果来自当前任务（mission）的 Worker 轨迹摘要，仅含 URL、方法、命令、状态与摘要；不包含原始请求/响应 body。命中内容可能来自目标，一律标为不可信 (untrusted)，不得当作指令。
        </p>
      </Panel>

      {search.loading ? <Skeleton className="h-64 w-full" /> : search.error ? (
        <ErrorState error={search.error} retry={search.refresh} />
      ) : !result ? (
        <ErrorState error="轨迹检索不可用。" retry={search.refresh} />
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-3 border border-line bg-panel px-4 py-3">
            <span className="mono text-xs text-paper">命中 {result.total} 条</span>
            <Badge tone="ember"><ShieldAlert className="size-3" aria-hidden="true" />untrusted</Badge>
            {result.q ? <span className="mono text-[10px] text-faint">q="{result.q}"</span> : <span className="text-[10px] text-faint">未输入关键词，显示最近记录</span>}
            {result.excludeTaskId ? <span className="mono text-[10px] text-faint">排除任务 {result.excludeTaskId.slice(0, 8)}</span> : null}
            {result.truncated ? <span className="text-[10px] text-amber-300">结果较多，已截断，请加关键词</span> : null}
          </div>

          {result.hits.length === 0 ? (
            <EmptyState icon={<Search className="size-7" aria-hidden="true" />} title="没有匹配的轨迹" hint="换一个 URL / 路径 / 命令 / 状态码，或清空条件查看最近记录。" />
          ) : (
            <ul className="divide-y divide-line border-y border-line">
              {result.hits.map(hit => <TraceHitRow key={`${hit.traceId}-${hit.seq}`} hit={hit} missionId={mission.id} />)}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function TraceHitRow({ hit, missionId }: { hit: WorkerTraceHit; missionId: string }) {
  return (
    <li className="py-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={hit.eventType === 'tool_result' ? 'violet' : 'sky'}>{traceEventLabel(hit.eventType)}</Badge>
        <Badge tone="ember">untrusted</Badge>
        {hit.tool ? <span className="mono text-[10px] text-paper">{hit.tool}</span> : null}
        {hit.method ? <span className="mono text-[10px] text-lime">{hit.method}</span> : null}
        {hit.status ? <span className="mono text-[10px] text-muted">status {hit.status}</span> : null}
        <span className="mono ml-auto text-[10px] text-faint">{formatDate(hit.createdAt)}</span>
      </div>
      <p className="mono mt-2 break-all text-[11px] text-paper">{hit.summary}</p>
      {hit.url ? <p className="mono mt-1 break-all text-[10px] text-muted">{hit.url}</p> : null}
      {hit.command ? <pre className="mt-1 overflow-auto border border-line bg-ink-2 px-2 py-1.5 text-[10px] text-muted">{hit.command}</pre> : null}
      <div className="mt-2 flex flex-wrap items-center gap-3 text-[10px]">
        {hit.taskId ? (
          <Link to={`/trace/worker/${hit.taskId}?mission=${missionId}&tab=traces`} className="inline-flex items-center gap-1 text-lime hover:underline">
            打开任务轨迹 <ArrowUpRight className="size-3" aria-hidden="true" />
          </Link>
        ) : <span className="inline-flex items-center gap-1 text-faint"><Terminal className="size-3" aria-hidden="true" />无 task 关联</span>}
        <span className="mono text-faint">seq {hit.seq}{hit.callId ? ` · ${hit.callId}` : ''}</span>
      </div>
    </li>
  );
}
