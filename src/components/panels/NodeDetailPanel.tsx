import { useState, useEffect } from "react";
import { useUiStore, useSolverStore, useSettingsStore, useMarketStore } from "../../store";
import { TypeIcon } from "../common";
import { computeNodeCosts } from "../../lib/buildCost";
import { getSystemCostInfo, getCheapestSystems } from "../../api";
import type { BuildNode, Decision, SystemCostInfo, CheapestSystemEntry } from "../../api";
import { fmtIsk } from "../../lib/format";
import "./NodeDetailPanel.css";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Recursively find a BuildNode by typeId in a forest of BuildNode trees. */
function findNode(roots: BuildNode[], typeId: number): BuildNode | null {
  for (const root of roots) {
    if (root.typeId === typeId) return root;
    const found = findNode(root.inputs, typeId);
    if (found) return found;
  }
  return null;
}

function fmt(n: number): string {
  return n.toLocaleString();
}

// ── Component ─────────────────────────────────────────────────────────────────

export function NodeDetailPanel() {
  const selectedNodeId   = useUiStore((s) => s.selectedNodeId);
  const solverNodes      = useSolverStore((s) => s.nodes);
  const manualDecisions  = useSettingsStore((s) => s.manualDecisions);
  const setDecision      = useSettingsStore((s) => s.setDecision);
  const clearDecision    = useSettingsStore((s) => s.clearDecision);
  const blueprintOverrides = useSettingsStore((s) => s.blueprintOverrides);
  const setOverride      = useSettingsStore((s) => s.setOverride);

  // Market prices — subscribe so panel re-renders when prices load.
  const marketPrices   = useMarketStore((s) => s.prices);
  const marketRegions  = useMarketStore((s) => s.regions);
  const getPricesForType = useMarketStore((s) => s.getPricesForType);

  function getBestSell(tid: number): number | null {
    let best: number | null = null;
    for (const entry of Object.values(marketPrices)) {
      if (entry.typeId === tid && entry.bestSell !== null) {
        best = best === null ? entry.bestSell : Math.max(best, entry.bestSell);
      }
    }
    return best;
  }

  const typeId = selectedNodeId !== null ? parseInt(selectedNodeId.replace("_inv", ""), 10) : null;
  const node   = typeId !== null ? findNode(solverNodes, typeId) : null;

  // ── ME/TE local edit state ─────────────────────────────────────────────────
  const existingOverride = typeId !== null
    ? blueprintOverrides.find((o) => o.typeId === typeId)
    : null;

  const nodeMe = node?.kind.type === "manufacturing" ? node.kind.me : null;
  const nodeTe = node?.kind.type === "manufacturing" ? node.kind.te
               : node?.kind.type === "reaction"      ? node.kind.te
               : null;

  const [localMe, setLocalMe] = useState<number>(existingOverride?.meLevel ?? nodeMe ?? 0);
  const [localTe, setLocalTe] = useState<number>(existingOverride?.teLevel ?? nodeTe ?? 0);

  // Re-sync when the selected node changes.
  useEffect(() => {
    setLocalMe(existingOverride?.meLevel ?? nodeMe ?? 0);
    setLocalTe(existingOverride?.teLevel ?? nodeTe ?? 0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedNodeId]);

  // ── System cost index ──────────────────────────────────────────────────────
  const [systemCostInfo, setSystemCostInfo]     = useState<SystemCostInfo | null>(null);
  const [cheapestSystems, setCheapestSystems]   = useState<CheapestSystemEntry[]>([]);

  const profiles = useSettingsStore((s) => s.structureProfiles);

  useEffect(() => {
    setSystemCostInfo(null);
    setCheapestSystems([]);
    if (!node) return;

    const profileId =
      node.kind.type === "manufacturing" ? node.kind.structureProfileId
      : node.kind.type === "reaction"    ? node.kind.structureProfileId
      : null;
    const profile = profileId ? profiles.find((p) => p.id === profileId) : null;
    const systemId = profile?.solarSystemId ?? null;
    if (!systemId) return;

    const activity = node.kind.type === "reaction" ? "reaction" : "manufacturing";

    getSystemCostInfo(systemId).then((info) => {
      setSystemCostInfo(info);
    }).catch(() => {});

    getCheapestSystems(activity, 5).then((list) => {
      setCheapestSystems(list);
    }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedNodeId]);

  // ── Empty state ────────────────────────────────────────────────────────────
  if (!node || typeId === null) {
    const hasSolverData = solverNodes.length > 0;
    return (
      <div className="ndp-empty">
        {hasSolverData ? (
          <>
            <svg width="28" height="28" viewBox="0 0 28 28" fill="none" aria-hidden="true" style={{ opacity: 0.3 }}>
              <rect x="3" y="3" width="22" height="22" rx="3" stroke="currentColor" strokeWidth="1.8"/>
              <line x1="8" y1="9" x2="20" y2="9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              <line x1="8" y1="14" x2="20" y2="14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              <line x1="8" y1="19" x2="14" y2="19" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
            <span>Click any node in the graph</span>
            <span>to inspect it here</span>
          </>
        ) : (
          <>
            <svg width="28" height="28" viewBox="0 0 28 28" fill="none" aria-hidden="true" style={{ opacity: 0.3 }}>
              <circle cx="14" cy="14" r="10" stroke="currentColor" strokeWidth="1.8"/>
              <polyline points="14,8 14,14 18,17" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            <span>Solve a plan to see</span>
            <span>node details here</span>
          </>
        )}
      </div>
    );
  }

  // ── Decision override ──────────────────────────────────────────────────────
  const manualDecision = manualDecisions.find((d) => d.typeId === typeId)?.decision ?? null;

  function handleDecision(d: Decision) {
    if (manualDecision === d) {
      clearDecision(typeId!);
    } else {
      setDecision(typeId!, d);
    }
  }

  // ── Derived kind label ─────────────────────────────────────────────────────
  const kindLabel: Record<string, string> = {
    manufacturing: "Manufacturing",
    reaction:      "Reaction",
    invention:     "Invention",
    buy:           "Buy",
    virtualHangar: "Virtual Hangar",
  };

  const isManufacturing = node.kind.type === "manufacturing";
  const isReaction      = node.kind.type === "reaction";
  const isInvention     = node.kind.type === "invention";
  const hasMeTe         = isManufacturing || isReaction;
  const mePct           = node.kind.type === "manufacturing" ? node.kind.me : null;
  const tePct           = node.kind.type === "manufacturing" ? node.kind.te
                        : node.kind.type === "reaction"      ? node.kind.te
                        : null;

  // ── Save ME/TE override ───────────────────────────────────────────────────
  function handleSaveMeTe() {
    setOverride(typeId!, localMe, localTe);
  }

  return (
    <div className="ndp">

      {/* ── Header ── */}
      <div className="ndp-header">
        <TypeIcon typeId={node.typeId} variant="render" size={64} displaySize={48} alt={node.typeName} />
        <div className="ndp-header-info">
          <div className="ndp-name">{node.typeName}</div>
          <div className={`ndp-kind ${node.kind.type}`}>
            {kindLabel[node.kind.type] ?? node.kind.type}
            {mePct !== null && ` · ME${mePct}%`}
            {tePct !== null && ` · TE${tePct}%`}
          </div>
        </div>
      </div>

      {/* ── Decision override ── */}
      <div className="ndp-section">
        <div className="ndp-section-title">Source Override</div>
        <p className="ndp-section-hint">
          Force this item to always be built, bought, or sourced from your virtual hangar —
          overrides the solver's automatic decision. Click an active button to remove the override.
        </p>
        <div className="ndp-decision-row">
          <button
            className={`ndp-decision-btn${manualDecision === "Build" ? " active-build" : ""}`}
            onClick={() => handleDecision("Build")}
            title="Always manufacture this item, even if buying would be cheaper"
          >
            Build
          </button>
          <button
            className={`ndp-decision-btn${manualDecision === "Buy" ? " active-buy" : ""}`}
            onClick={() => handleDecision("Buy")}
            title="Always buy this item from market, never build it"
          >
            Buy
          </button>
          <button
            className={`ndp-decision-btn${manualDecision === "UseHangar" ? " active-hangar" : ""}`}
            onClick={() => handleDecision("UseHangar")}
            title="Source from your virtual hangar stock (configure stock quantities in Settings)"
          >
            Hangar
          </button>
        </div>
      </div>

      {/* ── Quantity breakdown ── */}
      <div className="ndp-section">
        <div className="ndp-section-title">Quantities</div>
        <div className="ndp-qty-grid">
          <div className="ndp-qty-cell" title="Total units of this item the plan requires.">
            <span className="ndp-qty-label">Needed</span>
            <span className="ndp-qty-value">{fmt(node.quantityNeeded)}</span>
          </div>
          <div className="ndp-qty-cell" title="Units output by the planned job runs. May exceed Needed — surplus stays in your hangar.">
            <span className="ndp-qty-label">Produced</span>
            <span className="ndp-qty-value highlight">{fmt(node.quantityProduced)}</span>
          </div>
          {node.runs > 0 && (
            <div className="ndp-qty-cell" title="Number of industry job runs. Each run produces the blueprint's base output quantity × ME efficiency.">
              <span className="ndp-qty-label">Runs</span>
              <span className="ndp-qty-value">{fmt(node.runs)}</span>
            </div>
          )}
          {node.quantityOnHand > 0 && (
            <div className="ndp-qty-cell" title="Quantity already in your assets from last ESI sync. Counted toward fulfilling the plan — reduces what you need to build.">
              <span className="ndp-qty-label">On Hand</span>
              <span className="ndp-qty-value green">{fmt(node.quantityOnHand)}</span>
            </div>
          )}
          {node.quantityInProgress > 0 && (
            <div className="ndp-qty-cell" title="Quantity currently being produced in active industry jobs (from last ESI sync). Counted toward the plan.">
              <span className="ndp-qty-label">In Jobs</span>
              <span className="ndp-qty-value yellow">{fmt(node.quantityInProgress)}</span>
            </div>
          )}
          {node.quantityFromHangar > 0 && (
            <div className="ndp-qty-cell" title="Quantity sourced from your virtual hangar. Manage stock in Settings → Virtual Hangar.">
              <span className="ndp-qty-label">From Hangar</span>
              <span className="ndp-qty-value green">{fmt(node.quantityFromHangar)}</span>
            </div>
          )}
          {node.quantityToBuy > 0 && (
            <div className="ndp-qty-cell" title="Units to purchase from market: Needed − On Hand − In Jobs − From Hangar.">
              <span className="ndp-qty-label">To Buy</span>
              <span className="ndp-qty-value muted">{fmt(node.quantityToBuy)}</span>
            </div>
          )}
          {node.jobCost !== null && node.jobCost > 0 && (
            <div className="ndp-qty-cell" title="Estimated ISK job installation fee: output value × system cost index × facility tax. Reduce by using a lower cost-index system or negotiating lower structure tax.">
              <span className="ndp-qty-label">Job Cost</span>
              <span className="ndp-qty-value">{fmtIsk(node.jobCost)} ISK</span>
            </div>
          )}
        </div>
      </div>

      {/* ── ME/TE override (manufacturing + reaction) ── */}
      {hasMeTe && (
        <div className="ndp-section">
          <div className="ndp-section-title">Blueprint Override</div>
          <div className="ndp-mete-row">
            {isManufacturing && (
              <div className="ndp-mete-field" title="Material Efficiency level (0–10). Each level reduces material requirements by ~0.5%. ME10 is the maximum — research BPOs in-game to reach it.">
                <label className="ndp-mete-label">ME %</label>
                <input
                  className="ndp-mete-input"
                  type="number"
                  min={0}
                  max={10}
                  value={localMe}
                  onChange={(e) => setLocalMe(Math.min(10, Math.max(0, parseInt(e.target.value, 10) || 0)))}
                />
              </div>
            )}
            <div className="ndp-mete-field" title="Time Efficiency level (0–20). Each level reduces job duration by ~1%. TE20 halves the job time vs TE0. Research BPOs in-game to raise this.">
              <label className="ndp-mete-label">TE %</label>
              <input
                className="ndp-mete-input"
                type="number"
                min={0}
                max={20}
                value={localTe}
                onChange={(e) => setLocalTe(Math.min(20, Math.max(0, parseInt(e.target.value, 10) || 0)))}
              />
            </div>
            <button className="ndp-mete-save" onClick={handleSaveMeTe}>
              Save Override
            </button>
          </div>
        </div>
      )}

      {/* ── System cost index ── */}
      {(isManufacturing || isReaction) && systemCostInfo && (() => {
        const raw = isReaction ? systemCostInfo.reaction : systemCostInfo.manufacturing;
        if (raw === null) return null; // system has no recorded activity for this job type
        const idx = raw;
        const profileId =
          node.kind.type === "manufacturing" ? node.kind.structureProfileId
          : node.kind.type === "reaction"    ? node.kind.structureProfileId
          : null;
        const profile = profileId ? profiles.find((p) => p.id === profileId) : null;
        const effective = idx * (profile?.spaceModifier ?? 1);
        const isExpensive = effective > 0.05;
        const activity = isReaction ? "reaction" : "manufacturing";

        return (
          <div className="ndp-section">
            <div className="ndp-section-title">System Cost Index</div>
            <div className="ndp-sci">
              <div className="ndp-sci-row">
                <span className="ndp-sci-system">{systemCostInfo.systemName}</span>
                <span className={`ndp-sci-index${isExpensive ? " ndp-sci-warn" : " ndp-sci-ok"}`}>
                  {(idx * 100).toFixed(2)}%
                </span>
              </div>
              {profile && profile.spaceModifier !== 1 && (
                <div className="ndp-sci-effective">
                  After {profile.spaceModifier}× modifier: {(effective * 100).toFixed(2)}%
                </div>
              )}
              {isExpensive && (
                <div className="ndp-sci-flag">
                  High cost index — consider manufacturing in a cheaper system.
                </div>
              )}
              {cheapestSystems.length > 0 && (
                <div className="ndp-sci-alts">
                  <div className="ndp-sci-alts-title">Cheapest {activity} systems</div>
                  {cheapestSystems.map((s) => (
                    <div key={s.systemId} className="ndp-sci-alt-row">
                      <span className="ndp-sci-alt-name">{s.systemName}</span>
                      <span className={`ndp-sci-alt-idx${s.systemId === systemCostInfo.systemId ? " ndp-sci-alt-current" : ""}`}>
                        {(s.costIndex * 100).toFixed(2)}%
                        {s.systemId === systemCostInfo.systemId && " ◀ current"}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {/* ── Buy vs Build ── */}
      {(isManufacturing || isReaction) && (() => {
        const costs = computeNodeCosts(node, getBestSell);
        const buildIsCheaper = costs !== null && costs.delta >= 0;
        const buyIsCheaper   = costs !== null && costs.delta < 0;
        const savings        = costs !== null ? Math.abs(costs.delta) : 0;

        return (
          <div className="ndp-section">
            <div className="ndp-section-title">Buy vs Build</div>
            {costs === null ? (
              <p className="ndp-bvb-nodata">
                Market prices not loaded — solve the plan first, or check Market Hubs in Settings.
              </p>
            ) : (
              <div className="ndp-bvb">
                <div className="ndp-bvb-row">
                  <span className="ndp-bvb-label">
                    Buy {node.quantityNeeded.toLocaleString()} units
                  </span>
                  <span className="ndp-bvb-val">{fmtIsk(costs.buyCost)} ISK</span>
                </div>
                <div className="ndp-bvb-row">
                  <span className="ndp-bvb-label">
                    Build {node.quantityNeeded.toLocaleString()} units
                  </span>
                  <span className="ndp-bvb-val">{fmtIsk(costs.buildCost)} ISK</span>
                </div>
                <div className={`ndp-bvb-verdict ${buildIsCheaper ? "ndp-bvb-verdict-build" : "ndp-bvb-verdict-buy"}`}>
                  {buildIsCheaper
                    ? `Building saves ${fmtIsk(savings)} ISK`
                    : `Buying saves ${fmtIsk(savings)} ISK`}
                </div>
                {buyIsCheaper && (
                  <button
                    className="ndp-bvb-switch ndp-bvb-switch-buy"
                    title="Set this item to Buy in the source override and re-solve to apply."
                    onClick={() => handleDecision("Buy")}
                  >
                    Switch to Buy
                  </button>
                )}
                {buildIsCheaper && manualDecision === "Buy" && (
                  <button
                    className="ndp-bvb-switch ndp-bvb-switch-build"
                    title="Remove the Buy override so this item is built again."
                    onClick={() => handleDecision("Build")}
                  >
                    Switch to Build
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })()}

      {/* ── Hub prices ── */}
      {marketRegions.length > 0 && (() => {
        const hubPrices = getPricesForType(node.typeId);
        if (hubPrices.length === 0) return null;

        const bestSellHub = hubPrices.reduce<typeof hubPrices[0] | null>(
          (best, p) => p.bestSell !== null && (best === null || p.bestSell > (best.bestSell ?? 0)) ? p : best,
          null,
        );

        return (
          <div className="ndp-section">
            <div className="ndp-section-title">Hub Prices</div>
            <div className="ndp-hub-table">
              <div className="ndp-hub-header">
                <span>Hub</span>
                <span className="ndp-hub-right" title="Highest active buy order — what you get selling immediately">Buy Order</span>
                <span className="ndp-hub-right" title="Lowest active sell order — what you pay buying immediately">Sell Order</span>
              </div>
              {marketRegions.map((region) => {
                const entry = hubPrices.find((p) => p.regionId === region.regionId);
                const isBest = entry && entry.regionId === bestSellHub?.regionId;
                return (
                  <div key={region.id} className={`ndp-hub-row${isBest ? " ndp-hub-row-best" : ""}`}>
                    <span className="ndp-hub-name" title={isBest ? "Best hub to list sell orders" : undefined}>
                      {region.label}
                      {isBest && <span className="ndp-hub-best-dot" title="Best sell price" />}
                    </span>
                    <span className="ndp-hub-right ndp-hub-buy">{fmtIsk(entry?.bestBuy ?? null)}</span>
                    <span className="ndp-hub-right ndp-hub-sell">{fmtIsk(entry?.bestSell ?? null)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* ── Invention details ── */}
      {isInvention && node.kind.type === "invention" && (
        <div className="ndp-section">
          <div className="ndp-section-title">Invention</div>
          <div
            className="ndp-invention-stat"
            title="Final success probability after encryption skill, datacore skills, and decrypter modifier. Each failed attempt consumes datacores — higher probability = lower cost per successful BPC."
          >
            <span>Probability</span>
            <span className={node.kind.probability < 0.3 ? "ndp-warn" : node.kind.probability >= 0.5 ? "ndp-good" : ""}>
              {(node.kind.probability * 100).toFixed(1)}%
            </span>
          </div>
          <div
            className="ndp-invention-stat"
            title="Number of job runs on each successfully invented BPC. More runs per BPC means fewer total invention attempts needed for a production batch — directly improves ISK efficiency."
          >
            <span>Runs / BPC</span>
            <span>{node.kind.runsPerBpc}</span>
          </div>
          <div
            className="ndp-invention-stat"
            title="Material Efficiency of the invented BPC. Higher ME = fewer materials wasted per manufacturing run. Certain decrypters increase this."
          >
            <span>Output ME</span>
            <span>{node.kind.outputMe}%</span>
          </div>
          <div
            className="ndp-invention-stat"
            title="Time Efficiency of the invented BPC. Higher TE = shorter manufacturing jobs."
          >
            <span>Output TE</span>
            <span>{node.kind.outputTe}%</span>
          </div>
          {node.kind.decrypter && (
            <div
              className="ndp-invention-stat"
              title={`Decrypter modifies: probability ×${node.kind.decrypter.probabilityMultiplier.toFixed(2)}, runs +${node.kind.decrypter.runModifier}, ME +${node.kind.decrypter.meModifier}, TE +${node.kind.decrypter.teModifier}`}
            >
              <span>Decrypter</span>
              <span>{node.kind.decrypter.typeName}</span>
            </div>
          )}

          {/* Invention improvement tips */}
          <div className="ndp-invention-tips">
            <div className="ndp-inv-tip-title">How to improve</div>
            <ul className="ndp-inv-tip-list">
              <li>
                <strong>Encryption skill</strong> — train the relevant racial
                encryption skill (e.g. Caldari Encryption Methods) to level 5
                for +10% base probability.
              </li>
              <li>
                <strong>Datacore skills</strong> — each datacore skill at L5
                contributes ~16.7% to the probability bonus. Two datacores are
                used per attempt; both skill levels matter.
              </li>
              <li>
                <strong>Decrypters</strong> — choose based on what you care
                about most:
                <ul className="ndp-inv-tip-sublist">
                  <li><em>More runs/BPC</em> → Parity (Caldari), Symmetry (others) — lower probability but more runs per success, better for large batches</li>
                  <li><em>Higher probability</em> → Accelerant (Caldari) — best when datacores are scarce or expensive</li>
                  <li><em>Better ME on output</em> → Process (Caldari) — reduces material waste on every manufacturing run, compounds over time</li>
                  <li><em>No decrypter</em> — cheapest option when you have high base probability and don't need the modifiers</li>
                </ul>
              </li>
              <li>
                <strong>Implants</strong> — the Beancounter BC-8xx series adds
                +1%–+4% flat invention probability.
              </li>
            </ul>
          </div>
        </div>
      )}

      {/* ── Input materials ── */}
      {node.inputs.length > 0 && (
        <div className="ndp-section">
          <div className="ndp-section-title">
            Materials ({node.inputs.length})
          </div>
          <div className="ndp-materials">
            {node.inputs.map((mat) => (
              <div key={mat.typeId} className="ndp-mat-row">
                <TypeIcon typeId={mat.typeId} variant="icon" size={32} displaySize={20} alt="" />
                <span className="ndp-mat-name">{mat.typeName}</span>
                <span className="ndp-mat-qty">{fmt(mat.quantityNeeded)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

    </div>
  );
}
