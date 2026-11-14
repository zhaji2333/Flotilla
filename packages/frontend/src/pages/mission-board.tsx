import { useParams } from 'react-router-dom';
import { BoardPanel } from '../components/board-panel';
import { MissionViewHeader } from '../components/mission-views';
import { ErrorState, Skeleton } from '../components/ui';
import { api } from '../lib/api';
import { useAsync } from '../lib/hooks';

export function MissionBoard() {
  const { id } = useParams<{ id: string }>();
  const state = useAsync(async () => (await api.getMission(id ?? '')).mission, [id]);

  if (!id) return <ErrorState error="缺少项目 ID。" />;
  if (state.loading) return <div className="mx-auto w-full max-w-[1500px] space-y-4"><Skeleton className="h-28 w-full" /><Skeleton className="h-96 w-full" /></div>;
  if (state.error || !state.data) return <ErrorState error={state.error ?? '项目不存在。'} retry={state.refresh} />;

  return (
    <div className="mx-auto w-full max-w-[1500px]">
      <MissionViewHeader
        mission={state.data}
        active="board"
        index={`01 / 项目 / 线索板 / ${state.data.id.slice(0, 6)}`}
        title={<>线索板</>}
        description=""
      />
      <BoardPanel missionId={state.data.id} />
    </div>
  );
}
