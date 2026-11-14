import {
  ArrowUpRight,
  BrainCircuit,
  Eye,
  EyeOff,
  Network,
  RefreshCw,
  Search,
  ShieldAlert,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { factDisplayValue, factKindLabel, factProvenanceLabel, factSourceLabel, factTrustLabel, groupFactsByKind, maskSensitiveValue } from '../lib/blackboard';
import { formatDate, formatShortDate, taskLabel } from '../lib/format';
import { useAsync } from '../lib/hooks';
import type { FactsResponse, MissionFact } from '../lib/types';
import { cn } from '../lib/utils';
import { Badge, Button, CopyButton, EmptyState, ErrorState, Input, Panel, SectionLabel, Skeleton } from './ui';

// P3 M2 typed blackboard: read-only facts/frontier/recall for one mission.
// Credential values stay masked by default and are never persisted in URL or
// browser storage; revealing is local React state only.
export function BlackboardPanel({ missionId }: { missionId: string }) {
  const frontier = useAsync(async () => (await api.getMissionFrontier(missionId)).frontier, [missionId]);
  const facts = useAsync(() => api.listMissionFacts(missionId, { limit: 200 }), [missionId]);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [recall, setRecall] = useState<FactsResponse | null>(null);
  const [recallError, setRecallError] = useState<string | null>(null);
  const [recalling, setRecalling] = useState(false);

  useEffect(() => {
    setRevealed(new Set());
    setRecall(null);
    setQuery('');
    setRecallError(null);
  }, [missionId]);

  function toggleReveal(id: string): void {
    setRevealed(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function runRecall(): Promise<void> {
    const q = query.trim();
    if (q.length === 0) return;
    if (q.length > 200) {
      setRecallError('检索词不能超过 200 字符。');
      return;
    }
    setRecalling(true);
    setRecallError(null);
    try {
      setRecall(await api.recallMissionFacts(missionId, { q }));
    } catch (cause) {
      setRecallError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRecalling(false);
    }
  }

  if (frontier.loading || facts.loading) {
    return <div className="grid gap-3 md:grid-cols-2">{Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} className="h-44 w-full" />)}</div>;
  }
  if (frontier.error || facts.error || !frontier.data || !facts.data) {
    return <ErrorState error={frontier.error ?? facts.error ?? '黑板数据不可用。'} retry={() => { frontier.refresh(); facts.refresh(); }} />;
  }

  const data = frontier.data;
  const allFacts = facts.data.facts;
  const groups = groupFactsByKind(allFacts);

  return (
    <div className="space-y-4">
      <Panel className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="micro flex items-center gap-2"><BrainCircuit className="size-3.5 text-lime" aria-hidden="true" />类型化黑板 (blackboard)</p>
          </div>
          <div className="flex items-center gap-3">
            <span className="mono text-[10px] text-faint">事件版本 {data.version}</span>
            <Button variant="ghost" icon={<RefreshCw className="size-3.5" aria-hidden="true" />} onClick={() => { frontier.refresh(); facts.refresh(); }}>刷新</Button>
          </div>
        </div>
        <div className="mt-5 grid grid-cols-2 gap-px border border-line bg-line sm:grid-cols-4">
          <Stat label="事实" value={data.counts.facts} />
          <Stat label="意图" value={data.counts.intents} />
          <Stat label="敏感事实" value={data.counts.sensitiveFacts} tone={data.counts.sensitiveFacts > 0 ? 'ember' : 'default'} />
          <Stat label="生成时间" value={formatShortDate(data.generatedAt)} small />
        </div>
        {Object.keys(data.counts.byKind).length > 0 ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {Object.entries(data.counts.byKind).map(([kind, count]) => (
              <Badge key={kind} tone="muted">{factKindLabel(kind)} ×{count}</Badge>
            ))}
            <span className="text-[10px] text-faint">明文凭据仅在本组件内展开，不写 URL/存储。</span>
          </div>
        ) : null}
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
      <Panel className="p-4">
        <SectionLabel index="可打点前沿" right={<span className="mono text-[10px] text-faint">{data.intents.length} 个意图</span>}>
          下一步可打点
        </SectionLabel>
        {data.intents.length === 0 ? (
          <p className="border border-dashed border-line px-3 py-6 text-sm text-muted">没有未完成的意图；Planner / 可打点前沿当前为空。</p>
        ) : (
          <div className="grid gap-2 md:grid-cols-2">
            {data.intents.map(intent => (
              <Link
                key={intent.id}
                to={`/missions/${missionId}/dag?task=${intent.id}`}
                className="group border border-line bg-ink-2 px-3 py-3 transition-colors hover:border-lime/35 hover:bg-surface-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={intent.state === 'running' || intent.state === 'leased' ? 'lime' : 'muted'}>{taskLabel(intent.state)}</Badge>
                    <span className="mono text-[10px] text-faint">{intent.type === 'intent' ? '意图' : intent.type} · 第 {intent.attempt + 1} 次尝试</span>
                  </div>
                  <ArrowUpRight className="size-3.5 text-faint group-hover:text-lime" aria-hidden="true" />
                </div>
                <p className="mt-2 line-clamp-3 text-xs leading-relaxed text-paper">{intent.objective}</p>
                <p className="mono mt-2 text-[10px] text-faint">优先级 {intent.priority} · 依赖 {intent.dependsOn.length} 个任务</p>
              </Link>
            ))}
          </div>
        )}
      </Panel>

      <Panel className="p-4">
        <SectionLabel index="检索" right={<Network className="size-3.5 text-faint" aria-hidden="true" />}>黑板检索</SectionLabel>
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={event => { event.preventDefault(); void runRecall(); }}
        >
          <div className="min-w-[220px] flex-1">
            <Input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索 key / value / summary" className="h-8 py-0 text-[11px] leading-8 placeholder:text-[11px]" aria-label="黑板检索" />
          </div>
          <Button type="submit" variant="outline" icon={<Search className="size-3.5" aria-hidden="true" />} disabled={recalling || query.trim().length === 0}>
            {recalling ? '检索中…' : '检索'}
          </Button>
          {recall ? <Button variant="ghost" onClick={() => { setRecall(null); setQuery(''); }}>清空</Button> : null}
        </form>
        {recallError ? <p className="mt-3 border border-ember/25 bg-ember/5 px-3 py-2 text-xs text-ember">{recallError}</p> : null}
        {recall ? (
          <div className="mt-3">
            <p className="micro mb-2">命中 {recall.total} 条 · q="{query.trim()}"</p>
            {recall.facts.length === 0 ? <p className="text-sm text-muted">没有匹配的事实。</p> : (
              <ul className="divide-y divide-line border-y border-line">
                {recall.facts.map(fact => <FactRow key={`recall-${fact.id}`} fact={fact} missionId={missionId} revealed={revealed.has(fact.id)} onToggle={() => toggleReveal(fact.id)} />)}
              </ul>
            )}
          </div>
        ) : null}
      </Panel>
      </div>

      <Panel className="p-4">
        <SectionLabel index="事实" right={<span className="mono text-[10px] text-faint">{allFacts.length} / 200</span>}>黑板事实</SectionLabel>
        {groups.length === 0 ? (
          <EmptyState icon={<BrainCircuit className="size-7" aria-hidden="true" />} title="尚无黑板事实" hint="Worker 后续提交 asset/finding/证据后，事实会出现在这里。" />
        ) : (
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5">
            {groups.map(group => (
              <section key={group.kind} aria-label={`${group.label} 事实`} className="min-w-0 border border-line bg-ink-2/30 p-3">
                <div className="mb-2 flex items-center gap-2 border-b border-line pb-1.5">
                  <span className="text-[11px] uppercase tracking-[0.14em] text-paper">{group.label}</span>
                  <span className="mono text-[10px] text-faint">{group.items.length}</span>
                </div>
                <ul className="max-h-[190px] divide-y divide-line overflow-y-auto pr-1">
                  {group.items.map(fact => (
                    <FactRow key={fact.id} fact={fact} missionId={missionId} revealed={revealed.has(fact.id)} onToggle={() => toggleReveal(fact.id)} />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}

function FactRow({ fact, missionId, revealed, onToggle }: { fact: MissionFact; missionId: string; revealed: boolean; onToggle: () => void }) {
  const visible = !fact.sensitive || revealed;
  const keyDisplay = fact.sensitive && !revealed ? maskSensitiveValue(fact.key) : fact.key;
  return (
    <li className="py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={fact.kind === 'credential' ? 'ember' : fact.kind === 'vuln' ? 'violet' : 'muted'}>{factKindLabel(fact.kind)}</Badge>
        <span className="text-[9px] uppercase tracking-[0.1em] text-faint">{factTrustLabel(fact.trust)}</span>
        <span className="text-[9px] uppercase tracking-[0.1em] text-faint">{factSourceLabel(fact.source)}</span>
        {fact.sensitive ? <ShieldAlert className="size-3 text-ember" aria-hidden="true" /> : null}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {fact.taskId ? (
            <Link to={`/trace/worker/${fact.taskId}?mission=${missionId}&tab=blackboard`} className="text-[10px] text-lime hover:underline">轨迹</Link>
          ) : null}
          {fact.source === 'finding' || fact.source === 'finding_artifact' ? (
            <Link to={`/findings/${fact.sourceId}`} className="text-[10px] text-lime hover:underline">来源发现</Link>
          ) : null}
          {fact.sensitive ? (
            <button type="button" onClick={onToggle} className="inline-flex items-center gap-1 border border-line px-2 py-1 text-[9px] uppercase tracking-[0.1em] text-muted hover:border-amber-300/50 hover:text-amber-200">
              {revealed ? <EyeOff className="size-3" aria-hidden="true" /> : <Eye className="size-3" aria-hidden="true" />}
              {revealed ? '隐藏' : '显示'}
            </button>
          ) : null}
          {visible ? <CopyButton value={fact.value} label="复制" /> : null}
        </div>
      </div>
      <p className="mono mt-2 break-all text-[11px] text-faint">{keyDisplay}</p>
      <p className={cn('mono mt-1 break-all text-xs', fact.sensitive ? 'text-amber-200/90' : 'text-paper')}>
        {factDisplayValue(fact, revealed)}
      </p>
      {fact.summary && fact.summary !== fact.value && visible ? <p className="mt-1 text-[11px] text-muted">{fact.summary}</p> : null}
      <p className="mono mt-1 text-[9px] text-faint">来源链：{factProvenanceLabel(fact.provenance)} · {formatDate(fact.createdAt)}</p>
    </li>
  );
}

function Stat({ label, value, tone = 'default', small = false }: { label: string; value: ReactNode; tone?: 'default' | 'ember'; small?: boolean }) {
  return (
    <div className="bg-ink-2 px-3 py-3">
      <p className="text-[9px] uppercase tracking-[0.12em] text-faint">{label}</p>
      <p className={cn('mono mt-1', small ? 'text-[11px]' : 'text-lg', tone === 'ember' ? 'text-ember' : 'text-paper')}>{value}</p>
    </div>
  );
}
