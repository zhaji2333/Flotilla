import { ArrowUpRight, FileSearch, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PageHeader } from '../components/shell';
import { MissionFindingsDetail } from '../components/mission-findings-detail';
import { ErrorState, Input, Skeleton } from '../components/ui';
import { SpringSelect } from '../components/spring-select';
import { api } from '../lib/api';
import { severityLabel } from '../lib/format';
import { useAsync } from '../lib/hooks';
import type { Confidence, FindingListItem, FindingStatus, Severity } from '../lib/types';
import { cn } from '../lib/utils';

const SEVERITIES: Array<Severity | 'all'> = ['all', 'critical', 'high', 'medium', 'low', 'info'];
const STATUSES: Array<FindingStatus | 'all'> = ['all', 'accepted', 'needs_review', 'rejected'];
const CONFIDENCES: Array<Confidence | 'all'> = ['all', 'observed', 'inferred', 'unverified'];
const CONFIDENCE_LABEL: Record<Confidence | 'all', string> = {
  all: '全部置信度',
  observed: '已观测 (observed)',
  inferred: '推断 (inferred)',
  unverified: '未验证 (unverified)',
};

export function Findings() {
  const findings = useAsync(() => api.listFindings(), []);
  const [query, setQuery] = useState('');
  const [severity, setSeverity] = useState<Severity | 'all'>('all');
  const [status, setStatus] = useState<FindingStatus | 'all'>('all');
  const [confidence, setConfidence] = useState<Confidence | 'all'>('all');
  const [missionFilter, setMissionFilter] = useState('all');
  const [searchParams, setSearchParams] = useSearchParams();

  const rows = useMemo(() => {
    const list = findings.data?.findings ?? [];
    return list.filter(finding => {
      if (severity !== 'all' && finding.severity !== severity) return false;
      if (status !== 'all' && finding.status !== status) return false;
      if (confidence !== 'all' && finding.confidence !== confidence) return false;
      if (missionFilter !== 'all' && finding.missionId !== missionFilter) return false;
      if (!query.trim()) return true;
      const needle = query.trim().toLowerCase();
      return (
        finding.title.toLowerCase().includes(needle) ||
        finding.category.toLowerCase().includes(needle) ||
        finding.missionName.toLowerCase().includes(needle) ||
        (finding.artifact ?? '').toLowerCase().includes(needle)
      );
    });
  }, [findings.data, query, severity, status, confidence, missionFilter]);

  const missionOptions = useMemo(() => {
    const unique = new Map<string, string>();
    for (const finding of findings.data?.findings ?? []) unique.set(finding.missionId, finding.missionName);
    return [...unique.entries()].map(([id, name]) => ({ id, name })).toSorted((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  }, [findings.data]);

  const groups = useMemo(() => {
    const grouped = new Map<string, { missionId: string; missionName: string; items: FindingListItem[] }>();
    for (const finding of rows) {
      const existing = grouped.get(finding.missionId);
      if (existing) existing.items.push(finding);
      else grouped.set(finding.missionId, { missionId: finding.missionId, missionName: finding.missionName, items: [finding] });
    }
    return [...grouped.values()].toSorted((a, b) => a.missionName.localeCompare(b.missionName, 'zh-CN'));
  }, [rows]);

  const activeMissionId = searchParams.get('mission');
  const activePage = Math.max(1, Number(searchParams.get('page') ?? '1') || 1);
  const allFindings = findings.data?.findings ?? [];
  const activeMissionName = activeMissionId
    ? allFindings.find(finding => finding.missionId === activeMissionId)?.missionName ?? activeMissionId.slice(0, 8)
    : null;

  function openMission(missionId: string): void {
    setSearchParams({ mission: missionId, page: '1' });
  }

  function closeMission(): void {
    setSearchParams({}, { replace: true });
  }

  function changeMissionPage(nextPage: number): void {
    if (!activeMissionId) return;
    setSearchParams({ mission: activeMissionId, page: String(Math.max(1, nextPage)) });
  }

  return (
    <div className="mx-auto w-full max-w-[1500px]">
      <PageHeader
        index="02 / FINDINGS"
        title={<>发现档案</>}
        aside={
          <div className="text-right">
            <p className="display text-[clamp(2.6rem,5vw,4.6rem)] text-paper">{findings.data?.total ?? '—'}</p>
            <p className="micro mt-1">accepted & review</p>
          </div>
        }
      />

      <div className="mb-5 flex flex-col gap-3 border-b border-line pb-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-1.5">
            {SEVERITIES.map(option => (
              <button key={option} type="button" className={cn('chip', severity === option && 'chip-active')} aria-pressed={severity === option} onClick={() => setSeverity(option)}>
                {option === 'all' ? '全部严重度' : severityLabel(option)}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <SpringSelect<string>
              value={missionFilter}
              onChange={setMissionFilter}
              ariaLabel="按项目筛选"
              className="min-w-[180px]"
              options={[{ value: 'all', label: '全部项目' }, ...missionOptions.map(option => ({ value: option.id, label: option.name }))]}
            />
            <label className="relative min-w-[240px] flex-1 sm:max-w-xs">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-faint" aria-hidden="true" />
              <Input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索标题 / 项目" className="h-8 py-0 pl-9 text-[11px] leading-8 placeholder:text-[11px]" aria-label="搜索发现" />
            </label>
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {STATUSES.map(option => (
            <button key={option} type="button" className={cn('chip', status === option && 'chip-active')} aria-pressed={status === option} onClick={() => setStatus(option)}>
              {option === 'all' ? '全部状态' : option === 'accepted' ? '已接受' : option === 'needs_review' ? '待复核' : '已拒绝'}
            </button>
          ))}
          <span className="mx-1 h-5 w-px self-center bg-line" aria-hidden="true" />
          {CONFIDENCES.map(option => (
            <button key={option} type="button" className={cn('chip', confidence === option && 'chip-active')} aria-pressed={confidence === option} onClick={() => setConfidence(option)}>
              {CONFIDENCE_LABEL[option]}
            </button>
          ))}
        </div>
      </div>

      {findings.loading ? (
        <div className="space-y-2" aria-busy="true">{Array.from({ length: 6 }).map((_, index) => <Skeleton key={index} className="h-24 w-full" />)}</div>
      ) : findings.error ? (
        <ErrorState error={findings.error} retry={findings.refresh} />
      ) : rows.length === 0 ? (
        <div className="border border-dashed border-line px-6 py-16 text-center">
          <FileSearch className="mx-auto size-7 text-faint" aria-hidden="true" />
          <p className="display mt-4 text-[12px] tracking-[0.16em] text-paper">没有匹配的发现</p>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted">调整筛选条件，或等待 Worker 完成证据提交。</p>
        </div>
      ) : (
        <div className="grid gap-3">
          {groups.map(group => {
            const severityCounts = SEVERITIES.filter((option): option is Severity => option !== 'all')
              .map(option => ({ value: option, count: group.items.filter(item => item.severity === option).length }))
              .filter(item => item.count > 0);
            return (
              <button
                key={group.missionId}
                type="button"
                onClick={() => openMission(group.missionId)}
                className="group w-full border border-line bg-panel px-4 py-4 text-left transition-colors hover:border-white/15 hover:bg-surface-2 sm:px-5"
                aria-label={`打开项目 ${group.missionName} 的发现详情`}
              >
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span className="display text-[16px] leading-tight tracking-[0.01em] text-paper transition-colors group-hover:text-lime">{group.missionName}</span>
                      <span className="mono text-[10px] text-faint">{group.missionId.slice(0, 8)}</span>
                    </div>
                    <p className="mt-2 text-[10px] uppercase tracking-[0.12em] text-faint">
                      {group.items.length} findings · 点击查看项目详情
                    </p>
                    <div className="mt-3 flex flex-wrap items-center gap-3">
                      {severityCounts.map(item => (
                        <span key={item.value} className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-[0.1em] text-muted">
                          {severityLabel(item.value)}
                          <span className="mono text-paper">{item.count}</span>
                        </span>
                      ))}
                    </div>
                  </div>
                  <span className="inline-flex items-center gap-1.5 border border-lime/30 bg-lime/10 px-2.5 py-1.5 text-[10px] uppercase tracking-[0.1em] text-lime transition-colors group-hover:bg-lime group-hover:text-ink">
                    查看详情
                    <ArrowUpRight className="size-3.5" aria-hidden="true" />
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      )}
      {activeMissionId && activeMissionName ? (
        <MissionFindingsDetail
          missionId={activeMissionId}
          missionName={activeMissionName}
          findings={rows.filter(finding => finding.missionId === activeMissionId)}
          page={activePage}
          onClose={closeMission}
          onPageChange={changeMissionPage}
        />
      ) : null}
    </div>
  );
}
