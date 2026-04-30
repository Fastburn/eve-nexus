/**
 * TypeScript mirror of the Rust domain types from src-tauri/src/types/mod.rs.
 * All field names are camelCase to match the serde rename_all = "camelCase"
 * attributes on the Rust structs.
 */

// ── Primitive aliases ─────────────────────────────────────────────────────────

export type TypeId = number;
export type SolarSystemId = number;
/** EVE character IDs are currently ~90-100M — well within JS safe integer range. */
export type CharacterId = number;

// ── Enums ─────────────────────────────────────────────────────────────────────

/** Matches Rust ActivityId variants. */
export type ActivityId =
  | "Manufacturing"
  | "ResearchTime"
  | "ResearchMaterial"
  | "Copying"
  | "Invention"
  | "Reaction";

/** Solver sourcing decision for a node. */
export type Decision = "Build" | "Buy" | "UseHangar";

/** Which class of job a structure profile applies to. */
export type JobType = "Manufacturing" | "Reaction" | "Invention";

// ── Structure profiles ────────────────────────────────────────────────────────

export interface RigBonus {
  categoryId: number;
  meBonus: number;
  teBonus: number;
}

export interface StructureProfile {
  id: string;
  label: string;
  solarSystemId: SolarSystemId | null;
  jobType: JobType;
  facilityTax: number;
  spaceModifier: number;
  rigBonuses: RigBonus[];
}

// ── Type metadata ─────────────────────────────────────────────────────────────

export interface TypeSummary {
  typeId: TypeId;
  typeName: string;
  categoryId: number;
  volume: number;
}

// ── Build tree ────────────────────────────────────────────────────────────────

export interface MaterialLine {
  typeId: TypeId;
  typeName: string;
  quantityPerRun: number;
  quantityTotal: number;
  unitVolume: number;
}

export interface DecrypterInfo {
  typeId: TypeId;
  typeName: string;
  runModifier: number;
  meModifier: number;
  teModifier: number;
  probabilityMultiplier: number;
}

export interface InventionInfo {
  baseBlueprintTypeId: TypeId;
  probability: number;
  runsPerBpc: number;
  outputMe: number;
  outputTe: number;
  datacores: MaterialLine[];
  decrypter: DecrypterInfo | null;
}

/**
 * NodeKind is an internally-tagged union (serde tag = "type", rename_all =
 * "camelCase"). Variant names become camelCase: "manufacturing", "reaction", etc.
 */
export type NodeKind =
  | {
      type: "manufacturing";
      me: number;
      te: number;
      maxRuns: number | null;
      structureProfileId: string | null;
    }
  | { type: "reaction"; te: number; structureProfileId: string | null }
  | ({ type: "invention" } & InventionInfo)
  | { type: "buy" }
  | { type: "virtualHangar" };

export interface BuildNode {
  typeId: TypeId;
  typeName: string;
  kind: NodeKind;
  decision: Decision;
  runs: number;
  quantityProduced: number;
  quantityNeeded: number;
  quantityOnHand: number;
  quantityInProgress: number;
  quantityFromHangar: number;
  quantityToHangar: number;
  quantityToBuy: number;
  unitVolume: number;
  jobCost: number | null;
  inputs: BuildNode[];
}

// ── Solver request ────────────────────────────────────────────────────────────

export interface BuildTarget {
  typeId: TypeId;
  quantity: number;
  structureProfileId: string | null;
}

export interface SolvePlanRequest {
  targets: BuildTarget[];
  meLevels?: Record<TypeId, number>;
  teLevels?: Record<TypeId, number>;
  structureProfiles?: Record<string, StructureProfile>;
  manualDecisions?: Record<TypeId, Decision>;
  blacklist?: TypeId[];
}

// ── Production plans ──────────────────────────────────────────────────────────

export interface ProductionPlan {
  id: string;
  name: string;
  targets: BuildTarget[];
  createdAt: string;
  updatedAt: string;
  /** Per-plan overproduction multiplier. undefined = use global default. */
  overproductionMultiplier?: number;
  /** Per-plan freight cost ISK/m³. undefined = use global default. */
  freightIskPerM3?: number;
}

export interface PlanSummary {
  id: string;
  name: string;
  targetCount: number;
  updatedAt: string;
}

// ── Settings ──────────────────────────────────────────────────────────────────

