import { useEffect, useMemo } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  BackgroundVariant,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { useSolverStore } from "../../store";
import { buildGraphData } from "./layout";
import { BuildNodeCard } from "./BuildNodeCard";
import "./GraphView.css";

// Register the custom node type once, outside the component so the reference
// is stable and React Flow doesn't remount nodes on every render.
const nodeTypes = { buildNode: BuildNodeCard };

export function GraphView() {
  const nodes_data = useSolverStore((s) => s.nodes);
  const solving    = useSolverStore((s) => s.solving);
  const error      = useSolverStore((s) => s.error);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<any>([]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<any>([]);

  // Recompute layout whenever solver results change.
  const graphData = useMemo(() => buildGraphData(nodes_data), [nodes_data]);

  useEffect(() => {
    setRfNodes(graphData.nodes);
    setRfEdges(graphData.edges);
  }, [graphData, setRfNodes, setRfEdges]);

  const isEmpty = !solving && nodes_data.length === 0 && !error;

  return (
    <div className="graph-view">
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        minZoom={0.1}
        maxZoom={2}
        nodesDraggable
        nodesConnectable={false}
        elementsSelectable
        proOptions={{ hideAttribution: true }}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={24}
          size={1}
          color="var(--border)"
        />
        <Controls showInteractive={false} />
        <MiniMap
          nodeColor={(n) => {
            const kind = (n.data as { kind?: { type?: string } })?.kind?.type;
            switch (kind) {
              case "manufacturing": return "var(--accent)";
              case "reaction":      return "var(--orange)";
              case "invention":     return "#9b59b6";
              case "buy":           return "var(--green)";
              case "virtualHangar": return "var(--gold)";
              default:              return "var(--border)";
            }
          }}
          maskColor="rgba(0,0,0,0.6)"
          pannable
          zoomable
        />
      </ReactFlow>

      {isEmpty && (
        <div className="graph-empty">
          <div className="graph-empty-card">
            <div className="graph-empty-title">Production Planner</div>
            <div className="graph-empty-steps">
              <div className="graph-empty-step">
                <span className="graph-empty-step-n">1</span>
                <span>Search for an item in the <strong>sidebar</strong> or use <strong>Blueprints</strong> to browse</span>
              </div>
              <div className="graph-empty-step">
                <span className="graph-empty-step-n">2</span>
                <span>Set the quantity you want to produce</span>
              </div>
              <div className="graph-empty-step">
                <span className="graph-empty-step-n">3</span>
                <span>Press <strong>Solve</strong> or <kbd>Ctrl+Enter</kbd> to generate the build graph</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {solving && (
        <div className="graph-solving">
          <div className="spinner" />
          Solving…
        </div>
      )}

      {error && !solving && (
        <div className="graph-empty">
          <span className="graph-empty-title" style={{ color: "var(--red)" }}>
            Solver error
          </span>
          <span className="graph-empty-sub">{error}</span>
        </div>
      )}
    </div>
  );
}
