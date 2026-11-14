import { Globe2, Lock, ShieldAlert, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import type { Evidence } from '../lib/types';
import { formatBytes, formatDate, shaShort } from '../lib/format';
import { cn } from '../lib/utils';
import { Badge, CopyButton, EmptyState, TabsList, TabsRoot, TabTrigger, TabContent } from './ui';

export function EvidenceViewer({ evidence }: { evidence: Evidence[] }) {
  const [active, setActive] = useState(evidence[0]?.id ?? '');
  const [tab, setTab] = useState('request');

  if (evidence.length === 0) {
    return <EmptyState icon={<ShieldAlert className="size-6" aria-hidden="true" />} title="暂无证据" hint="Curator 接受 finding 后，关联的 baseline/proof 流量会显示在这里。" />;
  }

  const current = evidence.find(item => item.id === active) ?? evidence[0]!;

  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-2">
        {evidence.map((item, index) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setActive(item.id)}
            className={cn(
              'inline-flex items-center gap-2 border px-2.5 py-1.5 text-[10px] uppercase tracking-[0.12em] transition-colors',
              item.id === current.id ? 'border-lime text-lime' : 'border-line text-muted hover:border-muted hover:text-paper',
            )}
          >
            {item.kind === 'internet' ? <Globe2 className="size-3" aria-hidden="true" /> : <Lock className="size-3" aria-hidden="true" />}
            {String(index + 1).padStart(2, '0')} · {item.method}
          </button>
        ))}
      </div>

      <div className="border border-line bg-panel">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={current.kind === 'internet' ? 'violet' : 'sky'}>{current.kind === 'internet' ? '互联网检索' : '目标流量'}</Badge>
            {current.untrusted ? (
              <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.12em] text-ember">
                <ShieldAlert className="size-3" aria-hidden="true" />不可信数据
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.12em] text-muted">
                <ShieldCheck className="size-3" aria-hidden="true" />已记录
              </span>
            )}
            <span className="mono text-[10px] text-faint">{formatDate(current.createdAt)}</span>
          </div>
          <CopyButton value={current.requestText || `${current.method} ${current.url}`} label="复制请求包" />
        </div>

        <div className="px-4 pt-3">
          <p className="mono break-all text-xs text-paper">{current.method} {current.url}</p>
          <div className="mt-2 flex flex-wrap gap-4 text-[10px] text-faint">
            <span className="mono">req {formatBytes(current.requestBytes)}</span>
            <span className="mono">res {formatBytes(current.responseBytes)}</span>
            <span className="mono">req sha {shaShort(current.requestSha256)}</span>
            <span className="mono">res sha {shaShort(current.responseSha256)}</span>
          </div>
        </div>

        <TabsRoot value={tab} onValueChange={setTab}>
          <div className="px-4 pt-4">
            <TabsList>
              <TabTrigger value="request">原始请求</TabTrigger>
              <TabTrigger value="response">原始响应</TabTrigger>
              <TabTrigger value="hashes">哈希与引用</TabTrigger>
            </TabsList>
            <TabContent value="request">
              <pre className="code-block" aria-label="原始请求包">{current.requestText || '(空请求)'}</pre>
            </TabContent>
            <TabContent value="response">
              <pre className="code-block" aria-label="原始响应包">{current.responseText || '(空响应)'}</pre>
            </TabContent>
            <TabContent value="hashes">
              <div className="space-y-2 pb-4">
                <HashRow label="request sha256" value={current.requestSha256} />
                <HashRow label="response sha256" value={current.responseSha256} />
                <HashRow label="traffic ref" value={current.trafficRef} />
                <HashRow label="evidence id" value={current.id} />
              </div>
            </TabContent>
          </div>
        </TabsRoot>
      </div>
    </div>
  );
}

function HashRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start gap-3 border-b border-line py-1.5">
      <span className="w-32 shrink-0 text-[10px] uppercase tracking-[0.12em] text-faint">{label}</span>
      <span className="mono break-all text-[11px] text-muted">{value || '—'}</span>
      <span className="ml-auto"><CopyButton value={value} label="" /></span>
    </div>
  );
}
