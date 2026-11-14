import { ArrowUpRight, Filter, Network, RefreshCw, ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { GraphCanvas } from '../components/graph-canvas';
import { MissionViewHeader } from '../components/mission-views';
import { Badge, Button, EmptyState, ErrorState, Input, Panel, SectionLabel, Skeleton } from '../components/ui';
import { api } from '../lib/api';
import { confidenceLabel, exploreEdgeLabel, taskAngleLabel, taskLabel } from '../lib/format';
import { factKindLabel } from '../lib/blackboard';
import { useAsync } from '../lib/hooks';
import { EXPLORE_CARD_H, EXPLORE_CARD_W, layoutExploreGraph, type PositionedExploreNode } from '../lib/explore';
import { maskSensitiveValue } from '../lib/blackboard';
import { taskStateColor } from '../lib/dag';
import type { ExploreEdgeType, ExploreGraph, ExploreGroup, ExploreNode } from '../lib/types';
import { cn } from '../lib/utils';

const EDGE_COLORS: Record<ExploreEdgeType, string> = {
  contains: '#3a4352',
  produced: '#5aa9ff',
  observes: '#8b8f98',
  evidence_of: '#a78bfa',
};

const FACT_COLORS: Record<string, string> = {
  credential: '#ff5a2b',
  vuln: '#a78bfa',
  artifact: '#5aa9ff',
  host: '#38bdf8',
  endpoint: '#7dd3fc',
  technology: '#6ee7a8',
  parameter: '#fbbf24',
  identity: '#f472b6',
  file: '#8b8f98',
};

export function MissionExplore() {
  const { id } = useParams<{ id: string }>();
  const missionState = useAsync(async () => (await api.getMission(id ?? '')).mission, [id]);
  const [searchParams, setSearchParams] = useSearchParams();
  const urlThreshold = Number(searchParams.get('threshold'));
  const initialThreshold = Number.isInteger(urlThreshold) && urlThreshold >= 10 && urlThreshold <= 500 ? urlThreshold : 150;
  const [threshold, setThreshold] = useState(initialThreshold);
  const [thresholdInput, setThresholdInput] = useState(String(initialThreshold));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const graphState = useAsync(async () => (await api.getMissionExploreGraph(id ?? '', { threshold })).graph, [id, threshold]);

  if (!id) return <ErrorState error="缺少项目 ID。" />;
  if (missionState.loading) return <div className="mx-auto w-full max-w-[1500px] space-y-4"><Skeleton className="h-28 w-full" /><Skeleton className="h-96 w-full" /></div>;
  if (missionState.error || !missionState.data) return <ErrorState error={missionState.error ?? '项目不存在。'} retry={missionState.refresh} />;

  function applyThreshold(): void {
    const value = Number(thresholdInput);
    if (!Number.isInteger(value) || value < 10 || value > 500) {
      setThresholdInput(String(threshold));
      return;
    }
    setThresholdValue(value);
  }

  function setThresholdValue(value: number): void {
    setThreshold(value);
    setThresholdInput(String(value));
    const next = new URLSearchParams(searchParams);
    next.set('threshold', String(value));
    setSearchParams(next, { replace: true });
    setSelectedId(null);
  }

  return (
    <div className="mx-auto w-full max-w-[1500px]">
      <MissionViewHeader
        mission={missionState.data}
        active="explore"
        title={<>探索图</>}
        index={`01 / 项目 / 探索图 / ${missionState.data.id.slice(0, 6)}`}
        description=""
        actions={<Button variant="outline" icon={<RefreshCw className="size-3.5" aria-hidden="true" />} onClick={() => { missionState.refresh(); graphState.refresh(); }}>刷新</Button>}
      />

      <Panel className="mb-4 flex flex-wrap items-end gap-3 p-4">
        <div className="min-w-[150px] flex-1">
          <label className="micro mb-1 block" htmlFor="explore-threshold">折叠阈值（10–500）</label>
          <Input id="explore-threshold" type="number" min={10} max={500} value={thresholdInput} onChange={event => setThresholdInput(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') applyThreshold(); }} />
        </div>
        <Button variant="primary" onClick={applyThreshold}>应用阈值</Button>
        <div className="flex flex-wrap items-center gap-1.5">
          <Filter className="size-3 text-faint" aria-hidden="true" />
          {[10, 50, 150, 300, 500].map(value => (
            <button key={value} type="button" className={cn('chip', threshold === value && 'chip-active')} aria-pressed={threshold === value} onClick={() => setThresholdValue(value)}>{value}</button>
          ))}
        </div>
        <span className="mono ml-auto text-[10px] text-faint">服务端折叠 · 前端不重算</span>
      </Panel>

      {graphState.loading ? <Skeleton className="h-[420px] w-full" /> : graphState.error || !graphState.data ? (
        <ErrorState error={graphState.error ?? '探索图不可用。'} retry={graphState.refresh} />
      ) : (
        <ExploreCanvas graph={graphState.data} selectedId={selectedId} onSelect={setSelectedId} />
      )}
    </div>
  );
}

function ExploreCanvas({ graph, selectedId, onSelect }: { graph: ExploreGraph; selectedId: string | null; onSelect: (id: string | null) => void }) {
  const layout = layoutExploreGraph(graph);
  const selected = layout.nodes.find(item => item.node.id === selectedId) ?? null;
  const groups = graph.groups ?? [];
  const selectedGroup = selected ? groups.find(group => group.id === selected.node.id) ?? null : null;
  const selectedNode = selected?.node ?? null;

  if (graph.nodes.length === 0) {
    return <EmptyState icon={<Network className="size-7" aria-hidden="true" />} title="暂无图数据" hint="任务或黑板事实产生后，探索图会在这里展开。" />;
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 border border-line bg-panel px-4 py-3 sm:grid-cols-2 lg:grid-cols-5">
        <Meta label="事件版本" value={`#${graph.version}`} />
        <Meta label="节点" value={`${graph.nodes.length} / ${graph.original.nodes}`} />
        <Meta label="边" value={`${graph.edges.length} / ${graph.original.edges}`} />
        <Meta label="折叠阈值" value={String(graph.threshold)} />
        <Meta label="已折叠" value={graph.folded ? '是 (digest)' : '否'} tone={graph.folded ? 'ember' : 'lime'} />
      </div>

      {graph.folded ? (
        <div className="flex items-start gap-2 border border-amber-300/25 bg-amber-300/5 px-4 py-3 text-[11px] leading-relaxed text-amber-100/80">
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-amber-300" aria-hidden="true" />
          <p>节点数超过阈值，服务端已折叠为超节点 {groups.length} 个；边已重映射且数量守恒。点击超节点查看成员 ID，或调高阈值展开。</p>
        </div>
      ) : null}

      <GraphCanvas ariaLabel="任务探索图" height={560}>
        <svg
          width={layout.width}
          height={layout.height}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          role="group"
          aria-label="任务探索图"
          className="min-w-full"
        >
          {layout.edges.map(edge => (
            <path
              key={edge.edge.id}
              d={edge.path}
              fill="none"
              stroke={EDGE_COLORS[edge.edge.type]}
              strokeWidth={edge.edge.type === 'contains' ? 1 : 1.4}
              strokeDasharray={edge.edge.type === 'observes' ? '5 5' : edge.edge.type === 'evidence_of' ? '2 4' : undefined}
              opacity={0.75}
            >
              <title>{exploreEdgeLabel(edge.edge.type)}</title>
            </path>
          ))}
          {layout.nodes.map(item => (
            <GraphNode
              key={item.node.id}
              item={item}
              graph={graph}
              selected={selectedId === item.node.id}
              onSelect={() => onSelect(selectedId === item.node.id ? null : item.node.id)}
            />
          ))}
        </svg>
      </GraphCanvas>

      <div className="grid gap-4 lg:grid-cols-[1fr_auto]">
        <Legend />
        <span className="mono text-[10px] text-faint">{graph.edges.length} 条边 · 生成时间 {new Date(graph.generatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</span>
      </div>

      {selected ? (
        <Panel className="p-5">
          <SectionLabel index={selectedGroup ? '超节点' : selectedNode ? nodeTypeLabel(selectedNode.type) : '节点'} right={<button type="button" onClick={() => onSelect(null)} className="text-[10px] text-faint hover:text-paper">关闭</button>}>
            {selectedGroup ? exploreGroupLabel(selectedGroup) : selectedNode?.label}
          </SectionLabel>
          {selectedGroup ? (
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="ember">超节点</Badge>
                <span className="mono text-[10px] text-faint">类型 {nodeTypeLabel(selectedGroup.type)} · 事实类型 {factKindLabel(selectedGroup.kind)} · {selectedGroup.memberIds.length} 个成员</span>
              </div>
              <p className="mt-3 text-[11px] text-muted">成员 ID（只读；按前缀跳转对应视图）：</p>
              <ul className="mt-2 grid gap-2 sm:grid-cols-2">
                {selectedGroup.memberIds.map(member => <li key={member}><MemberLink missionId={graph.missionId} id={member} /></li>)}
              </ul>
            </div>
          ) : selectedNode ? (
            <NodeDetail node={selectedNode} missionId={graph.missionId} />
          ) : null}
        </Panel>
      ) : (
        <p className="text-[11px] text-faint">点击节点 / 超节点查看详情；任务根节点固定，任务与事实节点由后端派生。</p>
      )}
    </div>
  );
}

function GraphNode({ item, graph, selected, onSelect }: { item: PositionedExploreNode; graph: ExploreGraph; selected: boolean; onSelect: () => void }) {
  const node = item.node;
  const group = (graph.groups ?? []).find(candidate => candidate.id === node.id) ?? null;
  const label = group ? exploreGroupLabel(group) : node.sensitive ? maskSensitiveValue(node.label) : node.label;
  const color = nodeColor(node);
  const meta = node.type === 'mission'
    ? '任务根节点'
    : node.type === 'task'
      ? `${taskLabel(node.state ?? '')}${node.angle ? ` · ${taskAngleLabel(node.angle)}` : ''}`
      : node.trust ? confidenceLabel(node.trust) : factKindLabel(node.kind);
  return (
    <g
      role="button"
      tabIndex={0}
      aria-label={`${label}，${nodeTypeLabel(node.type)}${node.state ? `，状态 ${taskLabel(node.state)}` : ''}`}
      aria-pressed={selected}
      transform={`translate(${item.x}, ${item.y})`}
      onClick={onSelect}
      onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(); } }}
      style={{ cursor: 'pointer' }}
    >
      <title>{`${label} · ${nodeTypeLabel(node.type)}${node.kind ? ` / ${factKindLabel(node.kind)}` : ''}`}</title>
      <rect width={EXPLORE_CARD_W} height={EXPLORE_CARD_H} rx={4} fill={selected ? '#12161d' : '#0b0e13'} stroke={selected ? color : '#252c37'} strokeWidth={selected ? 1.6 : 1} />
      <rect width={3} height={EXPLORE_CARD_H} fill={color} />
      <text x={12} y={18} fill="#f2efe6" fontSize={9} fontFamily="inherit" letterSpacing="0.08em">
        {truncateText(group ? '超节点' : node.type === 'fact' ? `事实 · ${factKindLabel(node.kind)}` : node.type === 'task' ? '任务节点' : '任务根节点', 24)}
      </text>
      <text x={12} y={34} fill="#cdd0d7" fontSize={11} fontFamily="inherit">
        {truncateText(label, 21)}
      </text>
      <text x={12} y={47} fill="#8b8f98" fontSize={9} fontFamily="inherit" letterSpacing="0.06em">
        {group ? `${group.memberIds.length} 个成员 · 超节点` : truncateText(meta, 28)}
      </text>
    </g>
  );
}

function NodeDetail({ node, missionId }: { node: ExploreNode; missionId: string }) {
  const label = node.sensitive ? maskSensitiveValue(node.label) : node.label;
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={node.type === 'mission' ? 'lime' : node.type === 'task' ? 'sky' : 'muted'}>{nodeTypeLabel(node.type)}</Badge>
        {node.kind ? <Badge tone="muted">{factKindLabel(node.kind)}</Badge> : null}
        {node.state ? <Badge tone="violet">{taskLabel(node.state)}</Badge> : null}
        {node.angle ? <Badge tone="ember">{taskAngleLabel(node.angle)}</Badge> : null}
        {node.trust ? <span className="text-[9px] uppercase tracking-[0.1em] text-faint">可信度 {confidenceLabel(node.trust)}</span> : null}
        {node.sensitive ? <ShieldAlert className="size-3 text-ember" aria-hidden="true" /> : null}
      </div>
      <p className="mt-3 text-sm text-paper">{label}</p>
      <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
        <NodeLink missionId={missionId} id={node.id} />
      </div>
    </div>
  );
}

function MemberLink({ missionId, id }: { missionId: string; id: string }) {
  return <NodeLink missionId={missionId} id={id} />;
}

function NodeLink({ missionId, id }: { missionId: string; id: string }) {
  if (id.startsWith('task:')) {
    const taskId = id.slice('task:'.length);
    return <Link to={`/missions/${missionId}/dag?task=${taskId}`} className="inline-flex items-center gap-1 text-lime hover:underline">打开依赖图 <ArrowUpRight className="size-3" aria-hidden="true" /></Link>;
  }
  if (id.startsWith('fact:')) {
    return <Link to={`/missions/${missionId}/blackboard`} className="inline-flex items-center gap-1 text-lime hover:underline">打开黑板 <ArrowUpRight className="size-3" aria-hidden="true" /></Link>;
  }
  if (id.startsWith('mission:')) {
    return <Link to={`/missions/${missionId}`} className="inline-flex items-center gap-1 text-lime hover:underline">打开项目概览 <ArrowUpRight className="size-3" aria-hidden="true" /></Link>;
  }
  return <span className="mono break-all text-[10px] text-faint">{id}</span>;
}

function Meta({ label, value, tone = 'default' }: { label: string; value: string; tone?: 'default' | 'ember' | 'lime' }) {
  return (
    <div>
      <p className="micro">{label}</p>
      <p className={cn('mono mt-1 text-sm', tone === 'ember' ? 'text-ember' : tone === 'lime' ? 'text-lime' : 'text-paper')}>{value}</p>
    </div>
  );
}

function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-3 text-[10px] uppercase tracking-[0.12em] text-faint">
      {Object.entries(EDGE_COLORS).map(([type, color]) => (
        <span key={type} className="inline-flex items-center gap-1.5">
          <span className="inline-block h-px w-5" style={{ background: color }} aria-hidden="true" />
          {exploreEdgeLabel(type)}
        </span>
      ))}
      <span className="inline-flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-lime" aria-hidden="true" />任务根</span>
      <span className="inline-flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-sky" aria-hidden="true" />任务</span>
      <span className="inline-flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-violet" aria-hidden="true" />事实</span>
    </div>
  );
}

function exploreGroupLabel(group: ExploreGroup): string {
  const prefix = group.type === 'task' ? '任务' : factKindLabel(group.kind);
  return `${prefix} × ${group.memberIds.length}`;
}

function nodeTypeLabel(type: ExploreNode['type']): string {
  if (type === 'mission') return '任务根 (mission)';
  if (type === 'task') return '任务 (task)';
  return '事实 (fact)';
}

function nodeColor(node: ExploreNode): string {
  if (node.type === 'mission') return '#d7ff3f';
  if (node.type === 'task') return taskStateColor(node.state ?? 'proposed');
  return FACT_COLORS[node.kind] ?? '#8b8f98';
}

function truncateText(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}

