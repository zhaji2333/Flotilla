import { ArrowUpRight, ChevronLeft, ChevronRight } from 'lucide-react';

import { Link } from 'react-router-dom';
import { formatShortDate } from '../lib/format';
import type { FindingListItem } from '../lib/types';
import { Button } from './ui';
import { ConfidenceBadge } from './confidence-badge';
import { DetailPanel } from './detail-panel';
import { FindingStatusBadge, SeverityBadge } from './status-badge';

const PAGE_SIZE = 10;

// One detail panel per mission: lists every finding of the mission with its own
// pagination (10/page) so a mission is never split by the global archive page.
// A finding row is a normal link to the full finding page (no nested drawers).
export function MissionFindingsDetail({
  missionId,
  missionName,
  findings,
  page,
  onClose,
  onPageChange,
}: {
  missionId: string;
  missionName: string;
  findings: FindingListItem[];
  page: number;
  onClose: () => void;
  onPageChange: (page: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(findings.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const shown = findings.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const pager = (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-[10px] uppercase tracking-[0.12em] text-faint">
        本页 {shown.length} / 共 {findings.length} findings · 第 {currentPage} / {totalPages} 页
      </p>
      <div className="flex items-center gap-2">
        <Button variant="outline" disabled={currentPage <= 1} onClick={() => onPageChange(currentPage - 1)} icon={<ChevronLeft className="size-3.5" aria-hidden="true" />}>上一页</Button>
        <Button variant="outline" disabled={currentPage >= totalPages} onClick={() => onPageChange(currentPage + 1)}>
          下一页
          <ChevronRight className="size-3.5" aria-hidden="true" />
        </Button>
      </div>
    </div>
  );

  return (
    <DetailPanel
      open
      onOpenChange={open => { if (!open) onClose(); }}
      title={missionName}
      description={`${missionId.slice(0, 8)} · 该项目共 ${findings.length} findings`}
      footer={
        <>
          <span className="micro">项目详情 · 10 条/页</span>
          <div className="flex flex-wrap items-center gap-2">
            <Link to={`/missions/${missionId}`} className="btn btn-outline">
              打开项目
              <ArrowUpRight className="size-3.5" aria-hidden="true" />
            </Link>
            <Button variant="ghost" onClick={onClose}>关闭</Button>
          </div>
        </>
      }
    >
      <div className="mb-4 border-b border-line pb-4">{pager}</div>

      {shown.length === 0 ? (
        <p className="border border-dashed border-line px-4 py-8 text-center text-sm text-muted">当前筛选下该项目没有 findings。</p>
      ) : (
      <ul role="list" className="divide-y divide-line border-y border-line">
        {shown.map((finding, index) => (
          <li key={finding.id}>
            <Link
              to={`/findings/${finding.id}?mission=${missionId}&page=${currentPage}`}
              className="group grid w-full gap-2 px-2 py-4 transition-colors hover:bg-paper/[0.02] sm:grid-cols-[28px_1fr_auto] sm:items-start sm:px-3"
              aria-label={`查看发现详情：${finding.title}`}
            >
              <span className="mono text-[10px] text-faint">{String((currentPage - 1) * PAGE_SIZE + index + 1).padStart(2, '0')}</span>
              <div className="min-w-0">
                <p className="text-[13px] leading-relaxed text-paper transition-colors group-hover:text-lime">{finding.title}</p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <SeverityBadge severity={finding.severity} />
                  <FindingStatusBadge status={finding.status} />
                  <ConfidenceBadge confidence={finding.confidence} />
                  {finding.mergedCount > 0 ? <span className="text-[10px] text-faint">合并 ×{finding.mergedCount}</span> : null}
                </div>
                <p className="mono mt-2 truncate text-[10px] text-faint">
                  {finding.category} · {finding.evidenceCount} 证据 · {formatShortDate(finding.createdAt)}
                </p>
                {finding.artifact ? <p className="mono mt-1 truncate text-[10px] text-lime">{finding.artifact}</p> : null}
              </div>
              <ArrowUpRight className="size-3.5 text-faint transition-colors group-hover:text-lime" aria-hidden="true" />
            </Link>
          </li>
        ))}
      </ul>
      )}

      {totalPages > 1 ? <div className="mt-4 border-t border-line pt-4">{pager}</div> : null}
    </DetailPanel>
  );
}
