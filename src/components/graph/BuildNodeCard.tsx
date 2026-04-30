import { memo } from "react";
import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import type { BuildNode } from "../../api";
import { TypeIcon } from "../common";
import { useUiStore } from "../../store";
import "./BuildNodeCard.css";

// ─── Kind label ───────────────────────────────────────────────────────────────

function kindLabel(node: BuildNode): string {
  switch (node.kind.type) {
    case "manufacturing": return `Mfg · ME${node.kind.me} TE${node.kind.te}`;
    case "reaction":      return `Reaction · TE${node.kind.te}`;
    case "invention":     return `Invention · ${(node.kind.probability * 100).toFixed(1)}%`;
    case "buy": {
      const covered = node.quantityOnHand + node.quantityInProgress + node.quantityFromHangar;
      if (node.quantityToBuy === 0 && covered > 0) return "In stock";
      if (node.quantityToBuy > 0  && covered > 0) return "Buy from market (short)";
      return "Buy from market";
    }
    case "virtualHangar": return "From virtual hangar";
    default:              return "";
  }
}

function kindTooltip(node: BuildNode): string {
  switch (node.kind.type) {
    case "manufacturing":
      return [
        `Material Efficiency: ${node.kind.me}/10 — each ME level saves ~0.5% of material cost per run.`,
        node.kind.me < 10 ? `Research to ME10 in Settings → Blueprint Overrides to reduce waste.` : `At max efficiency — no material waste from blueprint.`,
        `Time Efficiency: ${node.kind.te}/10 — each TE level reduces job duration by ~2%.`,
        node.kind.structureProfileId
          ? `Using structure profile.`
          : `No structure profile set — job cost uses NPC station rates (0% material bonus). Add a profile in Settings.`,
      ].join("\n");
    case "reaction":
      return [
        `Reaction TE: ${node.kind.te}/10 — reduces reaction job duration.`,
        node.kind.structureProfileId
          ? `Using structure profile.`
          : `No structure profile — reaction cost uses NPC rates. Consider an Athanor or Tatara.`,
      ].join("\n");
    case "invention":
      return `Invention chance: ${(node.kind.probability * 100).toFixed(1)}%.\nTrain encryption + datacore skills and use decrypters to improve probability.\nRuns per successful BPC: ${node.kind.runsPerBpc}. Output ME: ${node.kind.outputMe}, TE: ${node.kind.outputTe}.`;
    case "buy": {
      const covered = node.quantityOnHand + node.quantityInProgress + node.quantityFromHangar;
      if (node.quantityToBuy === 0 && covered > 0) return "Fully covered by stock — nothing to buy.";
      if (node.quantityToBuy > 0  && covered > 0) return "Partially covered by stock — buy the shortfall.";
      return "Sourced from market. Override to Build in the detail panel (click node) if you want to manufacture it instead.";
    }
    case "virtualHangar":
      return `Sourced from your virtual hangar stock. Manage quantities in Settings → Virtual Hangar.`;
    default:
      return "";
  }
}

// ─── Number formatting ────────────────────────────────────────────────────────

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function fmtCost(n: number | null): string {
  if (n === null || n === 0) return "—";
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000)     return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)         return `${(n / 1_000).toFixed(1)}k`;
  return n.toFixed(0);
}

// ─── Component ────────────────────────────────────────────────────────────────

