import { ArrowLeft, ChevronDown, ChevronRight, Code2, Filter, History, ShieldAlert, Terminal } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { PageHeader } from '../components/shell';
import { Pager } from '../components/pager';
import { Badge, EmptyState, ErrorState, Skeleton } from '../components/ui';
import { api } from '../lib/api';
import { formatDate, traceEventLabel } from '../lib/format';
import { useAsync } from '../lib/hooks';
import type { SubjectType, TraceRow } from '../lib/types';
import { cn, textOf } from '../lib/utils';

const FILTERS = [
  { value: 'all', label: '全部' },
  { value: 'thinking', label: '思考' },
  { value: 'tool_call', label: '工具调用' },
  { value: 'tool_result', label: '工具结果' },
  { value: 'context', label: '上下文' },
  { value: 'status', label: '状态' },
  { value: 'final', label: '最终回复' },
];

const PAGE_SIZE = 100;

export function Trace() {
  const { subjectType, subjectId } = useParams<{ subjectType: string; subjectId: string }>();
  const type: SubjectType = subjectType === 'planner' ? 'planner' : 'worker';
  const trace = useAsync(() => api.listTrace(type, subjectId ?? ''), [type, subjectId]);
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const missionId = searchParams.get('mission');
  const backTab = searchParams.get('tab');
  const backTask = searchParams.get('task');

  // Trace links carry the mission id. Prefer that deterministic target; if the
  // URL was opened directly without context, fall back to history and finally
  // to the mission list, so the back control never dead-ends.
  function goBack(): void {
    if (missionId) {
      // Dedicated mission views: return to the page that owns the trace link.
      const view = backTab === 'tasks' ? 'dag' : backTab && ['dag', 'board', 'blackboard', 'explore', 'assets', 'traces', 'overview'].includes(backTab) ? backTab : null;
      if (view) {
        const query = view === 'dag' && backTask ? `?task=${encodeURIComponent(backTask)}` : '';
        navigate(`/missions/${missionId}/${view}${query}`);
        return;
      }
      const next = new URLSearchParams();
      if (backTab) next.set('tab', backTab);
      if (backTask) next.set('task', backTask);
      const query = next.toString();
      navigate(`/missions/${missionId}${query ? `?${query}` : ''}`);
      return;
    }
    if (location.key !== 'default') {
      navigate(-1);
      return;
    }
    navigate('/missions');
  }
  const [filter, setFilter] = useState('all');
  const [page, setPage] = useState(1);
  // Rows default to expanded: track collapsed ids instead of expanded ids so
  // every event (including rows loaded by paging/filtering) starts open.
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const listRef = useRef<HTMLOListElement | null>(null);

  const rows = useMemo(() => {
    const list = trace.data?.trace ?? [];
    return filter === 'all' ? list : list.filter(row => row.eventType === filter);
  }, [trace.data, filter]);

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const shown = rows.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  function goToPage(next: number): void {
    const target = Math.min(Math.max(1, next), totalPages);
    setPage(target);
    listRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function toggle(id: number): void {
    setCollapsed(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="mx-auto w-full max-w-[1500px]">
      <div className="mb-4 flex items-center gap-3 text-[10px] uppercase tracking-[0.16em] text-faint">
        <button type="button" className="inline-flex items-center gap-1 hover:text-lime" onClick={goBack}>
          <ArrowLeft className="size-3" aria-hidden="true" />{missionId ? '返回项目' : '返回'}
        </button>
        <span className="h-px w-6 bg-line" aria-hidden="true" />
        <span>{type === 'planner' ? 'Planner 运行' : 'Worker 任务'}</span>
      </div>

      <PageHeader
        index={`06 / TRACE / ${type.toUpperCase()}`}
        title={<>执行轨迹</>}
        description="思考、工具调用、SKILL 加载、上下文注入与最终回复的完整时间线。技术正文保持原文，不做翻译。"
        aside={
          <div className="text-right">
            <p className="display text-[clamp(2.2rem,4vw,3.6rem)] text-paper">{trace.data?.total ?? '—'}</p>
            <p className="micro mt-1">events captured</p>
          </div>
        }
      />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border border-line bg-panel px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Terminal className="size-4 shrink-0 text-lime" aria-hidden="true" />
          <span className="mono truncate text-xs text-paper">{subjectId}</span>
          <Badge tone={type === 'planner' ? 'violet' : 'sky'}>{type}</Badge>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Filter className="size-3.5 text-faint" aria-hidden="true" />
          {FILTERS.map(option => (
            <button
              key={option.value}
              type="button"
              className={cn('chip', filter === option.value && 'chip-active')}
              aria-pressed={filter === option.value}
              onClick={() => {
                setFilter(option.value);
                setPage(1);
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {trace.loading ? (
        <div className="space-y-2" aria-busy="true">
          {Array.from({ length: 8 }).map((_, index) => <Skeleton key={index} className="h-14 w-full" />)}
        </div>
      ) : trace.error ? (
        <ErrorState error={trace.error} retry={trace.refresh} />
      ) : rows.length === 0 ? (
        <EmptyState icon={<Code2 className="size-6" aria-hidden="true" />} title="暂无轨迹" hint="运行尚未产生事件，或该 subject 没有落库轨迹。" />
      ) : (
        <>
          <Pager page={currentPage} totalPages={totalPages} pageSize={PAGE_SIZE} totalItems={rows.length} onPageChange={goToPage} note="上限 3000" className="mb-3" />
          <ol ref={listRef} className="scroll-mt-24 space-y-0 border-y border-line">
            {shown.map(row => (
              <TraceItem
                key={row.id}
                row={row}
                expanded={!collapsed.has(row.id)}
                onToggle={() => toggle(row.id)}
              />
            ))}
          </ol>
          <Pager page={currentPage} totalPages={totalPages} pageSize={PAGE_SIZE} totalItems={rows.length} onPageChange={goToPage} note="上限 3000" className="mt-5" />
        </>
      )}
    </div>
  );
}

function TraceItem({ row, expanded, onToggle }: { row: TraceRow; expanded: boolean; onToggle: () => void }) {
  const summary = summarize(row);
  const isPriorWork = row.eventType === 'context' && textOf(row.payload.source) === 'prior_work';
  const deletable = summary.detail.length > 220 || (row.eventType !== 'thinking' && row.eventType !== 'text' && row.eventType !== 'status');
  const Icon = isPriorWork ? History : row.eventType === 'tool_call' || row.eventType === 'tool_result' ? Terminal : Code2;

  return (
    <li className={cn('relative border-b border-line', isPriorWork && 'border-l-2 border-l-lime/40 bg-lime/[0.025]')}>
      <div className="trace-line relative pl-8">
        <span className="absolute left-[7px] top-6 size-2 rounded-full border border-line bg-ink" aria-hidden="true" />
        <button
          type="button"
          className="flex w-full items-start gap-3 py-4 pr-3 text-left transition-colors hover:bg-paper/[0.02]"
          onClick={onToggle}
          aria-expanded={expanded}
        >
          <span className="mono mt-0.5 w-10 shrink-0 text-[10px] text-faint">{String(row.seq).padStart(4, '0')}</span>
          <Icon className="mt-0.5 size-3.5 shrink-0 text-faint" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-2">
              <span className={cn('text-[11px] uppercase tracking-[0.12em]', isPriorWork ? 'text-lime' : 'text-paper')}>
                {isPriorWork ? '先验工作注入' : traceEventLabel(row.eventType)}
              </span>
              <span className="mono text-[10px] text-faint">{formatDate(row.createdAt)}</span>
              <span className="chip cursor-default">{isPriorWork ? 'prior_work' : row.eventType}</span>
              {isPriorWork ? (
                <span className="inline-flex items-center gap-1 text-[9px] uppercase tracking-[0.1em] text-amber-300">
                  <ShieldAlert className="size-3" aria-hidden="true" />不可信数据
                </span>
              ) : null}
            </span>
            {summary.title ? <span className="mt-1 block truncate text-xs text-muted">{summary.title}</span> : null}
            {!expanded ? (
              <span className="mt-1 line-clamp-2 block whitespace-pre-wrap break-words text-xs leading-relaxed text-muted">{summary.detail || '（无正文）'}</span>
            ) : null}
          </span>
          {deletable ? (
            <span className="mt-0.5 text-faint" aria-hidden="true">
              {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
            </span>
          ) : null}
        </button>
        {expanded ? (
          <div className="pb-5 pr-3">
            {isPriorWork ? (
              <p className="mb-2 text-[10px] uppercase tracking-[0.1em] text-amber-300/80">Worker 在 claim 边界注入的剩余 mission 摘要 · 仅作为不可信数据分析</p>
            ) : null}
            <pre className="code-block max-h-[560px]">{summary.detail || JSON.stringify(row.payload, null, 2)}</pre>
            <details className="mt-2">
              <summary className="cursor-pointer text-[10px] uppercase tracking-[0.12em] text-faint hover:text-muted">原始 payload</summary>
              <pre className="code-block mt-2 max-h-80">{JSON.stringify(row.payload, null, 2)}</pre>
            </details>
          </div>
        ) : null}
      </div>
    </li>
  );
}

function summarize(row: TraceRow): { title: string; detail: string } {
  const payload = row.payload;
  const candidate = [
    payload.reasoning,
    payload.thinking,
    payload.text,
    payload.content,
    payload.message,
    payload.note,
    payload.output,
    payload.result,
    payload.args,
    payload.arguments,
  ]
    .map(textOf)
    .find(value => value.length > 0);
  const tool = [payload.tool, payload.name, payload.skill].map(textOf).find(value => value.length > 0) ?? '';
  const title =
    row.eventType === 'tool_call' || row.eventType === 'tool_result'
      ? `${tool || 'tool'}${payload.status ? ` · ${textOf(payload.status)}` : ''}`
      : row.eventType === 'context'
        ? textOf(payload.source) || 'context injection'
        : row.eventType === 'status'
          ? textOf(payload.state) || textOf(payload.status) || 'status'
          : tool;
  const detail = candidate ?? JSON.stringify(payload, null, 2);
  return { title, detail };
}
