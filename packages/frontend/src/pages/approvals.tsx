import { ArrowUpRight, Check, CircleAlert, Loader2, Plus, ShieldCheck, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader } from '../components/shell';
import { useToast } from '../components/toast';
import { Pager } from '../components/pager';
import { ApprovalStatusBadge } from '../components/status-badge';
import { Button, EmptyState, ErrorState, Field, Input, Modal, Panel, Skeleton, Textarea } from '../components/ui';
import { SpringSelect } from '../components/spring-select';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { canAdmin, canOperate } from '../lib/permissions';
import { approvalTypeLabel, formatDate, formatShortDate } from '../lib/format';
import { useAsync } from '../lib/hooks';
import type { Approval } from '../lib/types';
import { cn } from '../lib/utils';

const PAGE_SIZE = 10;

export function Approvals() {
  const toast = useToast();
  const { user } = useAuth();
  const writable = canOperate(user);
  const admin = canAdmin(user);
  const approvals = useAsync(() => api.listApprovals(), []);
  const [filter, setFilter] = useState<'pending' | 'all'>('pending');
  const [page, setPage] = useState(1);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createMission, setCreateMission] = useState('');
  const [createType, setCreateType] = useState('manual');
  const [createPayload, setCreatePayload] = useState('{\n  "note": "manual approval request"\n}');
  const [createPending, setCreatePending] = useState(false);

  const rows = useMemo(() => {
    const list = approvals.data?.approvals ?? [];
    return filter === 'pending' ? list.filter(approval => approval.status === 'pending') : list;
  }, [approvals.data, filter]);

  useEffect(() => setPage(1), [filter]);

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pagedRows = rows.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const pendingCount = (approvals.data?.approvals ?? []).filter(approval => approval.status === 'pending').length;

  async function decide(approval: Approval, action: 'approved' | 'rejected'): Promise<void> {
    setDecidingId(approval.id);
    try {
      await api.decideApproval(approval.id, { decision: action });
      toast('success', action === 'approved' ? '已批准，决策已写入审计。' : '已拒绝，决策已写入审计。');
      approvals.refresh();
    } catch (cause) {
      toast('error', cause instanceof Error ? cause.message : String(cause));
      approvals.refresh();
    } finally {
      setDecidingId(null);
    }
  }

  async function create(): Promise<void> {
    if (!createMission.trim()) {
      toast('error', '请填写 mission id。');
      return;
    }
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(createPayload) as Record<string, unknown>;
    } catch {
      toast('error', 'payload 必须是合法 JSON。');
      return;
    }
    setCreatePending(true);
    try {
      await api.createApproval({ missionId: createMission.trim(), type: createType, payload });
      toast('success', '审批请求已创建。');
      setCreateOpen(false);
      setCreateMission('');
      approvals.refresh();
    } catch (cause) {
      toast('error', cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCreatePending(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-[1500px]">
      <PageHeader
        index="03 / APPROVALS"
        title={<>审批中心</>}
        actions={
          <>
            <div className="flex items-center gap-1.5">
              {(['pending', 'all'] as const).map(value => (
                <button key={value} type="button" className={cn('chip', filter === value && 'chip-active')} aria-pressed={filter === value} onClick={() => setFilter(value)}>
                  {value === 'pending' ? `待审批 ${pendingCount}` : '全部'}
                </button>
              ))}
            </div>
            {writable ? <Button variant="outline" icon={<Plus className="size-3.5" aria-hidden="true" />} onClick={() => setCreateOpen(true)}>发起审批请求</Button> : null}
          </>
        }
        aside={
          <div className="text-right">
            <p className={cn('display text-[clamp(2.6rem,5vw,4.6rem)]', pendingCount > 0 ? 'text-amber-300' : 'text-paper')}>{pendingCount}</p>
            <p className="micro mt-1">awaiting decision</p>
          </div>
        }
      />

      {approvals.loading ? (
        <div className="space-y-2" aria-busy="true">{Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} className="h-24 w-full" />)}</div>
      ) : approvals.error ? (
        <ErrorState error={approvals.error} retry={approvals.refresh} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={filter === 'pending' ? <CircleAlert className="size-7" aria-hidden="true" /> : <ShieldCheck className="size-7" aria-hidden="true" />}
          title={filter === 'pending' ? '没有待审批请求' : '暂无审批记录'}
          hint={filter === 'pending' ? '当 Worker 请求高风险操作时，审批会出现在这里。' : '审批创建后可在此查看决策历史。'}
        />
      ) : (
        <ul className="space-y-2" role="list">
          {pagedRows.map(approval => (
            <li key={approval.id}>
              <Panel className="grid gap-4 p-5 lg:grid-cols-[1fr_auto] lg:items-center">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-paper">{approval.missionName ?? approval.missionId}</span>
                    <ApprovalStatusBadge status={approval.status} />
                    <span className="chip cursor-default">{approvalTypeLabel(approval.type)}</span>
                    <span className="mono text-[10px] text-faint">{approval.id.slice(0, 8)}</span>
                  </div>
                  <ApprovalPayload approval={approval} />
                  <p className="mt-2 flex flex-wrap gap-3 text-[10px] text-faint">
                    <span>创建 {formatShortDate(approval.createdAt)}</span>
                    <span>决策人 {approval.decidedBy ?? '—'}</span>
                    <span>决策时间 {formatDate(approval.decidedAt)}</span>
                  </p>
                </div>
                {approval.status === 'pending' && writable && (approval.type !== 'scope_upgrade' || admin) ? (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="primary"
                      disabled={decidingId !== null}
                      icon={decidingId === approval.id ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : <Check className="size-3.5" aria-hidden="true" />}
                      onClick={() => void decide(approval, 'approved')}
                    >
                      批准
                    </Button>
                    <Button
                      variant="danger"
                      disabled={decidingId !== null}
                      icon={<X className="size-3.5" aria-hidden="true" />}
                      onClick={() => void decide(approval, 'rejected')}
                    >
                      拒绝
                    </Button>
                  </div>
                ) : approval.status !== 'pending' ? (
                  <span className="text-[10px] uppercase tracking-[0.12em] text-faint">已决策</span>
                ) : (
                  <span className="text-[10px] uppercase tracking-[0.12em] text-faint">{approval.type === 'scope_upgrade' ? '待管理员审批' : '只读'}</span>
                )}
              </Panel>
            </li>
          ))}
        </ul>
      )}
      {rows.length > 0 ? (
        <Pager
          page={currentPage}
          totalPages={totalPages}
          pageSize={PAGE_SIZE}
          totalItems={rows.length}
          onPageChange={setPage}
          note="接口最多返回 100 条"
          className="mt-5"
        />
      ) : null}

      <Modal
        open={createOpen}
        onOpenChange={open => { if (!open && !createPending) setCreateOpen(false); }}
        title="发起审批请求"
        description="用于人工发起 scope 升级或其它高风险动作的审批。审批只记录决策，不会自动修改 Grant。"
        footer={
          <>
            <Button variant="ghost" disabled={createPending} onClick={() => setCreateOpen(false)}>取消</Button>
            <Button variant="primary" disabled={createPending} onClick={() => void create()}>{createPending ? '创建中…' : '创建请求'}</Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Mission ID">
            <Input value={createMission} onChange={event => setCreateMission(event.target.value)} placeholder="UUID" />
          </Field>
          <Field label="审批类型">
            <SpringSelect
              value={createType}
              onChange={setCreateType}
              ariaLabel="审批类型"
              fullWidth
              size="field"
              options={[{ value: 'manual', label: '人工审批 (manual)' }, ...(admin ? [{ value: 'scope_upgrade', label: '授权范围升级 (scope_upgrade)' }] : [])]}
            />
          </Field>
          <Field label="Payload (JSON)">
            <Textarea value={createPayload} onChange={event => setCreatePayload(event.target.value)} rows={6} className="mono text-xs" />
          </Field>
        </div>
      </Modal>
    </div>
  );
}

