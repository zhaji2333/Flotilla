import type { MissionAssetEdge, MissionAssetGraph, MissionAssetNode } from './types';

// Deterministic layered layout for the project asset graph. Types flow left to
// right (asset → task → finding → evidence); large groups wrap into adjacent
// sub-columns and are panned/zoomed by the graph viewport.
export const ASSET_NODE_W = 210;
export const ASSET_NODE_H = 54;
const COL_GAP = 82;
const ROW_GAP = 18;
const MAX_ROWS = 7;
const MARGIN = 30;
const COLUMN_TYPES: MissionAssetNode['type'][] = ['asset', 'task', 'finding', 'evidence'];

export interface PositionedAssetNode {
  node: MissionAssetNode;
  x: number;
  y: number;
}

export interface PositionedAssetEdge {
  edge: MissionAssetEdge;
  path: string;
}

export interface AssetGraphLayout {
  nodes: PositionedAssetNode[];
  edges: PositionedAssetEdge[];
  width: number;
  height: number;
}

function chunk<T>(items: T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let index = 0; index < items.length; index += size) rows.push(items.slice(index, index + size));
  return rows;
}

export function layoutAssetGraph(graph: MissionAssetGraph): AssetGraphLayout {
  // Multiple assets may share one evidence id; the API may repeat nodes, so the
  // UI dedupes strictly by id before layout.
  const unique = [...new Map(graph.nodes.map(node => [node.id, node])).values()];
  const byType = new Map<MissionAssetNode['type'], MissionAssetNode[]>(COLUMN_TYPES.map(type => [type, []]));
  for (const node of unique) byType.get(node.type)?.push(node);

  const nodes: PositionedAssetNode[] = [];
  let cursorX = MARGIN;
  COLUMN_TYPES.forEach(type => {
    const items = byType.get(type) ?? [];
    const columns = chunk(items, MAX_ROWS);
    columns.forEach((column, columnIndex) => {
      column.forEach((node, row) => {
        nodes.push({
          node,
          x: cursorX + columnIndex * (ASSET_NODE_W + COL_GAP),
          y: MARGIN + row * (ASSET_NODE_H + ROW_GAP),
        });
      });
    });
    cursorX += Math.max(1, columns.length) * (ASSET_NODE_W + COL_GAP);
  });

  const byId = new Map(nodes.map(item => [item.node.id, item]));
  const edges: PositionedAssetEdge[] = [];
  for (const edge of graph.edges) {
    const from = byId.get(edge.source);
    const to = byId.get(edge.target);
    if (!from || !to) continue;
    const x1 = from.x + ASSET_NODE_W;
    const y1 = from.y + ASSET_NODE_H / 2;
    const x2 = to.x;
    const y2 = to.y + ASSET_NODE_H / 2;
    if (x2 >= x1) {
      const mid = x1 + (x2 - x1) / 2;
      edges.push({ edge, path: `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}` });
    } else {
      const bulge = Math.max(36, Math.abs(x1 - x2) / 2);
      edges.push({ edge, path: `M ${x1} ${y1} C ${x1 + bulge} ${y1 - 20}, ${x2 - bulge} ${y2 + 20}, ${x2} ${y2}` });
    }
  }

  const maxX = nodes.reduce((max, item) => Math.max(max, item.x + ASSET_NODE_W), 0);
  const maxY = nodes.reduce((max, item) => Math.max(max, item.y + ASSET_NODE_H), 0);
  return {
    nodes,
    edges,
    width: Math.max(960, maxX + MARGIN),
    height: Math.max(300, maxY + MARGIN),
  };
}
