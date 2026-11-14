import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from './ui';
import { cn } from '../lib/utils';

// Client-side pagination for the fixed-size list endpoints (missions 50,
// findings 100, approvals 100, traces 3000). The API has no
// cursor yet, so pages are sliced locally and the cap is shown honestly.
export function Pager({
  page,
  totalPages,
  pageSize,
  totalItems,
  onPageChange,
  note,
  className,
}: {
  page: number;
  totalPages: number;
  pageSize: number;
  totalItems: number;
  onPageChange: (page: number) => void;
  note?: string;
  className?: string;
}) {
  const current = Math.min(Math.max(1, page), totalPages);
  return (
    <nav className={cn('flex flex-wrap items-center justify-between gap-3', className)} aria-label="分页">
      <p className="text-[10px] uppercase tracking-[0.12em] text-faint">
        第 {current} / {totalPages} 页 · 每页 {pageSize} 条 · 共 {totalItems} 条{note ? `（${note}）` : ''}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" disabled={current <= 1} onClick={() => onPageChange(1)}>首页</Button>
        <Button
          variant="outline"
          disabled={current <= 1}
          icon={<ChevronLeft className="size-3.5" aria-hidden="true" />}
          onClick={() => onPageChange(current - 1)}
        >
          上一页
        </Button>
        <span className="mono min-w-16 text-center text-[11px] text-muted">{current} / {totalPages}</span>
        <Button
          variant="outline"
          disabled={current >= totalPages}
          onClick={() => onPageChange(current + 1)}
        >
          下一页
          <ChevronRight className="size-3.5" aria-hidden="true" />
        </Button>
        <Button variant="ghost" disabled={current >= totalPages} onClick={() => onPageChange(totalPages)}>末页</Button>
      </div>
    </nav>
  );
}
