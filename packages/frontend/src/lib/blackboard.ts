import type { FactSource, FactTrust, MissionFact } from './types';

export const FACT_KIND_LABELS: Record<string, string> = {
  credential: '凭据',
  vuln: '漏洞',
  artifact: '目标产物',
  host: '主机',
  technology: '技术栈',
  endpoint: '端点',
  parameter: '参数',
  identity: '身份/账号',
  file: '文件',
  flag: 'Flag 标记',
};

export function factKindLabel(kind: string): string {
  return FACT_KIND_LABELS[kind] ?? kind;
}

export function factTrustLabel(trust: FactTrust | string): string {
  return trust === 'observed' ? '已观测 (observed)' : '推断 (inferred)';
}

export function factSourceLabel(source: FactSource | string): string {
  const labels: Record<string, string> = {
    asset: '资产来源',
    finding: '发现来源',
    finding_artifact: '发现产物来源',
    evidence: '证据来源',
  };
  return labels[source] ?? source;
}

/** 术语表：worker_asset / accepted_finding / proxy_evidence */
export function factProvenanceLabel(provenance: string): string {
  const labels: Record<string, string> = {
    worker_asset: 'Worker 资产',
    accepted_finding: '已接受发现',
    proxy_evidence: '代理证据',
  };
  return labels[provenance] ?? provenance;
}

/** Mask plaintext credentials for display: "admin:secret" -> "admin:••••••". */
export function maskSensitiveValue(value: string): string {
  if (!value) return '••••••';
  const colon = value.indexOf(':');
  if (colon >= 0 && colon <= 24) {
    return `${value.slice(0, colon + 1)}${'•'.repeat(6)}`;
  }
  return `${value.slice(0, 2)}${'•'.repeat(10)}`;
}

export function factDisplayValue(fact: Pick<MissionFact, 'sensitive' | 'value'>, revealed: boolean): string {
  if (!fact.sensitive || revealed) return fact.value;
  return maskSensitiveValue(fact.value);
}

export function groupFactsByKind(facts: MissionFact[]): Array<{ kind: string; label: string; items: MissionFact[] }> {
  const groups = new Map<string, MissionFact[]>();
  for (const fact of facts) {
    const list = groups.get(fact.kind);
    if (list) list.push(fact);
    else groups.set(fact.kind, [fact]);
  }
  const priority = ['credential', 'vuln', 'host', 'endpoint', 'technology', 'parameter', 'identity', 'artifact', 'file'];
  return [...groups.entries()]
    .map(([kind, items]) => ({ kind, label: factKindLabel(kind), items }))
    .toSorted((left, right) => {
      const a = priority.indexOf(left.kind);
      const b = priority.indexOf(right.kind);
      return (a === -1 ? 99 : a) - (b === -1 ? 99 : b);
    });
}
