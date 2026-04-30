/**
 * Converts the solver's BuildNode tree(s) into React Flow nodes and edges.
 *
 * The solver returns trees where the same typeId may appear at multiple
 * branches (e.g. Tritanium needed by many blueprints).  We deduplicate by
 * typeId to produce a DAG, then compute a layered top-down layout:
 *
 *   Layer 0 — root products (the plan targets)
 *   Layer N — materials N levels deep in the dependency chain
 *
 * Within each layer nodes are evenly spaced.
 */

import type { Edge, Node } from "@xyflow/react";
import type { BuildNode } from "../../api";

// ── Layout constants ──────────────────────────────────────────────────────────

const NODE_W   = 240;
const NODE_H   = 88;
const H_GAP    = 40;   // horizontal gap between nodes in the same layer
const V_GAP    = 80;   // vertical gap between layers

// ── Public output type ────────────────────────────────────────────────────────

export interface GraphData {
  nodes: Node[];
  edges: Edge[];
}

// ── Conversion ────────────────────────────────────────────────────────────────

// Invention nodes share their typeId with the manufacturing node of the same
// product. Use a suffixed key to keep them distinct in the graph.
function nodeKey(node: BuildNode): string {
  return node.kind.type === "invention" ? `${node.typeId}_inv` : String(node.typeId);
}

export function buildGraphData(roots: BuildNode[]): GraphData {
  if (roots.length === 0) return { nodes: [], edges: [] };

  // ── Pass 1: collect unique nodes & edges (deduplicate by key) ─────────────
  const nodeMap = new Map<string, BuildNode>();    // key → BuildNode
  const edgeSet = new Set<string>();               // "parentKey→childKey"
  const edgePairs: [string, string][] = [];        // [parentKey, childKey]

  function visit(node: BuildNode) {
    const key = nodeKey(node);
    const isNew = !nodeMap.has(key);
    if (isNew) nodeMap.set(key, node);

    for (const child of node.inputs) {
      const childKey = nodeKey(child);
      const edgeId = `${key}→${childKey}`;
      if (!edgeSet.has(edgeId)) {
        edgeSet.add(edgeId);
        edgePairs.push([key, childKey]);
      }
      // Always recurse so we register deeper nodes even if this edge was seen.
      if (!nodeMap.has(childKey)) {
        visit(child);
      }
    }
  }

  for (const root of roots) visit(root);

  // ── Pass 2: assign layers (longest path from any root) ───────────────────
  const children = new Map<string, Set<string>>();
  const parents  = new Map<string, Set<string>>();

  for (const id of nodeMap.keys()) {
    children.set(id, new Set());
    parents.set(id, new Set());
  }
  for (const [p, c] of edgePairs) {
    children.get(p)!.add(c);
    parents.get(c)!.add(p);
  }

  // Longest-path layering via topological sort (BFS from roots with relaxation).
  const rootKeys = roots.map((r) => nodeKey(r));
  const layer = new Map<string, number>();
  for (const id of nodeMap.keys()) layer.set(id, 0);

  const queue: string[] = [...new Set(rootKeys)];
  const visited = new Set<string>(queue);

  while (queue.length > 0) {
    const id = queue.shift()!;
    const currentLayer = layer.get(id)!;
    for (const child of children.get(id) ?? []) {
      const newLayer = currentLayer + 1;
      if (newLayer > (layer.get(child) ?? 0)) {
        layer.set(child, newLayer);
      }
      if (!visited.has(child)) {
        visited.add(child);
        queue.push(child);
      }
    }
  }

  // ── Pass 3: group by layer and compute x positions ────────────────────────
  const layerGroups = new Map<number, string[]>();
  for (const [id, lyr] of layer) {
    if (!layerGroups.has(lyr)) layerGroups.set(lyr, []);
    layerGroups.get(lyr)!.push(id);
  }

  // Sort each layer for a stable visual order (owned/build nodes first).
  for (const ids of layerGroups.values()) {
    ids.sort((a, b) => {
      const na = nodeMap.get(a)!;
      const nb = nodeMap.get(b)!;
      const kindOrder = (k: BuildNode) => {
        switch (k.kind.type) {
          case "manufacturing": return 0;
          case "reaction":      return 1;
          case "invention":     return 2;
          case "virtualHangar": return 3;
          case "buy":           return 4;
          default:              return 5;
        }
      };
      return kindOrder(na) - kindOrder(nb) || na.typeName.localeCompare(nb.typeName);
    });
  }

  const positions = new Map<string, { x: number; y: number }>();

  for (const [lyr, ids] of layerGroups) {
    const total = ids.length;
    const rowWidth = total * NODE_W + (total - 1) * H_GAP;
    const startX = -rowWidth / 2;
    ids.forEach((id, i) => {
      positions.set(id, {
        x: startX + i * (NODE_W + H_GAP),
        y: lyr * (NODE_H + V_GAP),
      });
    });
  }

  // ── Pass 4: build React Flow arrays ──────────────────────────────────────
  const rfNodes: Node[] = [];
  for (const [id, buildNode] of nodeMap) {
    const pos = positions.get(id) ?? { x: 0, y: 0 };
    rfNodes.push({
      id,
      type: "buildNode",
      position: pos,
      data: buildNode as unknown as Record<string, unknown>,
    });
  }

  const rfEdges: Edge[] = edgePairs.map(([p, c]) => ({
    id: `${p}-${c}`,
    source: p,
    target: c,
    type: "smoothstep",
  }));

  return { nodes: rfNodes, edges: rfEdges };
}