function ApprovalPayload({ approval }: { approval: Approval }) {
  const payload = approval.payload ?? {};
  const raw = (
    <details className="mt-2">
      <summary className="cursor-pointer text-[10px] uppercase tracking-[0.12em] text-faint hover:text-muted">原始 payload</summary>
      <pre className="code-block mt-2 max-h-48">{JSON.stringify(payload, null, 2)}</pre>
    </details>
  );

  if (approval.type === 'scope_upgrade') {
    const extras = payload.scopeExtras;
    const reason = typeof payload.reason === 'string' ? payload.reason : null;
    const applied = typeof payload.appliedGrantVersion === 'number' ? payload.appliedGrantVersion : null;
    return (
      <div className="mt-2 border-l-2 border-lime/40 bg-lime/5 px-3 py-2">
        <p className="text-[11px] leading-relaxed text-paper">
          授权范围升级 · 批准后生成新 Grant 版本并重绑开放任务
        </p>
        {reason ? <p className="mt-1 text-[11px] text-muted">原因：{reason}</p> : null}
        {applied ? <p className="mt-1 text-[11px] text-lime">已应用 Grant v{applied}</p> : null}
        <div className="mono mt-1.5 line-clamp-2 break-all text-[10px] text-faint">{typeof extras === 'object' ? JSON.stringify(extras) : '—'}</div>
        <div className="mt-2 flex flex-wrap gap-3 text-[10px]">
          <PillLink to={`/missions/${approval.missionId}`}>打开项目</PillLink>
          <span className="text-faint">mission {approval.missionId.slice(0, 8)}</span>
        </div>
        {raw}
      </div>
    );
  }

  if (approval.type === 'command_review') {
    const command = typeof payload.command === 'string' ? payload.command : null;
    const reason = typeof payload.reason === 'string' ? payload.reason : null;
    const taskId = typeof payload.taskId === 'string' ? payload.taskId : null;
    const commandHash = typeof payload.commandHash === 'string' ? payload.commandHash : null;
    return (
      <div className="mt-2 border-l-2 border-amber-300/50 bg-amber-300/5 px-3 py-2">
        <p className="text-[11px] leading-relaxed text-paper">命令复核 · 仅当命令门控模型无法判断时请求人工</p>
        {command ? <pre className="mono mt-2 max-h-32 overflow-auto border border-line bg-ink-2 px-2 py-1.5 text-[10px] text-paper">{command}</pre> : null}
        {reason ? <p className="mt-1 text-[11px] text-muted">模型原因：{reason}</p> : null}
        {commandHash ? <p className="mono mt-1 break-all text-[10px] text-faint">命令哈希：{commandHash}</p> : null}
        <div className="mt-2 flex flex-wrap gap-3 text-[10px]">
          {taskId ? <PillLink to={`/missions/${approval.missionId}/dag?task=${taskId}`}>打开项目</PillLink> : null}
          <PillLink to={`/missions/${approval.missionId}`}>打开项目</PillLink>
        </div>
        {raw}
      </div>
    );
  }

  if (approval.type === 'stalled_task') {
    const taskId = typeof payload.taskId === 'string' ? payload.taskId : null;
    const rule = typeof payload.rule === 'string' ? payload.rule : null;
    const streak = typeof payload.streak === 'number' ? payload.streak : null;
    const detail = typeof payload.detail === 'string' ? payload.detail : null;
    const resolution = typeof payload.resolution === 'string' ? payload.resolution : null;
    return (
      <div className="mt-2 border-l-2 border-ember/50 bg-ember/5 px-3 py-2">
        <p className="text-[11px] leading-relaxed text-paper">
          停滞任务复核 · 批准=取消该任务，拒绝=清空停滞计数并让它继续
        </p>
        <p className="mt-1 flex flex-wrap gap-2 text-[10px] text-muted">
          {rule ? <span className="mono">规则 {rule}</span> : null}
          {streak !== null ? <span className="mono">连续 {streak} 次</span> : null}
          {taskId ? <span className="mono">task {taskId.slice(0, 8)}</span> : null}
        </p>
        {detail ? <p className="mt-1 text-[11px] text-muted">{detail}</p> : null}
        {resolution === 'planner_cancelled' ? (
          <p className="mt-1 text-[11px] text-faint">已由 Planner 自动取消任务（planner:auto），无需人工处理。</p>
        ) : null}
        <div className="mt-2 flex flex-wrap gap-3 text-[10px]">
          {taskId ? <PillLink to={`/missions/${approval.missionId}/dag?task=${taskId}`}>打开任务</PillLink> : null}
          <PillLink to={`/missions/${approval.missionId}`}>打开项目</PillLink>
        </div>
        {raw}
      </div>
    );
  }

  if (approval.type === 'finding_review') {
    const findingId = typeof payload.findingId === 'string' ? payload.findingId : null;
    const title = typeof payload.title === 'string' ? payload.title : typeof payload.findingTitle === 'string' ? payload.findingTitle : null;
    const reason = typeof payload.reason === 'string' ? payload.reason : null;
    return (
      <div className="mt-2 border-l-2 border-amber-300/40 bg-amber-300/5 px-3 py-2">
        <p className="text-[11px] leading-relaxed text-paper">发现复核 · 决定 accepted / rejected 后回写 finding 状态</p>
        {title ? <p className="mt-1 text-[11px] text-muted">{title}</p> : null}
        {reason ? <p className="mt-1 text-[11px] text-muted">Curator：{reason}</p> : null}
        <div className="mt-2 flex flex-wrap gap-3 text-[10px]">
          {findingId ? <PillLink to={`/findings/${findingId}`}>打开发现</PillLink> : null}
          <PillLink to={`/missions/${approval.missionId}`}>打开项目</PillLink>
        </div>
        {raw}
      </div>
    );
  }

  const note = typeof payload.note === 'string' ? payload.note : null;
  return (
    <div className="mt-2">
      <p className="text-[11px] leading-relaxed text-muted">{note ?? '（无 payload 摘要）'}</p>
      {Object.keys(payload).length > 0 ? raw : null}
    </div>
  );
}

function PillLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link
      to={to}
      className="inline-flex items-center gap-1 rounded border border-lime/30 bg-lime/10 px-2 py-1 text-[10px] uppercase tracking-[0.1em] text-lime transition-colors hover:border-lime hover:bg-lime hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lime"
    >
      <ArrowUpRight className="size-3" aria-hidden="true" />
      {children}
    </Link>
  );
}
