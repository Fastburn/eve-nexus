use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

// ─── Primitive aliases ───────────────────────────────────────────────────────

/// EVE type ID (`invTypes.typeID` in the SDE)
pub type TypeId = i32;

/// Solar system ID
pub type SolarSystemId = i32;

/// EVE character ID
pub type CharacterId = i64;

// ─── Industry activity ───────────────────────────────────────────────────────

/// Industry activity IDs as defined in the SDE `industryActivities` table.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[repr(u8)]
pub enum ActivityId {
    Manufacturing = 1,
    ResearchTime = 3,
    ResearchMaterial = 4,
    Copying = 5,
    Invention = 8,
    Reaction = 11,
}

// ─── Node kind ───────────────────────────────────────────────────────────────

/// The industry activity (or sourcing method) that produces this node.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum NodeKind {
    /// T1 / T2 / T3 manufacturing (activityID = 1).
    Manufacturing {
        me: u8,
        te: u8,
        /// `None` = BPO (unlimited runs); `Some(n)` = BPC with n runs remaining.
        max_runs: Option<u32>,
        structure_profile_id: Option<String>,
    },
    /// Refinery reaction (activityID = 11).
    Reaction {
        te: u8,
        structure_profile_id: Option<String>,
    },
    /// T2 invention step (activityID = 8).
    /// Appears as its own node in the graph, parent of the Manufacturing node
    /// that consumes the resulting BPC.
    Invention(InventionInfo),
    /// Purchased from the market — leaf node.
    Buy,
    /// Taken from virtual hangar stock — leaf node.
    VirtualHangar,
}

// ─── Invention ───────────────────────────────────────────────────────────────

/// Everything the solver needs to model a T2 invention chain.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InventionInfo {
    /// T1 blueprint (BPC) consumed per attempt.
    pub base_blueprint_type_id: TypeId,
    /// Final success probability after encryption skill + datacore skills + decrypter.
    /// probability = base × (1 + 0.01 × enc_skill) × (1 + 0.1 × Σ(datacore_skill / 30)) × decrypter_mult
    pub probability: f64,
    /// Max runs on the output BPC (base + decrypter run modifier).
    pub runs_per_bpc: u32,
    /// ME on the output BPC (base 2, adjusted by decrypter).
    pub output_me: u8,
    /// TE on the output BPC (base 4, adjusted by decrypter).
    pub output_te: u8,
    /// Datacores consumed per attempt (always exactly two types for T2).
    pub datacores: Vec<MaterialLine>,
    /// Optional decrypter used.
    pub decrypter: Option<DecrypterInfo>,
}

/// A decrypter item and its per-stat modifiers.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecrypterInfo {
    pub type_id: TypeId,
    pub type_name: String,
    /// Added to the output BPC's max runs.
    pub run_modifier: i32,
    /// Added to the output BPC's ME level.
    pub me_modifier: i32,
    /// Added to the output BPC's TE level.
    pub te_modifier: i32,
    /// Multiplied against the base invention probability.
    pub probability_multiplier: f64,
}

// ─── Decision ────────────────────────────────────────────────────────────────

/// The solver's sourcing decision for a node.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Decision {
    /// Produce via industry.
    Build,
    /// Purchase from the market.
    Buy,
    /// Consume from virtual hangar stock.
    UseHangar,
}

// ─── Material line ───────────────────────────────────────────────────────────

/// One row in a bill of materials.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaterialLine {
    pub type_id: TypeId,
    pub type_name: String,
    /// Quantity required per single run (before ME reduction).
    pub quantity_per_run: u64,
    /// Total quantity required across all runs (after ME + batch math).
    pub quantity_total: u64,
    /// m³ per unit (from SDE `invTypes.volume`).
    pub unit_volume: f64,
}

// ─── Structure profiles ───────────────────────────────────────────────────────

/// Which class of industry job a structure profile applies to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum JobType {
    Manufacturing,
    Reaction,
    Invention,
}

