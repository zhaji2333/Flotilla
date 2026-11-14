import { useMemo, useState } from 'react';
import { ArrowRight, GitBranch } from 'lucide-react';
import { GraphCanvas } from './graph-canvas';
import { Link } from 'react-router-dom';
import { layoutDag, NODE_H, NODE_W, taskStateColor } from '../lib/dag';
import type { Task } from '../lib/types';
import { taskAngleLabel, taskLabel, truncate } from '../lib/format';
import { cn } from '../lib/utils';
import { TaskStatus } from './status-badge';
import { EmptyState } from './ui';

function taskTitle(task: Task): string {
  const result = task.result ?? {};
  const goal = typeof result.objective === 'string' ? result.objective : typeof result.goal === 'string' ? result.goal : '';
  return goal || `${task.type} · ${task.id.slice(0, 8)}`;
}

export function DagView({
  tasks,
  missionId,
  selectedId,
  onSelect,
}: {
  tasks: Task[];
  missionId: string;
  selectedId: string | null;
  onSelect: (taskId: string) => void;
}) {
  const layout = useMemo(() => layoutDag(tasks), [tasks]);
  const [hovered, setHovered] = useState<string | null>(null);

  if (tasks.length === 0) {
    return <EmptyState icon={<GitBranch className="size-6" aria-hidden="true" />} title="暂无任务节点" hint="任务创建后，依赖图会在这里展开。" />;
  }

  const selected = tasks.find(task => task.id === selectedId) ?? null;

  return (
    <div>
      <GraphCanvas ariaLabel="任务依赖图" height={520}>
        <svg
          width={layout.width}
          height={layout.height}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          role="group"
          aria-label="任务依赖图"
          className="min-w-full"
        >
          <defs>
            <marker id="dag-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
              <path d="M 0 0 L 8 4 L 0 8 z" fill="#3a4352" />
            </marker>
          </defs>
          {layout.edges.map((edge, index) => (
            <path
              key={`${edge.from.task.id}-${edge.to.task.id}-${index}`}
              d={edge.path}
              fill="none"
              stroke={edge.to.task.state === 'running' ? '#d7ff3f' : '#2a313c'}
              strokeWidth={1.2}
              strokeDasharray={edge.to.task.state === 'running' ? '6 6' : undefined}
              markerEnd="url(#dag-arrow)"
              className={edge.to.task.state === 'running' ? 'edge-dash' : undefined}
              opacity={0.9}
            />
          ))}
          {layout.nodes.map(node => {
            const color = taskStateColor(node.task.state);
            const isSelected = selectedId === node.task.id;
            const isHovered = hovered === node.task.id;
            return (
              <g
                key={node.task.id}
                role="button"
                tabIndex={0}
                aria-label={`${taskTitle(node.task)}，状态 ${taskLabel(node.task.state)}`}
                aria-pressed={isSelected}
                transform={`translate(${node.x}, ${node.y})`}
                onClick={() => onSelect(node.task.id)}
                onKeyDown={event => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onSelect(node.task.id);
                  }
                }}
                onMouseEnter={() => setHovered(node.task.id)}
                onMouseLeave={() => setHovered(null)}
                style={{ cursor: 'pointer' }}
                opacity={selectedId && !isSelected ? 0.72 : 1}
              >
                <rect
                  width={NODE_W}
                  height={NODE_H}
                  rx={4}
                  fill={isSelected || isHovered ? '#12161d' : '#0b0e13'}
                  stroke={isSelected ? color : isHovered ? '#4a5361' : '#252c37'}
                  strokeWidth={isSelected ? 1.6 : 1}
                />
                <rect width={3} height={NODE_H} fill={color} />
                {node.task.state === 'running' ? <circle cx={NODE_W - 14} cy={16} r={3} fill={color} className="pulse-dot" /> : null}
                <text x={14} y={24} fill="#f2efe6" fontSize={11} fontFamily="inherit" letterSpacing="0.06em">
                  {truncate(`${node.task.type.toUpperCase()}${node.task.angle ? ` · ${node.task.angle.toUpperCase()}` : ''}`, 28)}
                </text>
                <text x={14} y={40} fill="#8b8f98" fontSize={10} fontFamily="inherit">
                  {truncate(taskTitle(node.task), 24)}
                </text>
                <text x={14} y={54} fill={color} fontSize={9} fontFamily="inherit" letterSpacing="0.12em">
                  {taskLabel(node.task.state).toUpperCase()}
                </text>
              </g>
            );
          })}
        </svg>
      </GraphCanvas>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3 text-[10px] uppercase tracking-[0.14em] text-faint">
          <span className="inline-flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-lime" aria-hidden="true" />运行中</span>
          <span className="inline-flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-sky" aria-hidden="true" />已领取</span>
          <span className="inline-flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-emerald-300" aria-hidden="true" />已完成</span>
          <span className="inline-flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-ember" aria-hidden="true" />耗尽</span>
        </div>
        <span className="mono text-[10px] text-faint">节点 {tasks.length} · 依赖边 {layout.edges.length}</span>
      </div>

      {selected ? (
        <div className="mt-4 border border-line bg-panel p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="micro mb-2">selected task · {selected.id.slice(0, 8)}</p>
              <p className="text-sm text-paper">{taskTitle(selected)}</p>
              <p className="mono mt-1 text-[11px] text-faint">第 {selected.attempt} 次尝试 · 优先级 {selected.priority} · 依赖 {selected.dependsOn.length} 个任务 · {taskAngleLabel(selected.angle)}</p>
            </div>
            <TaskStatus state={selected.state} />
          </div>
          <div className="mt-4 flex flex-wrap gap-3 text-xs">
            <Link
              to={`/trace/worker/${selected.id}?mission=${missionId}&tab=dag&task=${selected.id}`}
              className="inline-flex items-center gap-1.5 text-lime hover:underline"
            >
              查看执行轨迹 <ArrowRight className="size-3" aria-hidden="true" />
            </Link>
            {selected.lastError ? <span className="mono text-ember">{selected.lastError}</span> : null}
          </div>
        </div>
      ) : (
        <p className={cn('mt-3 text-xs text-faint')}>点击任务节点查看详情并跳转轨迹。</p>
      )}
    </div>
  );
}
