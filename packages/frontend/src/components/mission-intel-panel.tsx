import { ArrowUpRight, Eye, EyeOff, ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { confidenceLabel, intelTypeLabel } from '../lib/format';
import { useAsync } from '../lib/hooks';
import type { IntelType, MissionIntelItem } from '../lib/types';
import { cn } from '../lib/utils';
import { maskSensitiveValue } from '../lib/blackboard';
import { Badge, CopyButton, EmptyState, ErrorState, Panel, SectionLabel, Skeleton } from './ui';

const TYPE_ORDER: IntelType[] = ['technique', 'artifact', 'credential'];

// P3-B3 same-mission intel: accepted technique/artifact + credential facts.
// Read-only; credential details stay masked until explicitly revealed in-page.
export function MissionIntelPanel({ missionId }: { missionId: string }) {
  const state = useAsync(async () => (await api.getMissionIntel(missionId, { limit: 200 })).intel, [missionId]);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());

  if (state.loading) return <Panel className="p-5"><Skeleton className="h-56 w-full" /></Panel>;
  if (state.error || !state.data) return <Panel className="p-5"><ErrorState error={state.error ?? '情报投影不可用。'} retry={state.refresh} /></Panel>;
  const intel = state.data;
  const groups = TYPE_ORDER.map(type => ({ type, items: intel.items.filter(item => item.type === type) })).filter(group => group.items.length > 0);

  function toggle(id: string): void {
    setRevealed(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <Panel className="p-4">
      <SectionLabel index="情报" right={<span className="mono text-[10px] text-faint">{intel.total} / 200 · 同任务</span>}>任务情报</SectionLabel>
      <p className="mb-4 max-w-3xl text-[11px] leading-relaxed text-muted">
        已接受发现 (accepted finding) 的技术/目标产物，以及黑板凭据；仅当前任务 (mission) 可见，没有跨任务自动传递。凭据明文由 API 返回，本页默认遮罩。
      </p>
      {groups.length === 0 ? (
        <EmptyState icon={<ShieldAlert className="size-7" aria-hidden="true" />} title="暂无情报" hint="已接受发现或凭据事实产生后会出现在这里。" />
      ) : (
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {groups.map(group => (
            <section key={group.type} aria-label={intelTypeLabel(group.type)} className="min-w-0 border border-line bg-ink-2/30 p-3">
              <div className="mb-2 flex items-center gap-2 border-b border-line pb-1.5">
                <span className="text-[11px] uppercase tracking-[0.14em] text-paper">{intelTypeLabel(group.type)}</span>
                <span className="mono text-[10px] text-faint">{group.items.length}</span>
              </div>
              <ul className="max-h-[320px] divide-y divide-line overflow-y-auto pr-1">
                {group.items.map(item => <IntelRow key={item.id} item={item} missionId={missionId} revealed={revealed.has(item.id)} onToggle={() => toggle(item.id)} />)}
              </ul>
            </section>
          ))}
        </div>
      )}
    </Panel>
  );
}

function IntelRow({ item, missionId, revealed, onToggle }: { item: MissionIntelItem; missionId: string; revealed: boolean; onToggle: () => void }) {
  const visible = !item.sensitive || revealed;
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={item.type === 'credential' ? 'ember' : item.type === 'artifact' ? 'violet' : 'sky'}>{intelTypeLabel(item.type)}</Badge>
        <span className="text-[9px] uppercase tracking-[0.1em] text-faint">{confidenceLabel(item.trust)}</span>
        {item.sensitive ? <ShieldAlert className="size-3 text-ember" aria-hidden="true" /> : null}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {item.sourceTaskId ? (
            <Link to={`/trace/worker/${item.sourceTaskId}?mission=${missionId}&tab=blackboard`} className="text-[10px] text-lime hover:underline">轨迹</Link>
          ) : null}
          {item.sourceFindingId ? (
            <Link to={`/findings/${item.sourceFindingId}`} className="inline-flex items-center gap-1 text-[10px] text-lime hover:underline">来源发现 <ArrowUpRight className="size-3" aria-hidden="true" /></Link>
          ) : null}
          {item.sensitive ? (
            <button type="button" onClick={onToggle} className="inline-flex items-center gap-1 border border-line px-2 py-1 text-[9px] uppercase tracking-[0.1em] text-muted hover:border-amber-300/50 hover:text-amber-200">
              {revealed ? <EyeOff className="size-3" aria-hidden="true" /> : <Eye className="size-3" aria-hidden="true" />}
              {revealed ? '隐藏' : '查看明文'}
            </button>
          ) : null}
          {visible ? <CopyButton value={item.detail} label="复制" /> : null}
        </div>
      </div>
      <p className="mt-2 text-xs text-paper">{item.title}</p>
      <p className={cn('mono mt-1 break-all text-xs', item.sensitive ? 'text-amber-200/90' : 'text-paper')}>{visible ? item.detail : maskSensitiveValue(item.detail)}</p>
      {item.tags.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {item.tags.map(tag => <span key={tag} className="border border-line px-1.5 py-0.5 text-[9px] uppercase tracking-[0.1em] text-faint">{tag}</span>)}
        </div>
      ) : null}
    </li>
  );
}