/// ME/TE rig bonus for a specific SDE category.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RigBonus {
    /// `invCategories.categoryID` this rig applies to.
    pub category_id: i32,
    /// Material efficiency reduction as a fraction (e.g. `0.02` = 2% fewer materials).
    pub me_bonus: f64,
    /// Time efficiency reduction as a fraction (e.g. `0.20` = 20% faster jobs).
    pub te_bonus: f64,
}

/// User-configured structure (or NPC station) used for production.
///
/// ESI does not expose rig loadouts for structures the user doesn't own, so
/// manual config is the primary path. The "Import from ESI" convenience flow
/// is an optional shortcut for own-corp structures.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StructureProfile {
    /// Stable local ID (UUID string).
    pub id: String,
    pub label: String,
    pub solar_system_id: Option<SolarSystemId>,
    pub job_type: JobType,
    /// Facility tax as a fraction (e.g. `0.10` = 10%).
    pub facility_tax: f64,
    /// Multiplied against rig ME/TE bonus magnitudes.
    /// ~1.0 highsec, ~1.9 lowsec, ~2.1 null/WH.
    pub space_modifier: f64,
    /// Per-category rig bonuses installed in this structure.
    pub rig_bonuses: Vec<RigBonus>,
}

// ─── Build tree ──────────────────────────────────────────────────────────────

/// One node in the recursive production plan tree.
///
/// The solver produces a root `BuildNode` per target item. Child nodes in
/// `inputs` represent the materials required to produce this node.
///
/// Quantity accounting follows the AGENTS.md rule:
/// `to_buy = max(0, needed − on_hand − in_progress − from_hangar)`
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildNode {
    pub type_id: TypeId,
    pub type_name: String,
    pub kind: NodeKind,
    pub decision: Decision,

    // ── Production counts ────────────────────────────────────────────────────

    /// Number of industry runs scheduled.
    pub runs: u32,
    /// Total units produced (`runs × output_qty`), including any overbuild.
    pub quantity_produced: u64,
    /// Units required by the parent node (or the plan target if root).
    pub quantity_needed: u64,

    // ── Sourcing breakdown ───────────────────────────────────────────────────

    /// Units already in asset hangars (from ESI).
    pub quantity_on_hand: u64,
    /// Units currently being produced in active industry jobs (from ESI).
    pub quantity_in_progress: u64,
    /// Units allocated from the virtual hangar.
    pub quantity_from_hangar: u64,
    /// Overbuild surplus being deposited into the virtual hangar.
    pub quantity_to_hangar: u64,
    /// Units to purchase from the market.
    pub quantity_to_buy: u64,

    // ── Economics ────────────────────────────────────────────────────────────

    /// m³ per unit (from SDE `invTypes.volume`). Used for freight cost calculations.
    pub unit_volume: f64,

    /// `EIV × system_cost_index × (1 + facility_tax)`.
    /// `None` for Buy and VirtualHangar nodes.
    pub job_cost: Option<f64>,

    // ── Children ─────────────────────────────────────────────────────────────

    /// Material inputs required to produce this node.
    pub inputs: Vec<BuildNode>,
}

// ─── SDE snapshot types (pre-fetched by commands/ before calling the solver) ──

/// Lightweight type summary the solver uses for names, volumes, and category
/// lookups (e.g. to find the right rig ME bonus).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TypeSummary {
    pub type_id: TypeId,
    pub type_name: String,
    pub category_id: i32,
    pub volume: f64,
}

/// All blueprint data the solver needs for one product, pre-fetched from the
/// SDE by `commands/`. Keyed by *product* `TypeId` in `SolverInput.blueprints`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlueprintData {
    /// The blueprint item itself (BPO or BPC).
    pub blueprint_type_id: TypeId,
    pub activity: ActivityId,
    /// `0` = BPO (unlimited runs); `> 0` = max runs per BPC.
    pub max_production_limit: u32,
    /// Units produced per single run.
    pub output_quantity: u64,
    /// Base job duration in seconds (before TE reduction).
    pub time_seconds: u32,
    /// `(material_type_id, quantity_per_run)` — before ME reduction.
    pub materials: Vec<(TypeId, u64)>,
    /// `Some` for T2/T3 items that are produced via invention.
    pub invention: Option<InventionBlueprint>,
}

