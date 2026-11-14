import type { ExploreEdge, ExploreGraph, ExploreNode } from './types';

// Client-side deterministic layout for the explore graph. Nodes are arranged in
// left-to-right bands: mission → tasks → facts. Large groups wrap into adjacent
// sub-columns so the graph stays wide/landscape and the UI can pan/zoom it.
export const EXPLORE_CARD_W = 176;
export const EXPLORE_CARD_H = 54;
const COL_GAP = 82;
const ROW_GAP = 24;
const MAX_ROWS = 7;
const MARGIN = 36;

export interface PositionedExploreNode {
  node: ExploreNode;
  x: number;
  y: number;
}

export interface PositionedExploreEdge {
  edge: ExploreEdge;
  path: string;
  from: PositionedExploreNode;
  to: PositionedExploreNode;
}

export interface ExploreLayout {
  nodes: PositionedExploreNode[];
  edges: PositionedExploreEdge[];
  width: number;
  height: number;
}

function chunk<T>(items: T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let index = 0; index < items.length; index += size) rows.push(items.slice(index, index + size));
  return rows;
}

function placeBand(items: ExploreNode[], startX: number): { nodes: PositionedExploreNode[]; columns: number } {
  const columns = chunk(items, MAX_ROWS);
  const nodes: PositionedExploreNode[] = [];
  columns.forEach((column, columnIndex) => {
    column.forEach((node, row) => {
      nodes.push({
        node,
        x: startX + columnIndex * (EXPLORE_CARD_W + COL_GAP),
        y: MARGIN + row * (EXPLORE_CARD_H + ROW_GAP),
      });
    });
  });
  return { nodes, columns: Math.max(1, columns.length) };
}

function edgePath(from: PositionedExploreNode, to: PositionedExploreNode): string {
  const x1 = from.x + EXPLORE_CARD_W;
  const y1 = from.y + EXPLORE_CARD_H / 2;
  const x2 = to.x;
  const y2 = to.y + EXPLORE_CARD_H / 2;
  if (x2 >= x1) {
    const mid = x1 + (x2 - x1) / 2;
    return `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`;
  }
  // Backward edge: route around the node band.
  const bulge = Math.max(36, Math.abs(x1 - x2) / 2);
  return `M ${x1} ${y1} C ${x1 + bulge} ${y1 - 18}, ${x2 - bulge} ${y2 + 18}, ${x2} ${y2}`;
}

export function layoutExploreGraph(graph: ExploreGraph): ExploreLayout {
  const missionNodes = graph.nodes.filter(node => node.type === 'mission');
  const taskNodes = graph.nodes.filter(node => node.type === 'task');
  const factNodes = graph.nodes.filter(node => node.type === 'fact');

  const placed: PositionedExploreNode[] = [];
  let cursorX = MARGIN;

  const missionBand = placeBand(missionNodes, cursorX);
  placed.push(...missionBand.nodes);
  cursorX += missionBand.columns * (EXPLORE_CARD_W + COL_GAP);

  const taskBand = placeBand(taskNodes, cursorX);
  placed.push(...taskBand.nodes);
  cursorX += taskBand.columns * (EXPLORE_CARD_W + COL_GAP);

  const factBand = placeBand(factNodes, cursorX);
  placed.push(...factBand.nodes);

  const byId = new Map(placed.map(node => [node.node.id, node]));
  const edges = graph.edges
    .map(edge => {
      const from = byId.get(edge.source);
      const to = byId.get(edge.target);
      if (!from || !to) return null;
      return { edge, from, to, path: edgePath(from, to) };
    })
    .filter((edge): edge is PositionedExploreEdge => edge !== null);

  const maxX = placed.reduce((max, item) => Math.max(max, item.x + EXPLORE_CARD_W), 0);
  const maxY = placed.reduce((max, item) => Math.max(max, item.y + EXPLORE_CARD_H), 0);
  return {
    nodes: placed,
    edges,
    width: Math.max(880, maxX + MARGIN),
    height: Math.max(320, maxY + MARGIN),
  };
}
