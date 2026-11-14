import { ArrowLeft, ArrowUpRight, Boxes, BrainCircuit, Gauge, GitBranch, Layers, Network, PanelsTopLeft, Search } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { MissionState } from '../lib/types';
import { cn } from '../lib/utils';
import { PageHeader } from './shell';
import { MissionStatus } from './status-badge';

export type MissionViewKey = 'project' | 'overview' | 'dag' | 'board' | 'blackboard' | 'explore' | 'assets' | 'traces';

export const MISSION_VIEWS: Array<{ key: MissionViewKey; label: string; to: (id: string) => string; icon: typeof PanelsTopLeft }> = [
  { key: 'project', label: '项目概览', to: id => `/missions/${id}/overview`, icon: Gauge },
  { key: 'overview', label: '项目详情', to: id => `/missions/${id}`, icon: PanelsTopLeft },
  { key: 'dag', label: '依赖图', to: id => `/missions/${id}/dag`, icon: GitBranch },
  { key: 'board', label: '线索板', to: id => `/missions/${id}/board`, icon: Layers },
  { key: 'blackboard', label: '黑板', to: id => `/missions/${id}/blackboard`, icon: BrainCircuit },
  { key: 'explore', label: '探索图', to: id => `/missions/${id}/explore`, icon: Network },
  { key: 'assets', label: '资产图', to: id => `/missions/${id}/assets`, icon: Boxes },
  { key: 'traces', label: '轨迹检索', to: id => `/missions/${id}/traces`, icon: Search },
];

export interface MissionHeaderInfo {
  id: string;
  name: string;
  state: MissionState;
  objective: string | null;
  target: { value: string } | null;
}

export function MissionViewsNav({ missionId, active }: { missionId: string; active: MissionViewKey }) {
  return (
    <nav aria-label="任务视图" className="mb-6 flex flex-wrap gap-2 border-b border-line pb-4">
      {MISSION_VIEWS.map(view => {
        const Icon = view.icon;
        const isActive = view.key === active;
        return (
          <Link
            key={view.key}
            to={view.to(missionId)}
            aria-current={isActive ? 'page' : undefined}
            className={cn(
              'inline-flex items-center gap-2 border px-3 py-2 text-[10px] uppercase tracking-[0.14em] transition-colors',
              isActive
                ? 'border-lime/45 bg-lime/10 text-lime'
                : 'border-line text-muted hover:border-lime/30 hover:text-paper',
            )}
          >
            <Icon className="size-3.5" aria-hidden="true" />
            {view.label}
            {isActive ? <span className="ml-1 size-1.5 rounded-full bg-lime" aria-hidden="true" /> : null}
          </Link>
        );
      })}
    </nav>
  );
}

export function MissionViewHeader({
  mission,
  active,
  index,
  title,
  description,
  actions,
  aside,
}: {
  mission: MissionHeaderInfo;
  active: MissionViewKey;
  index: string;
  title: ReactNode;
  description?: string;
  actions?: ReactNode;
  aside?: ReactNode;
}) {
  const view = MISSION_VIEWS.find(item => item.key === active);
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3 text-[10px] uppercase tracking-[0.16em] text-faint">
        <Link to="/missions" className="inline-flex items-center gap-1 hover:text-lime"><ArrowLeft className="size-3" aria-hidden="true" />项目列表</Link>
        <span className="h-px w-6 bg-line" aria-hidden="true" />
        <Link to={`/missions/${mission.id}`} className="truncate hover:text-lime">{mission.name}</Link>
        <span className="h-px w-6 bg-line" aria-hidden="true" />
        <span className="mono">{mission.id.slice(0, 8)}</span>
        {view ? <><span className="h-px w-6 bg-line" aria-hidden="true" /><span>{view.label}</span></> : null}
      </div>
      <PageHeader
        index={index}
        title={title}
        description={description ?? mission.objective ?? undefined}
        actions={
          actions ?? (
            <Link to={`/missions/${mission.id}`} className="btn btn-ghost">
              返回项目概览 <ArrowUpRight className="size-3.5" aria-hidden="true" />
            </Link>
          )
        }
        aside={
          aside ?? (
            <div className="space-y-2 text-left lg:text-right">
              <div className="flex items-center gap-2 lg:justify-end"><MissionStatus state={mission.state} /></div>
              <p className="mono break-all text-xs text-muted">{mission.target?.value ?? '未设置目标'}</p>
            </div>
          )
        }
      />
      <MissionViewsNav missionId={mission.id} active={active} />
    </>
  );
}
