import type { BuildNode } from "../api";

export interface NodeCosts {
  /** Market cost to buy exactly `quantityNeeded` units of this item. */
  buyCost: number;
  /** Full build-path cost (all leaf materials + all job costs), normalized to `quantityNeeded` units. */
  buildCost: number;
  /**
   * buyCost − buildCost.
   * Positive  → building is cheaper (keep building).
   * Negative  → buying is cheaper  (consider switching to Buy).
   */
  delta: number;
}

/**
 * Compare buy vs build cost for a manufacturing or reaction node.
 *
 * Returns null when price data is missing for this item or any leaf buy input
 * — the comparison can't be made accurately without all prices.
 *
 * The node must come from the original solver tree (with `.inputs` populated),
 * not the flattened grid list where inputs are stripped.
 */
export function computeNodeCosts(
  node: BuildNode,
  getBestSell: (typeId: number) => number | null,
): NodeCosts | null {
  // We need the sell price of this item to know what "buying it" would cost.
  const selfPrice = getBestSell(node.typeId);
  if (selfPrice === null) return null;

  const rawBuildCost = sumBuildCost(node, getBestSell);
  if (rawBuildCost === null) return null;

  const buyCost = selfPrice * node.quantityNeeded;

  // Build path produces `quantityProduced` (may be more than `quantityNeeded` due to batch sizes).
  // Normalize to `quantityNeeded` so both sides are on the same unit basis.
  const buildCost =
    node.quantityProduced > 0
      ? (rawBuildCost / node.quantityProduced) * node.quantityNeeded
      : rawBuildCost;

  return { buyCost, buildCost, delta: buyCost - buildCost };
}

/**
 * Recursively sum the raw cost to produce a node via its current build path.
 *
 * - Buy node         → best_sell × quantityToBuy  (leaf cost)
 * - Build/react node → job cost + sum of all input costs
 * - Virtual hangar   → 0 (already in stock, no spend required)
 *
 * Returns null if any required price is missing.
 */
function sumBuildCost(
  node: BuildNode,
  getBestSell: (typeId: number) => number | null,
): number | null {
  if (node.kind.type === "buy") {
    if (node.quantityToBuy === 0) return 0; // fully covered by stock or hangar
    // Blueprint items (BPOs) are listed on the regular market at BPO prices, not BPC
    // prices. BPCs are sold via contracts which ESI doesn't expose. Excluding them from
    // BvB prevents wildly inflated cost comparisons from BPO market listings.
    if (node.typeName.toLowerCase().includes("blueprint")) return 0;
    const price = getBestSell(node.typeId);
    if (price === null) return null;
    return price * node.quantityToBuy;
  }

  if (node.kind.type === "virtualHangar") {
    return 0;
  }

  // Manufacturing, reaction, or invention: job cost + recursive input costs.
  let total = node.jobCost ?? 0;
  for (const input of node.inputs) {
    const inputCost = sumBuildCost(input, getBestSell);
    if (inputCost === null) return null;
    total += inputCost;
  }
  return total;
}
