import { RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { BlackboardPanel } from '../components/blackboard-panel';
import { MissionIntelPanel } from '../components/mission-intel-panel';
import { MissionViewHeader } from '../components/mission-views';
import { Button, ErrorState, Skeleton } from '../components/ui';
import { api } from '../lib/api';
import { cn } from '../lib/utils';
import { useAsync } from '../lib/hooks';

export function MissionBlackboard() {
  const { id } = useParams<{ id: string }>();
  const state = useAsync(async () => (await api.getMission(id ?? '')).mission, [id]);
  const [view, setView] = useState<'facts' | 'intel'>('facts');

  if (!id) return <ErrorState error="缺少项目 ID。" />;
  if (state.loading) return <div className="mx-auto w-full max-w-[1500px] space-y-4"><Skeleton className="h-28 w-full" /><Skeleton className="h-96 w-full" /></div>;
  if (state.error || !state.data) return <ErrorState error={state.error ?? '项目不存在。'} retry={state.refresh} />;

  return (
    <div className="mx-auto w-full max-w-[1500px]">
      <MissionViewHeader
        mission={state.data}
        active="blackboard"
        index={`01 / 项目 / 黑板 / ${state.data.id.slice(0, 6)}`}
        title={<>黑板</>}
        description=""
        actions={<Button variant="outline" icon={<RefreshCw className="size-3.5" aria-hidden="true" />} onClick={state.refresh}>刷新项目</Button>}
      />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button type="button" className={cn('chip', view === 'facts' && 'chip-active')} aria-pressed={view === 'facts'} onClick={() => setView('facts')}>黑板事实</button>
        <button type="button" className={cn('chip', view === 'intel' && 'chip-active')} aria-pressed={view === 'intel'} onClick={() => setView('intel')}>任务情报</button>
        <span className="mono ml-auto text-[10px] text-faint">同一页面 · 切换查看</span>
      </div>
      {view === 'facts' ? <BlackboardPanel missionId={state.data.id} /> : <MissionIntelPanel missionId={state.data.id} />}
    </div>
  );
}