export type AnalyticsConsent = "Pending" | "Granted" | "Denied";

// ── SDE ───────────────────────────────────────────────────────────────────────

export interface SdeStatus {
  available: boolean;
}

export interface SdeVersionInfo {
  buildNumber: number;
  releaseDate: string;
  importedAt: string;
}

/**
 * Emitted on "sde://result" after check_and_update completes.
 * Internally tagged with "status".
 */
export type SdeUpdateResult =
  | { status: "alreadyCurrent"; buildNumber: number }
  | { status: "updated"; buildNumber: number }
  | { status: "failed"; reason: string };

/** Emitted on "sde://progress" while the zip is downloading. */
export interface SdeDownloadProgress {
  bytesReceived: number;
  bytesTotal: number | null;
}

/** Emitted on "sde://import-progress" while tables are imported. */
export interface SdeImportProgress {
  table: string;
  tablesDone: number;
  tablesTotal: number;
}

// ── Characters ────────────────────────────────────────────────────────────────

export interface CharacterInfo {
  characterId: CharacterId;
  characterName: string;
  /** "personal" | "corp" | "both" */
  corpAssetsMode: string;
  /** True if Director role was confirmed on last sync. */
  hasCorpAccess: boolean;
}

// ── App updater ───────────────────────────────────────────────────────────────

export interface AppUpdateInfo {
  version: string;
  notes: string | null;
}

/** Emitted on "app-update://progress" while downloading an app update. */
export interface AppUpdateProgress {
  bytesReceived: number;
  bytesTotal: number | null;
}

// ── Settings panel helpers ────────────────────────────────────────────────────

export interface BlueprintOverrideEntry {
  typeId: TypeId;
  meLevel: number;
  teLevel: number;
}

export interface ManualDecisionEntry {
  typeId: TypeId;
  decision: Decision;
}

// ── Market ────────────────────────────────────────────────────────────────────

export interface StructureSearchResult {
  structureId: number;
  structureName: string;
}

export interface MarketRegion {
  id: string;
  label: string;
  /** EVE region ID for region hubs; structure ID for structure hubs. */
  regionId: number;
  isDefault: boolean;
  /** Set when this hub sources prices from a player-owned structure. */
  structureId?: number;
}

export interface MarketPriceEntry {
  regionId: number;
  typeId: TypeId;
  /** Lowest active sell order — what you pay to buy immediately. */
  bestSell: number | null;
  /** Highest active buy order — what you get selling immediately. */
  bestBuy: number | null;
  fetchedAt: string;
}

// ── System cost ───────────────────────────────────────────────────────────────

export interface WatchedSystem {
  systemId: number;
  systemName: string;
  /** Region ID used for market price fetching. null if region lookup failed. */
  regionId: number | null;
}

export interface SystemSearchResult {
  systemId: number;
  systemName: string;
}

export interface SystemCostInfo {
  systemId: number;
  systemName: string;
  /** null when the system has no recorded industry activity */
  manufacturing: number | null;
  reaction: number | null;
  invention: number | null;
}

export interface CheapestSystemEntry {
  systemId: number;
  systemName: string;
  costIndex: number;
}

// ── Blueprint browser ─────────────────────────────────────────────────────────

export interface IndustryCategory {
  categoryId: number;
  categoryName: string;
  blueprintCount: number;
}

export interface IndustryGroup {
  groupId: number;
  groupName: string;
  categoryId: number;
  blueprintCount: number;
}

/** Ownership of one blueprint type by one character. */
export interface BlueprintOwnership {
  blueprintTypeId: TypeId;
  characterId: CharacterId;
  characterName: string;
  /** -1 = BPO (unlimited); ≥ 0 = runs remaining on best BPC. */
  runs: number;
  meLevel: number;
  teLevel: number;
}

/** One row from the blueprint browser — SDE metadata + ownership overlay. */
export interface BlueprintEntry {
  blueprintTypeId: TypeId;
  blueprintName: string;
  productTypeId: TypeId;
  productName: string;
  groupId: number;
  groupName: string;
  categoryId: number;
  categoryName: string;
  /** 0 = unlimited (BPO type); otherwise max BPC runs. */
  maxProductionLimit: number;
  /** 1 = manufacturing, 11 = reaction. */
  activityId: number;
  /** Empty array means no character owns this blueprint. */
  ownership: BlueprintOwnership[];
}