/// Invention parameters for a T2/T3 blueprint, embedded in `BlueprintData`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InventionBlueprint {
    /// T1 blueprint consumed as input to the invention job (one BPC copy).
    pub t1_blueprint_type_id: TypeId,
    /// Base success probability from the SDE (before skill/decrypter modifiers).
    pub base_probability: f64,
    /// Max runs on the output BPC before any decrypter modifier.
    pub output_runs: u32,
    /// ME on the output BPC before any decrypter modifier (usually 2).
    pub output_me: u8,
    /// TE on the output BPC before any decrypter modifier (usually 4).
    pub output_te: u8,
    /// `(datacore_type_id, quantity_per_attempt)` — always two entries for T2.
    pub datacores: Vec<(TypeId, u64)>,
    /// `[encryption_skill_id, datacore_skill_1_id, datacore_skill_2_id]`
    /// Used to compute the final probability from character skills.
    pub relevant_skill_ids: Vec<TypeId>,
}

// ─── Solver input snapshot ───────────────────────────────────────────────────

/// One item the user wants to produce.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildTarget {
    pub type_id: TypeId,
    pub quantity: u64,
    /// Which structure profile to use for the top-level job.
    /// Child nodes inherit this unless overridden.
    pub structure_profile_id: Option<String>,
}

/// An active or recently delivered ESI industry job.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EsiJob {
    pub job_id: i64,
    pub blueprint_type_id: TypeId,
    pub output_type_id: TypeId,
    pub activity_id: ActivityId,
    pub runs: u32,
    pub output_quantity: u64,
    pub end_date: DateTime<Utc>,
}

/// Industry cost indices for one solar system (from ESI `/industry/systems/`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CostIndex {
    pub solar_system_id: SolarSystemId,
    pub manufacturing: f64,
    pub reaction: f64,
    pub invention: f64,
}

/// Complete, immutable snapshot of all external data the solver needs.
///
/// Assembled by `commands/` from db/esi/hangar before calling the solver.
/// The solver is pure — it reads this struct and produces a `BuildNode` tree
/// with no I/O or side effects.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SolverInput {
    pub targets: Vec<BuildTarget>,
    /// ESI character assets: `type_id → quantity`.
    pub assets: HashMap<TypeId, u64>,
    /// Active (and recently completed) industry jobs.
    pub active_jobs: Vec<EsiJob>,
    /// Virtual hangar stock: `type_id → quantity`.
    pub virtual_hangar: HashMap<TypeId, u64>,
    /// ESI adjusted prices for EIV calculation: `type_id → isk`.
    pub adjusted_prices: HashMap<TypeId, f64>,
    /// System cost indices: `solar_system_id → CostIndex`.
    pub cost_indices: HashMap<SolarSystemId, CostIndex>,
    /// User-configured structure profiles: `profile_id → StructureProfile`.
    pub structure_profiles: HashMap<String, StructureProfile>,
    /// Manual build/buy overrides: `type_id → Decision`.
    pub manual_decisions: HashMap<TypeId, Decision>,
    /// Types the solver must never build — always sourced by buying.
    pub blacklist: HashSet<TypeId>,

    // ── SDE data pre-fetched by commands/ ────────────────────────────────────

    /// Type metadata for every type the solver may encounter.
    /// `commands/` populates this via a BFS of the blueprint tree before
    /// calling `solve()`.
    pub type_summaries: HashMap<TypeId, TypeSummary>,
    /// Blueprint data keyed by *product* `TypeId`.
    pub blueprints: HashMap<TypeId, BlueprintData>,

    // ── Blueprint research levels (user-configured) ───────────────────────────

    /// ME level per product type (0–10). Defaults to `10` if absent.
    pub me_levels: HashMap<TypeId, u8>,
    /// TE level per product type (0–20). Defaults to `20` if absent.
    pub te_levels: HashMap<TypeId, u8>,

    // ── Character skills (for invention probability) ──────────────────────────

    /// `skill_type_id → level` from ESI character skills.
    pub character_skills: HashMap<TypeId, u8>,
}
