import { ArrowUpRight, ShieldPlus } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { canAdmin } from '../lib/permissions';
import { useToast } from './toast';
import { Button, Field, Input, Panel, Textarea } from './ui';

// Requests a scope_upgrade approval. Nothing is authorized here: a human must
// approve in the approval center, after which the server creates a new grant
// version and rebinds open tasks.
function parseList(value: string): string[] | undefined {
  const items = value.split(/[\n,]+/).map(item => item.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

export function ScopeUpgradeForm({ missionId, onRequested }: { missionId: string; onRequested: () => void }) {
  const toast = useToast();
  const { user } = useAuth();
  const [url, setUrl] = useState('');
  const [reason, setReason] = useState('');
  const [domains, setDomains] = useState('');
  const [ips, setIps] = useState('');
  const [prefixes, setPrefixes] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [pending, setPending] = useState(false);
  const [approvalId, setApprovalId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!canAdmin(user)) return null;

  async function submit(): Promise<void> {
    setError(null);
    const input = {
      url: url.trim() || undefined,
      reason: reason.trim() || undefined,
      domainSuffixes: parseList(domains),
      ips: parseList(ips),
      urlPrefixes: parseList(prefixes),
    };
    if (!input.url && !input.domainSuffixes && !input.ips && !input.urlPrefixes) {
      setError('URL 或 scope 扩展项至少提供一项。');
      return;
    }
    setPending(true);
    try {
      const result = await api.requestScopeUpgrade(missionId, input);
      setApprovalId(result.approvalId);
      setUrl('');
      setReason('');
      setDomains('');
      setIps('');
      setPrefixes('');
      toast('success', '授权升级请求已创建，等待审批；批准后 Grant 版本才会变化。');
      onRequested();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      toast('error', message);
    } finally {
      setPending(false);
    }
  }

  return (
    <Panel className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="micro flex items-center gap-2"><ShieldPlus className="size-3.5 text-lime" aria-hidden="true" />授权升级</p>
          <p className="mt-2 max-w-2xl text-xs leading-relaxed text-muted">
            申请扩展当前 mission 的授权范围。只会创建 <span className="mono text-paper">scope_upgrade</span> 审批，
            <span className="text-paper">不会立即放行</span>；批准后服务端生成新 Grant 版本并重绑开放任务。
          </p>
        </div>
        <button type="button" className="chip" onClick={() => setExpanded(value => !value)} aria-expanded={expanded}>
          {expanded ? '收起扩展项' : '扩展项'}
        </button>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field label="目标 URL（可选）" hint="从 URL 推导 domain/ip/urlPrefix。">
          <Input value={url} onChange={event => setUrl(event.target.value)} placeholder="http://other-host:8080" />
        </Field>
        <Field label="原因（可选）" hint="写入审批 payload，便于复核。">
          <Input value={reason} onChange={event => setReason(event.target.value)} placeholder="越权拦截后申请扩大 scope" />
        </Field>
      </div>

      {expanded ? (
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <Field label="域后缀"><Textarea value={domains} onChange={event => setDomains(event.target.value)} rows={2} placeholder="example.com" /></Field>
          <Field label="IP"><Textarea value={ips} onChange={event => setIps(event.target.value)} rows={2} placeholder="192.168.1.10" /></Field>
          <Field label="URL 前缀"><Textarea value={prefixes} onChange={event => setPrefixes(event.target.value)} rows={2} placeholder="http://192.168.1.10/" /></Field>
        </div>
      ) : null}

      {error ? <p className="mt-3 border border-ember/30 bg-ember/5 px-3 py-2 text-xs text-ember">{error}</p> : null}

      {approvalId ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border border-lime/30 bg-lime/5 px-3 py-2.5">
          <p className="text-xs text-paper">升级审批已创建 <span className="mono text-faint">{approvalId.slice(0, 8)}</span></p>
          <Link to="/approvals" className="inline-flex items-center gap-1 text-xs text-lime hover:underline">
            前往审批中心 <ArrowUpRight className="size-3" aria-hidden="true" />
          </Link>
        </div>
      ) : null}

      <div className="mt-4 flex justify-end">
        <Button variant="primary" disabled={pending} onClick={() => void submit()}>
          {pending ? '提交中…' : '申请授权升级'}
        </Button>
      </div>
    </Panel>
  );
}
