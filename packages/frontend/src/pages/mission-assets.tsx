import { ArrowUpRight, Boxes, ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { GraphCanvas } from '../components/graph-canvas';
import { MissionViewHeader } from '../components/mission-views';
import { Badge, EmptyState, ErrorState, Panel, SectionLabel, Skeleton } from '../components/ui';
import { api } from '../lib/api';
import { ASSET_NODE_H, ASSET_NODE_W, layoutAssetGraph } from '../lib/assets-graph';
import { factKindLabel, maskSensitiveValue } from '../lib/blackboard';
import { assetEdgeLabel, taskLabel } from '../lib/format';
import { useAsync } from '../lib/hooks';
import type { AssetEdgeType, MissionAssetGraph, MissionAssetNode, Task } from '../lib/types';
import { cn } from '../lib/utils';

const EDGE_COLORS: Record<AssetEdgeType, string> = {
  observed_by: '#5aa9ff',
  seen_in_evidence: '#8b8f98',
  produced: '#a78bfa',
};

const ASSET_COLORS: Record<string, string> = {
  host: '#38bdf8',
  endpoint: '#7dd3fc',
  credential: '#ff5a2b',
  identity: '#f472b6',
  flag: '#d7ff3f',
};

export function MissionAssets() {
  const { id } = useParams<{ id: string }>();
  const missionState = useAsync(async () => (await api.getMission(id ?? '')).mission, [id]);
  const graphState = useAsync(async () => (await api.getMissionAssetsGraph(id ?? '')).graph, [id]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  if (!id) return <ErrorState error="缺少项目 ID。" />;
  if (missionState.loading) return <div className="mx-auto w-full max-w-[1500px] space-y-4"><Skeleton className="h-28 w-full" /><Skeleton className="h-96 w-full" /></div>;
  if (missionState.error || !missionState.data) return <ErrorState error={missionState.error ?? '项目不存在。'} retry={missionState.refresh} />;

  const mission = missionState.data;

  return (
    <div className="mx-auto w-full max-w-[1500px]">
      <MissionViewHeader
        mission={mission}
        active="assets"
        index={`01 / 项目 / 资产图 / ${mission.id.slice(0, 6)}`}
        title={<>资产图</>}
        description=""
      />

      {graphState.loading ? <Skeleton className="h-[460px] w-full" /> : graphState.error || !graphState.data ? (
        <ErrorState error={graphState.error ?? '资产图不可用。'} retry={graphState.refresh} />
      ) : (
        <AssetCanvas graph={graphState.data} tasks={mission.tasks} missionId={mission.id} selectedId={selectedId} onSelect={setSelectedId} />
      )}
    </div>
  );
}

function AssetCanvas({ graph, tasks, missionId, selectedId, onSelect }: { graph: MissionAssetGraph; tasks: Task[]; missionId: string; selectedId: string | null; onSelect: (id: string | null) => void }) {
  const layout = layoutAssetGraph(graph);
  const selected = layout.nodes.find(item => item.node.id === selectedId)?.node ?? null;
  const taskById = new Map(tasks.map(task => [task.id, task]));

  if (graph.nodes.length === 0) {
    return (
      <div className="space-y-4">
        <Coverage graph={graph} />
        <EmptyState icon={<Boxes className="size-7" aria-hidden="true" />} title="暂无资产" hint="Worker 写入资产或证据后，项目内资产图会在这里展开。" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Coverage graph={graph} />
      <GraphCanvas ariaLabel="项目资产图" height={560}>
        <svg width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} role="group" aria-label="项目资产图" className="min-w-full">
          {layout.edges.map(item => (
            <path key={item.edge.id} d={item.path} fill="none" stroke={EDGE_COLORS[item.edge.type]} strokeWidth={1.3} strokeDasharray={item.edge.type === 'seen_in_evidence' ? '5 4' : undefined} opacity={0.7}>
              <title>{assetEdgeLabel(item.edge.type)}</title>
            </path>
          ))}
          {layout.nodes.map(item => (
            <AssetNode
              key={item.node.id}
              node={item.node}
              x={item.x}
              y={item.y}
              task={item.node.taskId ? taskById.get(item.node.taskId) ?? null : null}
              selected={selectedId === item.node.id}
              onSelect={() => onSelect(selectedId === item.node.id ? null : item.node.id)}
            />
          ))}
        </svg>
      </GraphCanvas>

      <div className="grid gap-4 lg:grid-cols-[1fr_auto]">
        <div className="flex flex-wrap items-center gap-3 text-[10px] uppercase tracking-[0.12em] text-faint">
          {Object.entries(EDGE_COLORS).map(([type, color]) => (
            <span key={type} className="inline-flex items-center gap-1.5"><span className="inline-block h-px w-5" style={{ background: color }} aria-hidden="true" />{assetEdgeLabel(type)}</span>
          ))}
          <span className="inline-flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-ember" aria-hidden="true" />未覆盖资产为虚线弱化</span>
        </div>
        <span className="mono text-[10px] text-faint">事件版本 {graph.version} · 生成时间 {new Date(graph.generatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</span>
      </div>

      {selected ? (
        <Panel className="p-5">
          <SectionLabel index="节点" right={<button type="button" onClick={() => onSelect(null)} className="text-[10px] text-faint hover:text-paper">关闭</button>}>
            {displayLabel(selected, taskById) ?? '—'}
          </SectionLabel>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={selected.type === 'asset' ? 'sky' : selected.type === 'task' ? 'lime' : selected.type === 'finding' ? 'violet' : 'muted'}>{nodeTypeLabel(selected.type)}</Badge>
            {selected.kind ? <Badge tone="muted">{selected.type === 'asset' ? factKindLabel(selected.kind) : selected.kind}</Badge> : null}
            {selected.type === 'asset' ? <Badge tone={selected.covered ? 'lime' : 'ember'}>{selected.covered ? '已覆盖' : '未测'}</Badge> : null}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
            <NodeLinks node={selected} missionId={missionId} />
          </div>
        </Panel>
      ) : (
        <p className="text-[11px] text-faint">点击节点查看详情与跳转；资产按 kind 着色，未覆盖资产弱化显示。</p>
      )}
    </div>
  );
}

function AssetNode({ node, x, y, task, selected, onSelect }: { node: MissionAssetNode; x: number; y: number; task: Task | null; selected: boolean; onSelect: () => void }) {
  const color = nodeColor(node);
  const label = displayLabel(node, new Map(task ? [[task.id, task]] : [])) ?? node.label;
  const covered = node.type !== 'asset' || node.covered !== false;
  return (
    <g
      role="button"
      tabIndex={0}
      aria-label={`${nodeTypeLabel(node.type)} ${label}${node.type === 'asset' && !covered ? '，未覆盖' : ''}`}
      aria-pressed={selected}
      transform={`translate(${x}, ${y})`}
      onClick={onSelect}
      onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(); } }}
      style={{ cursor: 'pointer' }}
      opacity={covered ? 1 : 0.55}
    >
      <title>{`${nodeTypeLabel(node.type)} · ${label}`}</title>
      <rect width={ASSET_NODE_W} height={ASSET_NODE_H} rx={4} fill={selected ? '#12161d' : '#0b0e13'} stroke={selected ? color : covered ? '#252c37' : '#6b7280'} strokeWidth={selected ? 1.6 : 1} strokeDasharray={covered ? undefined : '4 4'} />
      <rect width={3} height={ASSET_NODE_H} fill={color} />
      <text x={12} y={17} fill="#f2efe6" fontSize={9} fontFamily="inherit" letterSpacing="0.08em">{nodeTypeLabel(node.type)} · {node.kind}</text>
      <text x={12} y={33} fill="#cdd0d7" fontSize={10} fontFamily="inherit">{truncateText(label, 28)}</text>
      <text x={12} y={46} fill="#8b8f98" fontSize={9} fontFamily="inherit">{node.type === 'asset' ? (covered ? '已覆盖' : '未测') : node.kind}</text>
    </g>
  );
}

function NodeLinks({ node, missionId }: { node: MissionAssetNode; missionId: string }) {
  if (node.type === 'task' && node.taskId) {
    return <Link to={`/missions/${missionId}/dag?task=${node.taskId}`} className="inline-flex items-center gap-1 text-lime hover:underline">打开依赖图 <ArrowUpRight className="size-3" aria-hidden="true" /></Link>;
  }
  if (node.type === 'finding') {
    const findingId = node.id.replace(/^finding:/, '');
    return <Link to={`/findings/${findingId}`} className="inline-flex items-center gap-1 text-lime hover:underline">打开发现 <ArrowUpRight className="size-3" aria-hidden="true" /></Link>;
  }
  if (node.type === 'asset' && node.kind === 'credential') {
    return <Link to={`/missions/${missionId}/blackboard`} className="inline-flex items-center gap-1 text-amber-200 hover:underline"><ShieldAlert className="size-3" aria-hidden="true" />打开黑板查看明文 <ArrowUpRight className="size-3" aria-hidden="true" /></Link>;
  }
  return <Link to={`/missions/${missionId}/blackboard`} className="inline-flex items-center gap-1 text-lime hover:underline">打开黑板 <ArrowUpRight className="size-3" aria-hidden="true" /></Link>;
}

function Coverage({ graph, compact = false }: { graph: MissionAssetGraph; compact?: boolean }) {
  const percent = graph.counts.ratio === null ? 0 : Math.round(graph.counts.ratio * 100);
  return (
    <Panel className={cn('p-4', compact && 'border-0 bg-transparent p-0')}>
      {!compact ? <SectionLabel index="覆盖" right={<span className="mono text-[10px] text-faint">{graph.counts.covered} / {graph.counts.total}</span>}>覆盖度</SectionLabel> : null}
      <div className="flex items-baseline justify-between gap-4">
        <span className={cn('display text-paper', compact ? 'text-xl' : 'text-3xl')}>{graph.counts.ratio === null ? '—' : `${percent}%`}</span>
        <span className="mono text-[10px] text-faint">{graph.counts.covered} / {graph.counts.total} 已覆盖</span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden bg-line" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <div className="h-full bg-lime" style={{ width: `${percent}%` }} />
      </div>
      {!compact ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {Object.entries(graph.counts.byType).map(([kind, count]) => <Badge key={kind} tone="muted">{factKindLabel(kind)} ×{count}</Badge>)}
        </div>
      ) : null}
    </Panel>
  );
}

function displayLabel(node: MissionAssetNode, taskById: Map<string, Task>): string {
  const label = node.kind === 'credential' ? maskSensitiveValue(node.label) : node.label;
  if (node.type === 'task' && node.taskId) {
    const task = taskById.get(node.taskId);
    if (task) return `${taskTitle(task)} · ${taskLabel(task.state)}`;
  }
  return label;
}

function taskTitle(task: Task): string {
  const result = task.result ?? {};
  const goal = typeof result.objective === 'string' ? result.objective : '';
  return goal || `${task.type} · ${task.id.slice(0, 8)}`;
}

function nodeTypeLabel(type: MissionAssetNode['type']): string {
  if (type === 'asset') return '资产';
  if (type === 'task') return '任务';
  if (type === 'finding') return '发现';
  return '证据';
}

function nodeColor(node: MissionAssetNode): string {
  if (node.type === 'task') return '#d7ff3f';
  if (node.type === 'finding') return '#a78bfa';
  if (node.type === 'evidence') return '#8b8f98';
  return ASSET_COLORS[node.kind] ?? '#8b8f98';
}

function truncateText(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}

