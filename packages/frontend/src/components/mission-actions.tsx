import { Pause, Play } from 'lucide-react';
import { useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { canOperate } from '../lib/permissions';
import type { MissionDetail } from '../lib/types';
import { useToast } from './toast';
import { Button, Modal } from './ui';

export function MissionActions({ mission, onDone }: { mission: MissionDetail; onDone: () => void }) {
  const toast = useToast();
  const { user } = useAuth();
  const [pending, setPending] = useState<'pause' | 'resume' | null>(null);
  const [confirm, setConfirm] = useState<'pause' | 'resume' | null>(null);
  if (!canOperate(user)) return null;
  const canPause = ['pending', 'running', 'active'].includes(mission.state);
  const canResume = mission.state === 'paused';

  async function run(action: 'pause' | 'resume'): Promise<void> {
    setPending(action);
    try {
      if (action === 'pause') await api.pauseMission(mission.id);
      else await api.resumeMission(mission.id);
      toast('success', action === 'pause' ? '任务已暂停，checkpoint 已保存。' : '任务已恢复，从 checkpoint 继续调度。');
      setConfirm(null);
      onDone();
    } catch (cause) {
      toast('error', cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(null);
    }
  }

  return (
    <>
      <Button
        variant="outline"
        icon={<Pause className="size-3.5" aria-hidden="true" />}
        disabled={!canPause || pending !== null}
        onClick={() => setConfirm('pause')}
      >
        {pending === 'pause' ? '暂停中' : '暂停'}
      </Button>
      <Button
        variant="primary"
        icon={<Play className="size-3.5" aria-hidden="true" />}
        disabled={!canResume || pending !== null}
        onClick={() => setConfirm('resume')}
      >
        {pending === 'resume' ? '恢复中' : '恢复'}
      </Button>

      <Modal
        open={confirm !== null}
        onOpenChange={open => { if (!open) setConfirm(null); }}
        title={confirm === 'pause' ? '暂停任务？' : '恢复任务？'}
        description={
          confirm === 'pause'
            ? '暂停后不再产生新的领取与调度提升，checkpoint、任务、事件、待办与授权都会保留。正在运行的任务会继续到本轮报告返回。'
            : '恢复后调度器会从同一 checkpoint 继续：未完成任务重新进入可领取状态，暂停期间已完成的报告不会改变任务终态。'
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>取消</Button>
            <Button
              variant={confirm === 'pause' ? 'danger' : 'primary'}
              disabled={pending !== null}
              onClick={() => { if (confirm) void run(confirm); }}
            >
              {pending ? '处理中…' : confirm === 'pause' ? '确认暂停' : '确认恢复'}
            </Button>
          </>
        }
      />
    </>
  );
}
