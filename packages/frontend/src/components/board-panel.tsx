import { AlertTriangle, ArrowUpRight, Boxes, Database, FileSearch, GitBranch, Layers, ListChecks, ShieldCheck } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { confidenceLabel, findingStatusLabel, formatDate, triggerKindLabel, triggerRouteLabel } from '../lib/format';
import { useAsync } from '../lib/hooks';
import type { MissionBoard } from '../lib/types';
import { api } from '../lib/api';
import { asRecord, textOf } from '../lib/utils';
import { SeverityBadge } from './status-badge';
import { Badge, ErrorState, Panel, SectionLabel, Skeleton } from './ui';

// P2 线索板：八节投影来自权威事件/表，只读；UI 不修改线索板。
export function BoardPanel({ missionId }: { missionId: string }) {
  const state = useAsync(() => apiBoard(missionId), [missionId]);

  if (state.loading) {
    return <div className="grid gap-3 md:grid-cols-2">{Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} className="h-44 w-full" />)}</div>;
  }
  if (state.error || !state.data) return <ErrorState error={state.error ?? '线索板不可用。'} retry={state.refresh} />;
  const board = state.data;
  const sections = board.sections;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 border border-line bg-panel px-4 py-3">
        <div className="flex flex-wrap items-center gap-3">
          <Badge tone="lime">事件版本 {board.version}</Badge>
          <span className="mono text-[10px] text-faint">基准版本 {board.baseVersion}</span>
          <span className="mono text-[10px] text-faint">生成时间 {formatDate(board.generatedAt)}</span>
          {board.conflicts.length > 0 ? <Badge tone="ember">{board.conflicts.length} 个冲突</Badge> : <Badge tone="muted">无冲突</Badge>}
        </div>
        <p className="text-[10px] uppercase tracking-[0.12em] text-faint">版本 = mission 事件序号，冲突由投影对比产生</p>
      </div>

      {board.conflicts.length > 0 ? (
        <ul className="space-y-2 border border-ember/30 bg-ember/5 p-4">
          {board.conflicts.map((conflict, index) => (
            <li key={`${conflict.section}-${index}`} className="flex items-start gap-2 text-xs text-ember">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              <span className="mono">{conflict.section}</span>
              <span className="text-ember/80">{conflict.reason}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
        <BoardCard title="授权范围" icon={<Layers className="size-3.5" aria-hidden="true" />} count={Object.keys(asRecord(sections.scope)).length}>
          <KeyValues value={asRecord(sections.scope)} />
        </BoardCard>

        <BoardCard title="资产" icon={<Boxes className="size-3.5" aria-hidden="true" />} count={sections.assets.length}>
          {sections.assets.length === 0 ? <Empty>暂未从证据中提取资产。</Empty> : (
            <ul className="flex flex-wrap gap-2">
              {sections.assets.map((asset, index) => (
                <li key={`${textOf(asset.host)}-${index}`} className="border border-line bg-ink-2 px-2.5 py-1.5 text-[11px] text-paper">
                  <span className="mono">{textOf(asset.host) || '—'}</span>
                  <span className="ml-2 text-[9px] uppercase tracking-[0.1em] text-faint">{textOf(asset.source) === 'evidence' ? '代理证据' : textOf(asset.source)}</span>
                </li>
              ))}
            </ul>
          )}
        </BoardCard>

        <BoardCard title="发现事实（摘要）" icon={<ShieldCheck className="size-3.5" aria-hidden="true" />} count={sections.facts.length}>
          {sections.facts.length === 0 ? <Empty>尚无已验证事实。</Empty> : (
            <ul className="space-y-2">
              {sections.facts.map((fact, index) => (
                <li key={textOf(fact.findingId) || index} className="border-b border-line pb-2 text-xs">
                  <p className="text-paper">{textOf(fact.title) || '—'}</p>
                  <p className="mono mt-1 text-[10px] text-faint">{textOf(fact.category)} · {textOf(fact.severity)} · {textOf(fact.artifact) || '无产物'}</p>
                </li>
              ))}
            </ul>
          )}
        </BoardCard>

        <BoardCard title="能力" icon={<GitBranch className="size-3.5" aria-hidden="true" />} count={sections.capabilities.length}>
          {sections.capabilities.length === 0 ? <Empty>尚未记录已验证能力。</Empty> : (
            <ul className="flex flex-wrap gap-2">
              {sections.capabilities.map((capability, index) => (
                <li key={textOf(capability.taskId) || index} className="border border-line px-2.5 py-1.5 text-[11px] text-muted">
                  {textOf(capability.type) === 'bootstrap' ? '引导任务' : textOf(capability.type) === 'intent' ? '意图任务' : textOf(capability.type) || '任务'}
                </li>
              ))}
            </ul>
          )}
        </BoardCard>

        <BoardCard title="负面线索" icon={<AlertTriangle className="size-3.5" aria-hidden="true" />} count={sections.negatives.length}>
          {sections.negatives.length === 0 ? <Empty>暂无负面结果或阻塞任务。</Empty> : (
            <ul className="space-y-2">
              {sections.negatives.map((negative, index) => (
                <li key={`${textOf(negative.type)}-${index}`} className="flex items-start gap-2 text-xs">
                  <Badge tone={textOf(negative.type) === 'needs_review' ? 'ember' : 'muted'}>{textOf(negative.type) === 'needs_review' ? findingStatusLabel('needs_review') : textOf(negative.type) === 'blocked_task' ? '阻塞任务' : textOf(negative.type) || '负面线索'}</Badge>
                  <span className="min-w-0 flex-1 text-muted">{textOf(negative.title) || textOf(negative.lastError) || textOf(negative.taskId)}</span>
                </li>
              ))}
            </ul>
          )}
        </BoardCard>

        <BoardCard title="发现" icon={<FileSearch className="size-3.5" aria-hidden="true" />} count={sections.findings.length}>
          {sections.findings.length === 0 ? <Empty>尚未产生 finding。</Empty> : (
            <ul className="space-y-2">
              {sections.findings.map(finding => (
                <li key={finding.id} className="border-b border-line pb-2">
                  <Link to={`/findings/${finding.id}`} className="group flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-xs text-paper group-hover:text-lime">{finding.title}</p>
                      <div className="mt-1 flex flex-wrap items-center gap-2">
                        {finding.severity ? <SeverityBadge severity={finding.severity} /> : null}
                        <span className="text-[10px] uppercase tracking-[0.1em] text-faint">{confidenceLabel(finding.confidence ?? 'unverified')}</span>
                        {finding.mergedCount ? <span className="text-[10px] text-faint">合并 ×{finding.mergedCount}</span> : null}
                      </div>
                    </div>
                    <ArrowUpRight className="size-3.5 shrink-0 text-faint group-hover:text-lime" aria-hidden="true" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </BoardCard>

        <BoardCard title="待办" icon={<ListChecks className="size-3.5" aria-hidden="true" />} count={sections.todo.length}>
          {sections.todo.length === 0 ? <Empty>暂无待办。</Empty> : (
            <ol className="space-y-2">
              {sections.todo.map((item, index) => (
                <li key={textOf(item.id) || index} className="flex items-start gap-3 text-xs">
                  <span className="mono text-[10px] text-faint">{String(item.position ?? index).padStart(2, '0')}</span>
                  <span className={textOf(item.status) === 'done' ? 'text-muted line-through' : 'text-paper'}>{textOf(item.content)}</span>
                </li>
              ))}
            </ol>
          )}
        </BoardCard>

        <BoardCard title="证据" icon={<Database className="size-3.5" aria-hidden="true" />} count={Number(sections.evidence.total ?? 0)}>
          <EvidenceSummary evidence={sections.evidence} />
        </BoardCard>
      </div>
    </div>
  );
}

async function apiBoard(missionId: string): Promise<MissionBoard> {
  const response = await api.getMissionBoard(missionId);
  return response.board;
}

function BoardCard({ title, icon, count, children }: { title: string; icon: ReactNode; count: number; children: ReactNode }) {
  return (
    <Panel className="flex min-h-0 flex-col p-4">
      <SectionLabel right={<span className="inline-flex items-center gap-1.5 text-faint">{icon}<span className="mono text-[10px]">{count}</span></span>}>
        {title}
      </SectionLabel>
      <div className="mt-3 min-h-0 flex-1 overflow-y-auto pr-1 [max-height:190px]">{children}</div>
    </Panel>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="border border-dashed border-line px-3 py-5 text-xs text-faint">{children}</p>;
}

const SCOPE_KEY_LABELS: Record<string, string> = {
  name: '名称',
  state: '状态',
  target: '靶标',
  grantId: '授权 ID',
  grantVersion: '授权版本',
  scope: '授权范围',
};

function KeyValues({ value }: { value: Record<string, unknown> }) {
  const entries = Object.entries(value);
  if (entries.length === 0) return <Empty>暂无 scope 投影。</Empty>;
  return (
    <dl className="space-y-1.5">
      {entries.map(([key, item]) => (
        <div key={key} className="flex items-start justify-between gap-3 border-b border-line pb-1.5 text-[11px]">
          <dt className="shrink-0 uppercase tracking-[0.1em] text-faint">{SCOPE_KEY_LABELS[key] ?? key}</dt>
          <dd className="mono min-w-0 break-all text-right text-muted">
            {typeof item === 'object' && item !== null ? JSON.stringify(item).slice(0, 160) : textOf(item) || '—'}
          </dd>
        </div>
      ))}
    </dl>
  );
}

const EVIDENCE_KEY_LABELS: Record<string, string> = {
  total: '总数',
  target: '目标流量',
  internet: '互联网检索',
  distinctUrls: '不同 URL',
};

function EvidenceSummary({ evidence }: { evidence: Record<string, unknown> }) {
  const triggers = Array.isArray(evidence.triggers) ? evidence.triggers : [];
  return (
    <div>
      <dl className="grid grid-cols-2 gap-2">
        {['total', 'target', 'internet', 'distinctUrls'].map(key => (
          <div key={key} className="border border-line bg-ink-2 px-2.5 py-2">
            <dt className="text-[9px] uppercase tracking-[0.1em] text-faint">{EVIDENCE_KEY_LABELS[key] ?? key}</dt>
            <dd className="mono mt-1 text-sm text-paper">{Number(evidence[key] ?? 0)}</dd>
          </div>
        ))}
      </dl>
      {triggers.length > 0 ? (
        <ul className="mt-3 flex flex-wrap gap-2">
          {triggers.map((trigger, index) => {
            const record = asRecord(trigger);
            return <li key={index} className="border border-line px-2 py-1 text-[10px] text-muted">{triggerKindLabel(textOf(record.kind))} · {triggerRouteLabel(textOf(record.route))} · ×{Number(record.count ?? 0)}</li>;
          })}
        </ul>
      ) : null}
    </div>
  );
}
