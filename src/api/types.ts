// Copyright (C) 2026 Eve Nexus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

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
  installedRigs: TypeId[];
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
  /** The decrypter the auto-pick would have chosen, even under an override. */
  bestDecrypterTypeId: TypeId | null;
  /** True if `decrypter` came from a user override rather than auto-pick. */
  isOverridden: boolean;
  /** ISK saved (per BPC) by using the applied choice instead of no decrypter. */
  iskSavedVsNoDecrypter: number;
  /** Runs already covered by owned BPC stock before this invention was planned. */
  runsFromStock: number;
}

/** A user-tracked stock of already-invented BPCs for one product type. */
export interface BpcStockEntry {
  meLevel: number;
  teLevel: number;
  runsRemaining: number;
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
  categoryId: number;
  groupId: number;
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
  decrypterChoices?: Record<TypeId, TypeId>;
  blacklist?: TypeId[];
}

// ── Decrypters ────────────────────────────────────────────────────────────────

export interface DecrypterChoiceEntry {
  typeId: TypeId;
  decrypterTypeId: TypeId;
}

/** Static identity and invention modifiers for one of the 8 T2 decrypters. */
export interface DecrypterSpecEntry {
  typeId: TypeId;
  name: string;
  runModifier: number;
  meModifier: number;
  teModifier: number;
  probabilityMultiplier: number;
}

/** Static identity, tier, and ME/TE bonus for one real structure rig. */
export interface RigSpecEntry {
  typeId: TypeId;
  name: string;
  tier: number;
  meBonus: number;
  teBonus: number;
  jobType: JobType;
  categoryNames: string[];
}

// ── Schedule ──────────────────────────────────────────────────────────────────

export interface ManufacturingJob {
  typeId: TypeId;
  typeName: string;
  runs: number;
  /** Effective time per run in seconds after TE, skill, and rig reductions. */
  timePerRunSeconds: number;
}

export interface InventionJob {
  typeId: TypeId;
  typeName: string;
  attempts: number;
  probability: number;
  /** Statistical expected BPCs = attempts × probability. */
  expectedBpcs: number;
  timePerAttemptSeconds: number;
}

export interface PlanSchedule {
  manufacturing: ManufacturingJob[];
  invention: InventionJob[];
  industrySlots: number;
  scienceSlots: number;
  /** Slot counts derived from the best character's skills. */
  derivedIndustrySlots: number;
  derivedScienceSlots: number;
  manufacturingWallClockSeconds: number;
  inventionWallClockSeconds: number;
  /** Critical path: max(invention, manufacturing) since they run concurrently. */
  criticalPathSeconds: number;
}

// ── Market history ────────────────────────────────────────────────────────────

export interface MarketHistoryEntry {
  regionId: number;
  typeId: TypeId;
  /** ISO date string: "YYYY-MM-DD" */
  date: string;
  average: number;
  highest: number | null;
  lowest: number | null;
  volume: number;
  orderCount: number;
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
  /** Marks this hub as the player's local market — no freight applies when buying here. */
  isLocal: boolean;
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
  /** 30-day adjusted average price from EVE's global market data. */
  adjusted30d: number | null;
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