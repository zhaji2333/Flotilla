import { ArrowLeft, ArrowUpRight, Bell, CheckCircle2, ChevronLeft, ChevronRight, FileWarning, ShieldAlert } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { EvidenceViewer } from '../components/evidence-viewer';
import { PageHeader } from '../components/shell';
import { ConfidenceBadge } from '../components/confidence-badge';
import { FindingStatusBadge, SeverityBadge } from '../components/status-badge';
import { CopyButton, ErrorState, Panel, SectionLabel, Skeleton } from '../components/ui';
import { api } from '../lib/api';
import { formatDate } from '../lib/format';
import { useAsync } from '../lib/hooks';

export function FindingDetail() {
  const { id } = useParams<{ id: string }>();
  const state = useAsync(() => api.getFinding(id ?? ''), [id]);
  const listState = useAsync(() => api.listFindings(), []);
  const lineageState = useAsync(() => api.getFindingLineage(id ?? ''), [id]);

  if (state.loading) {
    return <div className="mx-auto w-full max-w-[1200px] space-y-4"><Skeleton className="h-24 w-full" /><Skeleton className="h-96 w-full" /></div>;
  }
  if (state.error || !state.data) {
    return <ErrorState error={state.error ?? '发现不存在。'} retry={state.refresh} />;
  }
  const finding = state.data.finding;
  const sameMission = (listState.data?.findings ?? []).filter(item => item.missionId === finding.missionId);
  const siblingIndex = sameMission.findIndex(item => item.id === finding.id);
  const pageFor = (item: { id: string }): number => {
    const at = sameMission.findIndex(entry => entry.id === item.id);
    return at >= 0 ? Math.floor(at / 10) + 1 : 1;
  };
  const taskPage = siblingIndex >= 0 ? pageFor(finding) : 1;
  const prevFinding = siblingIndex > 0 ? sameMission[siblingIndex - 1] : undefined;
  const nextFinding = siblingIndex >= 0 && siblingIndex < sameMission.length - 1 ? sameMission[siblingIndex + 1] : undefined;
  const backToTask = siblingIndex >= 0 ? `/findings?mission=${finding.missionId}&page=${taskPage}` : '/findings';

  return (
    <div className="mx-auto w-full max-w-[1300px]">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 text-[10px] uppercase tracking-[0.16em] text-faint">
        <div className="flex flex-wrap items-center gap-3">
          <Link to={backToTask} className="inline-flex items-center gap-1 hover:text-lime">
            <ArrowLeft className="size-3" aria-hidden="true" />返回项目详情
          </Link>
          <span className="h-px w-6 bg-line" aria-hidden="true" />
          <span className="mono">{finding.id.slice(0, 8)}</span>
          <span className="h-px w-6 bg-line" aria-hidden="true" />
          <span>{finding.missionName}</span>
        </div>
        {siblingIndex >= 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="mono text-[10px] normal-case tracking-normal text-faint">同项目 {siblingIndex + 1} / {sameMission.length}</span>
            {prevFinding ? (
              <Link to={`/findings/${prevFinding.id}?mission=${finding.missionId}&page=${pageFor(prevFinding)}`} className="btn btn-outline px-2 py-1 text-[10px]">
                <ChevronLeft className="size-3" aria-hidden="true" />上一条
              </Link>
            ) : (
              <span className="inline-flex items-center gap-1 border border-line px-2 py-1 text-[10px] uppercase tracking-[0.1em] text-faint opacity-50">
                <ChevronLeft className="size-3" aria-hidden="true" />上一条
              </span>
            )}
            {nextFinding ? (
              <Link to={`/findings/${nextFinding.id}?mission=${finding.missionId}&page=${pageFor(nextFinding)}`} className="btn btn-outline px-2 py-1 text-[10px]">
                下一条<ChevronRight className="size-3" aria-hidden="true" />
              </Link>
            ) : (
              <span className="inline-flex items-center gap-1 border border-line px-2 py-1 text-[10px] uppercase tracking-[0.1em] text-faint opacity-50">
                下一条<ChevronRight className="size-3" aria-hidden="true" />
              </span>
            )}
          </div>
        ) : null}
      </div>

      <PageHeader
        compact
        index={`02 / FINDING / ${finding.id.slice(0, 6)}`}
        title={<span className="break-words">{finding.title}</span>}
        description={`${finding.category} · ${finding.evidenceCount} 条证据 · 合并 ${finding.mergedCount} 次 · 创建于 ${formatDate(finding.createdAt)}`}
        actions={
          <>
            <SeverityBadge severity={finding.severity} />
            <FindingStatusBadge status={finding.status} />
            <ConfidenceBadge confidence={finding.confidence} />
            <Link to={`/missions/${finding.missionId}`} className="btn btn-outline">
              打开项目 <ArrowUpRight className="size-3.5" aria-hidden="true" />
            </Link>
          </>
        }
        aside={
          finding.artifact ? (
            <div className="border border-lime/30 bg-lime/5 px-4 py-3 text-left">
              <p className="micro text-lime">目标产物</p>
              <p className="mono mt-1 break-all text-xs text-paper">{finding.artifact}</p>
              <div className="mt-2"><CopyButton value={finding.artifact} /></div>
            </div>
          ) : null
        }
      />

      <div className="grid gap-6 lg:grid-cols-[1.35fr_0.65fr]">
        <Panel className="min-w-0 overflow-hidden p-5">
          <SectionLabel index="报告">验证报告</SectionLabel>
          <div className="prose-report">
            {finding.reportMd ? (
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{finding.reportMd}</ReactMarkdown>
            ) : (
              <p className="text-sm text-muted">该发现没有附带 Markdown 报告。</p>
            )}
          </div>
        </Panel>

        <div className="min-w-0 space-y-4">
          <Panel className="p-5">
            <SectionLabel index="Curator 判定">Curator 判定</SectionLabel>
            <div className="flex items-start gap-3">
              {finding.status === 'accepted' ? <CheckCircle2 className="mt-0.5 size-4 text-emerald-300" aria-hidden="true" />
                : finding.status === 'needs_review' ? <FileWarning className="mt-0.5 size-4 text-amber-300" aria-hidden="true" />
                  : <ShieldAlert className="mt-0.5 size-4 text-ember" aria-hidden="true" />}
              <div>
                <p className="text-sm text-paper">
                  {finding.status === 'accepted' ? '证据闸通过，发现已接受。' : finding.status === 'needs_review' ? '需要人工复核证据。' : '证据不足，发现被拒绝。'}
                </p>
                <p className="mt-1 text-[11px] text-faint">证据 ID 必须能在真实流量中回查，不接受模型伪造的引用。</p>
              </div>
            </div>
            {finding.curatorReasons.length > 0 ? (
              <ul className="mt-4 space-y-2 border-t border-line pt-4">
                {finding.curatorReasons.map((reason, index) => (
                  <li key={`${reason}-${index}`} className="flex items-start gap-2 text-xs leading-relaxed text-muted">
                    <span className="mono mt-0.5 text-[10px] text-faint">{String(index + 1).padStart(2, '0')}</span>
                    {reason}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-4 border-t border-line pt-4 text-xs text-faint">没有额外判定原因。</p>
            )}
          </Panel>

          <Panel className="p-5">
            <SectionLabel index="元数据">元数据</SectionLabel>
            <dl className="space-y-2 text-xs">
              <MetaRow label="mission id" value={finding.missionId} />
              <MetaRow label="category" value={finding.category} />
              <MetaRow label="evidence" value={`${finding.evidenceCount} entries`} />
              <MetaRow label="artifact" value={finding.artifact ?? '—'} />
              <MetaRow label="confidence" value={finding.confidence} />
              <MetaRow label="merged count" value={String(finding.mergedCount)} />
              <MetaRow label="created" value={formatDate(finding.createdAt)} />
            </dl>
          </Panel>

          <div className="border border-line p-4">
            <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.14em] text-faint">
              <Bell className="size-3" aria-hidden="true" />
              证据不可变
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-muted">
              原始请求/响应以 baseline + proof 形式保存；互联网内容标记为不可信数据。前端只读展示，不提供编辑入口。
            </p>
          </div>
        </div>
      </div>

      <section className="mt-8" aria-labelledby="lineage-section">
        <SectionLabel index="血缘" right={<span className="text-[10px] uppercase tracking-[0.12em] text-faint">derived · same mission</span>}>
          <span id="lineage-section">发现血缘</span>
        </SectionLabel>
        {lineageState.loading ? (
          <Skeleton className="h-32 w-full" />
        ) : lineageState.error ? (
          <p className="border border-line p-4 text-xs text-muted">血缘暂时不可用：{String(lineageState.error)}</p>
        ) : lineageState.data ? (
          <Panel className="p-5">
            <p className="text-xs leading-relaxed text-muted">
              血缘由已持久化的 finding / task / evidence 派生，不跨 mission。证据是唯一事实源；同一组证据或 superseded 链会出现在这里。
            </p>
            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              <div>
                <p className="micro text-faint">关联发现</p>
                {lineageState.data.lineage.relatedFindings.length === 0 ? (
                  <p className="mt-2 text-xs text-faint">没有共享证据的同项目 finding。</p>
                ) : (
                  <ul className="mt-2 space-y-2">
                    {lineageState.data.lineage.relatedFindings.map(item => (
                      <li key={item.id} className="flex items-start justify-between gap-3 border-b border-line pb-2 text-xs">
                        <Link to={`/findings/${item.id}`} className="min-w-0 text-paper hover:text-lime">
                          <span className="line-clamp-2">{item.title}</span>
                          <span className="mt-1 block text-[10px] text-faint">
                            {item.status} · 共享证据 {item.sharedEvidenceCount}
                          </span>
                        </Link>
                        <ArrowUpRight className="mt-0.5 size-3 shrink-0 text-lime" aria-hidden="true" />
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <p className="micro text-faint">任务与证据</p>
                <p className="mt-2 text-xs text-muted">
                  {lineageState.data.lineage.nodes.filter(node => node.type === 'task').map(node => node.label).join(' · ') || '没有关联任务'}
                </p>
                <p className="mt-2 text-xs text-faint">
                  {lineageState.data.lineage.nodes.filter(node => node.type === 'evidence').length} 条证据节点 ·
                  {' '}{lineageState.data.lineage.nodes.filter(node => node.type === 'finding').length} 个 finding 节点
                </p>
                {lineageState.data.lineage.supersededBy ? (
                  <p className="mt-2 text-xs text-amber-300">已被后续 finding 取代；superseded_by 链已展开。</p>
                ) : null}
              </div>
            </div>
          </Panel>
        ) : null}
      </section>

      <section className="mt-8" aria-labelledby="evidence-section">
        <SectionLabel index="证据" right={<span className="text-[10px] uppercase tracking-[0.12em] text-faint">baseline + proof</span>}>
          <span id="evidence-section">证据链</span>
        </SectionLabel>
        <EvidenceViewer evidence={finding.evidence} />
      </section>
    </div>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-line pb-2">
      <dt className="text-[10px] uppercase tracking-[0.12em] text-faint">{label}</dt>
      <dd className="mono min-w-0 break-all text-right text-[11px] text-muted">{value}</dd>
    </div>
  );
}
