import { AlertTriangle } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Modal } from './ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';

// Admin-only hard delete. A single confirm/cancel modal is the only decision
// surface; the backend still receives the exact project name as confirmation.
export function AdminMissionDelete({ missionId, missionName }: { missionId: string; missionName: string }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (user?.role !== 'admin') return null;

  const remove = async (): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      await api.deleteMission(missionId, missionName);
      setOpen(false);
      navigate('/missions', { replace: true });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button variant="danger" onClick={() => setOpen(true)} disabled={busy}>删除项目</Button>
      <Modal
        open={open}
        onOpenChange={next => { if (!next && !busy) { setOpen(false); setError(''); } }}
        title={`确认删除项目「${missionName}」？`}
        description="此操作不可撤销，会永久删除该项目关联的任务、证据、发现、轨迹、审批与授权数据。"
        footer={
          <>
            <Button variant="ghost" disabled={busy} onClick={() => setOpen(false)}>取消</Button>
            <Button variant="danger" disabled={busy} onClick={() => void remove()}>{busy ? '删除中…' : '确认删除'}</Button>
          </>
        }
      >
        <div className="flex items-start gap-2 border border-ember/30 bg-ember/5 px-3 py-2.5 text-xs leading-relaxed text-ember">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <p>项目数据会从控制面硬删除；运行中的执行器可能继续到当前结束，迟到报告会被 fencing 丢弃。</p>
        </div>
        {error ? <p className="mt-3 text-xs text-red-400">{error}</p> : null}
      </Modal>
    </>
  );
}
