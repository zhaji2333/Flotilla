import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, FileSearch } from 'lucide-react';
import { useAsync } from '../lib/hooks';
import { api } from '../lib/api';
import { Button, Panel, SectionLabel, Skeleton } from './ui';
import { cn } from '../lib/utils';

export function MissionSummaryPanel({ missionId }: { missionId: string }) {
  const summary = useAsync(() => api.getMissionSummary(missionId), [missionId]);
  const [open, setOpen] = useState(false);
  if (summary.loading) return <Skeleton className="h-32 w-full" />;
  if (summary.error || !summary.data?.summary) return null;
  const item = summary.data.summary;
  return (
    <Panel className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <SectionLabel>审查摘要</SectionLabel>
          <p className="mt-2 text-xs text-muted">
            由 Summary / 补漏任务生成的自动审查
            {item.gaps.length > 0 ? <> · <span className="text-amber-300">{item.gaps.length} 个缺口</span></> : ' · 未发现缺口'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link to={`/findings?mission=${encodeURIComponent(missionId)}`} className="btn btn-ghost">
            <FileSearch className="size-3.5" aria-hidden="true" />
            查看相关发现
          </Link>
          <Button
            variant="outline"
            onClick={() => setOpen(value => !value)}
            aria-expanded={open}
            aria-controls={`mission-summary-${missionId}`}
            icon={<ChevronDown className={cn('size-3.5 transition-transform duration-150', open && 'rotate-180')} aria-hidden="true" />}
          >
            {open ? '收起审查详情' : '展开审查详情'}
          </Button>
        </div>
      </div>

      {open ? (
        <div id={`mission-summary-${missionId}`} className="mt-4 border-t border-line pt-4">
          <p className="text-xs text-muted">覆盖评估：{item.coverageAssessment ?? '—'}</p>
          <pre className="mt-3 whitespace-pre-wrap break-words text-sm leading-relaxed text-paper/90">{item.markdown}</pre>
          {item.gaps.length > 0 ? (
            <div className="mt-4 space-y-2">
              <p className="micro text-faint">发现项目缺口 ({item.gaps.length})</p>
              {item.gaps.map((gap, index) => (
                <div key={`${gap.area}-${index}`} className="border border-line/70 bg-ink/30 p-3 text-xs">
                  <p className="text-paper">{gap.area} · {gap.confidence}</p>
                  <p className="mt-1 text-muted">{gap.reason}</p>
                  <p className="mt-1 text-lime">建议：{gap.suggestedCheck}</p>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </Panel>
  );
}