export const BuildNodeCard = memo(function BuildNodeCard({
  id,
  data,
}: NodeProps) {
  const buildNode = data as unknown as BuildNode;

  const selectedId  = useUiStore((s) => s.selectedNodeId);
  const selectNode  = useUiStore((s) => s.selectNode);

  const isSelected = selectedId === id;
  const kind       = buildNode.kind.type;

  const hasBuy     = buildNode.quantityToBuy > 0;
  const hasInProg  = buildNode.quantityInProgress > 0;

  // Improvement hints
  const lowMe = kind === "manufacturing" && buildNode.kind.type === "manufacturing" && buildNode.kind.me < 10;
  const noProfile = (kind === "manufacturing" || kind === "reaction") &&
    (buildNode.kind as { structureProfileId?: string | null }).structureProfileId == null;

  return (
    <div
      className={`bn-card kind-${kind}${isSelected ? " selected" : ""}`}
      onClick={() => selectNode(isSelected ? null : id)}
    >
      {/* React Flow connection handles */}
      <Handle type="target" position={Position.Top}    style={{ opacity: 0 }} />
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />

      {/* Kind stripe */}
      <div className="bn-card-stripe" />

      {/* Header */}
      <div className="bn-card-header">
        <TypeIcon
          typeId={buildNode.typeId}
          variant={kind === "buy" || kind === "virtualHangar" ? "icon" : "render"}
          size={64}
          displaySize={36}
          className="bn-card-icon"
          alt={buildNode.typeName}
        />
        <div className="bn-card-title">
          <div className="bn-card-name" title={buildNode.typeName}>
            {buildNode.typeName}
          </div>
          <div className="bn-card-kind" title={kindTooltip(buildNode)}>
            {kindLabel(buildNode)}
            {lowMe && (
              <span className="bn-hint-dot orange" title={`ME${(buildNode.kind as {me:number}).me}/10 — research to ME10 to cut material waste`}>
                ◆
              </span>
            )}
            {noProfile && (
              <span className="bn-hint-dot yellow" title="No structure profile — job cost uses NPC station rates. Add a profile in Settings.">
                ◆
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="bn-card-stats">
        <div className="bn-stat" title="Total quantity of this item required for the whole plan branch.">
          <span className="bn-stat-label">Needed</span>
          <span className="bn-stat-value">{fmt(buildNode.quantityNeeded)}</span>
        </div>

        {buildNode.runs > 0 && (
          <div className="bn-stat" title="Number of job runs required to produce the needed quantity.">
            <span className="bn-stat-label">Runs</span>
            <span className="bn-stat-value">{fmt(buildNode.runs)}</span>
          </div>
        )}

        {buildNode.quantityProduced > 0 && (
          <div className="bn-stat" title="Total units produced by these runs (may exceed Needed — leftover goes to hangar).">
            <span className="bn-stat-label">Produced</span>
            <span className="bn-stat-value">{fmt(buildNode.quantityProduced)}</span>
          </div>
        )}

        {buildNode.jobCost !== null && buildNode.jobCost > 0 && (
          <div className="bn-stat" title="Estimated ISK job installation fee: output value × system cost index × facility tax. Reduce by manufacturing in a low-index system or negotiating lower structure tax.">
            <span className="bn-stat-label">Job cost</span>
            <span className="bn-stat-value highlight">{fmtCost(buildNode.jobCost)}</span>
          </div>
        )}
      </div>

      {/* Footer: buy/in-progress quantities */}
      {(hasBuy || hasInProg || buildNode.quantityOnHand > 0) && (
        <div className="bn-card-footer">
          {buildNode.quantityOnHand > 0 && (
            <div className="bn-footer-stat" title="Quantity already in your assets — subtracted from what needs to be built or bought.">
              <span>On hand</span>
              <span>{fmt(buildNode.quantityOnHand)}</span>
            </div>
          )}
          {hasInProg && (
            <div className="bn-footer-stat prog-flag" title="Quantity currently being produced in active industry jobs — subtracted from remaining need.">
              <span>In jobs</span>
              <span>{fmt(buildNode.quantityInProgress)}</span>
            </div>
          )}
          {hasBuy && (
            <div className="bn-footer-stat buy-flag" title="Quantity to purchase from market after accounting for on-hand stock and active jobs.">
              <span>Buy</span>
              <span>{fmt(buildNode.quantityToBuy)}</span>
            </div>
          )}
        </div>
      )}

    </div>
  );
});
