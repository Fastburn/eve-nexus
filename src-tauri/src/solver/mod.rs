// Copyright (C) 2026 Eve Nexus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Recursive BuildNode solver.
//!
//! Entry point: `solve(input)` — takes an immutable `SolverInput` snapshot and
//! returns one `BuildNode` tree per target. Pure logic — no I/O, no side effects.
//!
//! `commands/` is responsible for assembling the `SolverInput` (ESI data, SDE
//! blueprint map, virtual hangar, etc.) before calling `solve`.

mod cost;
mod decrypters;
mod invention;
mod node;
pub mod rigs;
pub mod schedule;

use std::collections::{HashMap, HashSet};

use crate::types::{BuildNode, SolverInput, TypeId};

pub use cost::{apply_me, get_rig_me, get_rig_te, resolve_profile_id, structure_me, structure_te};
pub use decrypters::DecrypterSpec;
pub use rigs::RigSpec;
pub use schedule::compute_schedule;

/// The static table of all 8 T2 decrypters, for frontend display.
pub fn list_decrypters() -> &'static [DecrypterSpec] {
    decrypters::DECRYPTERS
}

/// The static table of all structure rigs, for frontend display.
pub fn list_rigs() -> &'static [RigSpec] {
    rigs::RIGS
}

// ─── Solver state ─────────────────────────────────────────────────────────────

/// Mutable state threaded through the recursive solve calls.
///
/// Initialized from `SolverInput` before the first `solve_node` call.
/// The stock maps are consumed as the tree is built so that on-hand quantities
/// are not double-counted across nodes.
pub(super) struct SolverState<'a> {
    pub input: &'a SolverInput,

    /// Remaining ESI asset quantities (consumed first-come-first-served).
    pub available_assets: HashMap<TypeId, u64>,
    /// Remaining in-progress job output quantities.
    pub available_jobs: HashMap<TypeId, u64>,
    /// Virtual hangar stock (supplemented by overbuild during the solve).
    pub available_hangar: HashMap<TypeId, u64>,
    /// Owned BPC runs remaining, consumed before planning fresh invention.
    pub available_bpc_runs: HashMap<TypeId, u64>,

    /// Types currently on the call stack — used to detect blueprint cycles.
    pub seen: HashSet<TypeId>,
}

impl<'a> SolverState<'a> {
    fn new(input: &'a SolverInput) -> Self {
        // Pre-aggregate active job output by product type.
        let mut available_jobs: HashMap<TypeId, u64> = HashMap::new();
        for job in &input.active_jobs {
            *available_jobs.entry(job.output_type_id).or_insert(0) += job.output_quantity;
        }

        let available_bpc_runs = input
            .bpc_inventory
            .iter()
            .map(|(id, e)| (*id, e.runs_remaining))
            .collect();

        Self {
            input,
            available_assets: input.assets.clone(),
            available_jobs,
            available_hangar: input.virtual_hangar.clone(),
            available_bpc_runs,
            seen: HashSet::new(),
        }
    }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/// Solve a complete production plan, returning one root `BuildNode` per target.
///
/// Stock (assets, jobs, hangar) is consumed across all targets in order, so the
/// order of `input.targets` matters when stock is limited.
pub fn solve(input: &SolverInput) -> Vec<BuildNode> {
    let mut state = SolverState::new(input);

    input
        .targets
        .iter()
        .map(|target| {
            node::solve_node(
                target.type_id,
                target.quantity,
                0,
                target.structure_profile_id.as_deref(),
                &mut state,
            )
        })
        .collect()
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use std::collections::{HashMap, HashSet};

    use crate::types::{
        ActivityId, BlueprintData, BuildTarget, CostIndex, Decision, NodeKind, RigBonus,
        SolverInput, StructureProfile, TypeId, TypeSummary,
    };

    use super::{
        cost::{apply_me, eiv, get_rig_me, get_rig_te, job_cost, resolve_profile_id, structure_me, structure_te},
        decrypters::DECRYPTERS,
        invention::{attempts_needed, calculate_probability, solve_invention_node},
        solve, SolverState,
    };

    // ── Helpers ───────────────────────────────────────────────────────────────

    fn simple_summary(type_id: TypeId, name: &str) -> TypeSummary {
        TypeSummary { type_id, type_name: name.to_string(), category_id: 7, group_id: 0, volume: 1.0 }
    }

    fn simple_blueprint(type_id: TypeId, materials: Vec<(TypeId, u64)>) -> BlueprintData {
        BlueprintData {
            blueprint_type_id: type_id + 1000,
            activity: ActivityId::Manufacturing,
            max_production_limit: 0,
            output_quantity: 1,
            time_seconds: 300,
            materials,
            invention: None,
        }
    }

    fn empty_input(targets: Vec<BuildTarget>) -> SolverInput {
        SolverInput {
            targets,
            assets: HashMap::new(),
            active_jobs: vec![],
            virtual_hangar: HashMap::new(),
            bpc_inventory: HashMap::new(),
            adjusted_prices: HashMap::new(),
            cost_indices: HashMap::new(),
            structure_profiles: HashMap::new(),
            manual_decisions: HashMap::new(),
            decrypter_choices: HashMap::new(),
            optimize_decrypters_for_time: false,
            blacklist: HashSet::new(),
            type_summaries: HashMap::new(),
            blueprints: HashMap::new(),
            me_levels: HashMap::new(),
            te_levels: HashMap::new(),
            character_skills: HashMap::new(),
            alpha_clone: false,
        }
    }

    fn target(type_id: TypeId, quantity: u64) -> BuildTarget {
        BuildTarget { type_id, quantity, structure_profile_id: None, stock_target_type_id: None }
    }

    // ── apply_me ──────────────────────────────────────────────────────────────

    #[test]
    fn apply_me_no_reduction() {
        // ME 0, no rig: raw quantity × runs
        assert_eq!(apply_me(10, 5, 0, 0.0), 50);
    }

    #[test]
    fn apply_me_full_me10() {
        // ME 10 → 10% reduction; 100 × 1 run × 0.9 = 90
        assert_eq!(apply_me(100, 1, 10, 0.0), 90);
    }

    #[test]
    fn apply_me_minimum_is_runs() {
        // qty_per_run=1, 10 runs, heavy ME → floor can't go below runs (10)
        assert_eq!(apply_me(1, 10, 10, 0.99), 10);
    }

    #[test]
    fn apply_me_with_rig() {
        // 100 qty, 1 run, ME 10 (0.9 factor), rig_me 0.02 (0.98 factor)
        // ceil(100 × 0.9 × 0.98) = ceil(88.2) = 89
        assert_eq!(apply_me(100, 1, 10, 0.02), 89);
    }

    #[test]
    fn apply_me_rounds_up() {
        // 1 per run × 3 runs at ME 10 = 2.7, which the game rounds up to 3.
        assert_eq!(apply_me(1, 3, 10, 0.0), 3);
        // 7 × 10 runs × 0.9 = 63 exactly; float noise must not push it to 64.
        assert_eq!(apply_me(7, 10, 10, 0.0), 63);
    }

    // ── rig bonus lookup ──────────────────────────────────────────────────────

    fn profile_with_rig(category_id: i32, me: f64, te: f64) -> StructureProfile {
        StructureProfile {
            id: "test".to_string(),
            label: "Test".to_string(),
            solar_system_id: None,
            job_type: crate::types::JobType::Manufacturing,
            facility_tax: 0.1,
            security: crate::types::SecurityClass::Highsec,
            hull: crate::types::StructureHull::None,
            rig_bonuses: vec![RigBonus { category_id, group_id: None, me_bonus: me, te_bonus: te }],
            installed_rigs: vec![],
        }
    }

    #[test]
    fn rig_me_matching_category() {
        let p = profile_with_rig(7, 0.02, 0.20);
        assert!((get_rig_me(&p, 7, 0) - 0.02).abs() < f64::EPSILON);
    }

    #[test]
    fn rig_me_no_match() {
        let p = profile_with_rig(7, 0.02, 0.20);
        assert_eq!(get_rig_me(&p, 99, 0), 0.0);
    }

    #[test]
    fn rig_te_with_space_modifier() {
        let mut p = profile_with_rig(7, 0.02, 0.20);
        p.security = crate::types::SecurityClass::Nullsec; // 2.1× for engineering rigs
        // te = 0.20 × 2.1 = 0.42
        assert!((get_rig_te(&p, 7, 0) - 0.42).abs() < 1e-10);
    }

    // ── eiv ───────────────────────────────────────────────────────────────────

    #[test]
    fn eiv_sum_of_prices() {
        let prices: HashMap<TypeId, f64> = [(1, 100.0), (2, 50.0)].into_iter().collect();
        // (1, 3 units) = 300; (2, 2 units) = 100; total = 400
        assert!((eiv(&[(1, 3), (2, 2)], &prices) - 400.0).abs() < f64::EPSILON);
    }

    #[test]
    fn eiv_missing_price_treated_as_zero() {
        let prices: HashMap<TypeId, f64> = [(1, 100.0)].into_iter().collect();
        // type 2 not in map → 0
        assert!((eiv(&[(1, 1), (2, 99)], &prices) - 100.0).abs() < f64::EPSILON);
    }

    // ── job_cost ─────────────────────────────────────────────────────────────

    #[test]
    fn job_cost_basic() {
        let mut input = empty_input(vec![]);
        input.cost_indices.insert(
            30000142,
            CostIndex { solar_system_id: 30000142, manufacturing: 0.05, reaction: 0.0, invention: 0.0 },
        );
        let profile = StructureProfile {
            id: "p1".to_string(),
            label: "P1".to_string(),
            solar_system_id: Some(30000142),
            job_type: crate::types::JobType::Manufacturing,
            facility_tax: 0.10,
            security: crate::types::SecurityClass::Highsec,
            hull: crate::types::StructureHull::None,
            rig_bonuses: vec![],
            installed_rigs: vec![],
        };
        input.structure_profiles.insert("p1".to_string(), profile);

        // eiv=10_000, index=0.05, tax=0.10, SCC 0.04 → 10000 × (0.05 + 0.10 + 0.04) = 1900
        let result = job_cost(10_000.0, ActivityId::Manufacturing, Some(30000142), Some("p1"), &input);
        assert!((result.unwrap() - 1900.0).abs() < 0.01);
    }

    #[test]
    fn job_cost_applies_structure_bonus() {
        let mut input = empty_input(vec![]);
        input.cost_indices.insert(
            30000142,
            CostIndex { solar_system_id: 30000142, manufacturing: 0.05, reaction: 0.0, invention: 0.0 },
        );
        let mut p = profile(crate::types::JobType::Manufacturing);
        p.id = "sotiyo".to_string();
        p.hull = crate::types::StructureHull::Sotiyo;
        input.structure_profiles.insert("sotiyo".to_string(), p.clone());

        // Hull bonus discounts only the index part:
        // 10000 × (0.05 × 0.95 + 0.10 + 0.04) = 1875
        let result = job_cost(10_000.0, ActivityId::Manufacturing, Some(30000142), Some("sotiyo"), &input);
        assert!((result.unwrap() - 1875.0).abs() < 0.01);

        // Refineries get no job cost bonus.
        p.hull = crate::types::StructureHull::Tatara;
        input.structure_profiles.insert("sotiyo".to_string(), p);
        let result = job_cost(10_000.0, ActivityId::Manufacturing, Some(30000142), Some("sotiyo"), &input);
        assert!((result.unwrap() - 1900.0).abs() < 0.01);
    }

    #[test]
    fn job_cost_missing_profile_uses_npc_tax() {
        let mut input = empty_input(vec![]);
        input.cost_indices.insert(
            30000142,
            CostIndex { solar_system_id: 30000142, manufacturing: 0.05, reaction: 0.0, invention: 0.0 },
        );
        // 10000 × (0.05 + 0.0025 + 0.04) = 925
        let result = job_cost(10_000.0, ActivityId::Manufacturing, Some(30000142), Some("gone"), &input);
        assert!((result.unwrap() - 925.0).abs() < 0.01);
    }

    #[test]
    fn hull_and_rig_bonuses_stack_multiplicatively() {
        use crate::types::{JobType, SecurityClass, StructureHull};
        let mut p = profile_with_rig(6, 0.02, 0.20);
        p.hull = StructureHull::Sotiyo;
        p.security = SecurityClass::Nullsec;
        // ME: 1 − 0.99 × (1 − 0.042) = 0.05158
        assert!((structure_me(&p, 6, 0) - 0.05158).abs() < 1e-9);
        // TE: 1 − 0.70 × (1 − 0.42) = 0.594
        assert!((structure_te(&p, 6, 0) - 0.594).abs() < 1e-9);
        // Hull bonus applies even with no matching rig.
        assert!((structure_me(&p, 99, 0) - 0.01).abs() < 1e-9);

        // Tatara: reaction time only, no material bonus.
        let mut t = profile(JobType::Reaction);
        t.hull = StructureHull::Tatara;
        assert_eq!(structure_me(&t, 4, 0), 0.0);
        assert!((structure_te(&t, 4, 0) - 0.25).abs() < 1e-9);
    }

    #[test]
    fn group_limited_rig_only_matches_its_group() {
        let mut p = profile_with_rig(4, 0.02, 0.0);
        p.job_type = crate::types::JobType::Reaction;
        p.rig_bonuses[0].group_id = Some(429); // Composite
        assert!((get_rig_me(&p, 4, 429) - 0.02).abs() < 1e-9);
        assert_eq!(get_rig_me(&p, 4, 974), 0.0); // Hybrid Polymers
    }

    #[test]
    fn reactor_rigs_use_reaction_security_multiplier() {
        let mut p = profile_with_rig(4, 0.02, 0.20);
        p.job_type = crate::types::JobType::Reaction;
        p.security = crate::types::SecurityClass::Nullsec;
        // Reactor rigs: 1.1× in null, not the 2.1× engineering value.
        assert!((get_rig_me(&p, 4, 0) - 0.022).abs() < 1e-10);
    }

    #[test]
    fn legacy_space_modifier_migrates_to_security_class() {
        use crate::types::SecurityClass;
        let parse = |job: &str, m: f64| -> SecurityClass {
            let json = format!(
                r#"{{"id":"x","label":"x","solarSystemId":null,"jobType":"{job}","facilityTax":0.1,"spaceModifier":{m},"rigBonuses":[],"installedRigs":[]}}"#
            );
            serde_json::from_str::<StructureProfile>(&json).unwrap().security
        };
        assert_eq!(parse("Manufacturing", 2.1), SecurityClass::Nullsec);
        assert_eq!(parse("Manufacturing", 1.9), SecurityClass::Lowsec);
        assert_eq!(parse("Manufacturing", 1.0), SecurityClass::Highsec);
        // Old UI told users to enter 0.75 for a Sotiyo's job cost: not a rig value.
        assert_eq!(parse("Manufacturing", 0.75), SecurityClass::Highsec);
        assert_eq!(parse("Reaction", 1.1), SecurityClass::Nullsec);

        // Round-trip keeps the new fields and drops the legacy one.
        let p: StructureProfile = serde_json::from_str(
            r#"{"id":"x","label":"x","solarSystemId":null,"jobType":"Manufacturing","facilityTax":0.1,"security":"Lowsec","hull":"Azbel","rigBonuses":[],"installedRigs":[]}"#,
        ).unwrap();
        let out = serde_json::to_string(&p).unwrap();
        assert!(out.contains(r#""security":"Lowsec""#) && out.contains(r#""hull":"Azbel""#));
        assert!(!out.contains("spaceModifier"));
    }

    #[test]
    fn job_cost_no_system_returns_none() {
        let input = empty_input(vec![]);
        assert!(job_cost(1000.0, ActivityId::Manufacturing, None, None, &input).is_none());
    }

    // ── structure profile resolution ──────────────────────────────────────────

    fn profile(job_type: crate::types::JobType) -> StructureProfile {
        StructureProfile {
            id: "unused".to_string(),
            label: "Unused".to_string(),
            solar_system_id: None,
            job_type,
            facility_tax: 0.10,
            security: crate::types::SecurityClass::Highsec,
            hull: crate::types::StructureHull::None,
            rig_bonuses: vec![],
            installed_rigs: vec![],
        }
    }

    #[test]
    fn resolve_profile_preferred_matches_job_type() {
        use crate::types::JobType;
        let mut profiles = HashMap::new();
        profiles.insert("mfg".to_string(), profile(JobType::Manufacturing));
        let resolved = resolve_profile_id(Some("mfg"), JobType::Manufacturing, &profiles);
        assert_eq!(resolved, Some("mfg"));
    }

    #[test]
    fn resolve_profile_falls_back_to_unambiguous_match() {
        use crate::types::JobType;
        let mut profiles = HashMap::new();
        profiles.insert("mfg".to_string(), profile(JobType::Manufacturing));
        profiles.insert("react".to_string(), profile(JobType::Reaction));
        // The inherited target profile is Manufacturing, but this node is a
        // Reaction — should auto-resolve to the one Reaction profile instead.
        let resolved = resolve_profile_id(Some("mfg"), JobType::Reaction, &profiles);
        assert_eq!(resolved, Some("react"));
    }

    #[test]
    fn resolve_profile_ambiguous_returns_none() {
        use crate::types::JobType;
        let mut profiles = HashMap::new();
        profiles.insert("mfg1".to_string(), profile(JobType::Manufacturing));
        profiles.insert("mfg2".to_string(), profile(JobType::Manufacturing));
        // Two Manufacturing profiles, no preferred one matches — can't guess.
        let resolved = resolve_profile_id(None, JobType::Manufacturing, &profiles);
        assert_eq!(resolved, None);
    }

    #[test]
    fn resolve_profile_no_match_returns_none() {
        use crate::types::JobType;
        let mut profiles = HashMap::new();
        profiles.insert("mfg".to_string(), profile(JobType::Manufacturing));
        let resolved = resolve_profile_id(None, JobType::Invention, &profiles);
        assert_eq!(resolved, None);
    }

    // ── invention probability ─────────────────────────────────────────────────

    #[test]
    fn probability_no_skills_no_decrypter() {
        use crate::types::InventionBlueprint;
        let inv_bp = InventionBlueprint {
            t1_blueprint_type_id: 1,
            base_probability: 0.40,
            output_runs: 10,
            output_me: 2,
            output_te: 4,
            time_seconds: 1200,
            datacores: vec![],
            relevant_skill_ids: vec![],
        };
        let skills = HashMap::new();
        // No skills, multiplier 1.0 → result = 0.40
        let p = calculate_probability(0.40, &inv_bp, &skills, 1.0);
        assert!((p - 0.40).abs() < 1e-10);
    }

    #[test]
    fn probability_with_enc_skill_5() {
        use crate::types::InventionBlueprint;
        let inv_bp = InventionBlueprint {
            t1_blueprint_type_id: 1,
            base_probability: 0.40,
            output_runs: 10,
            output_me: 2,
            output_te: 4,
            time_seconds: 1200,
            datacores: vec![],
            relevant_skill_ids: vec![10000], // enc skill id
        };
        let skills: HashMap<TypeId, u8> = [(10000, 5)].into_iter().collect();
        // 0.40 × (1 + 0.01 × 5) × (1 + 0) × 1.0 = 0.40 × 1.05 = 0.42
        let p = calculate_probability(0.40, &inv_bp, &skills, 1.0);
        assert!((p - 0.42).abs() < 1e-10);
    }

    #[test]
    fn attempts_needed_ceil() {
        // 3 BPCs at 40% → ceil(3/0.4) = ceil(7.5) = 8
        assert_eq!(attempts_needed(3, 0.40), 8);
    }

    #[test]
    fn attempts_needed_zero_probability() {
        assert_eq!(attempts_needed(1, 0.0), u32::MAX);
    }

    // ── solve: leaf / buy node ────────────────────────────────────────────────

    #[test]
    fn solve_no_blueprint_produces_buy_node() {
        let mut input = empty_input(vec![target(100, 10)]);
        input.type_summaries.insert(100, simple_summary(100, "Iron Ore"));

        let nodes = solve(&input);
        assert_eq!(nodes.len(), 1);
        assert!(matches!(nodes[0].kind, NodeKind::Buy));
        assert_eq!(nodes[0].quantity_to_buy, 10);
        assert_eq!(nodes[0].quantity_needed, 10);
    }

    // ── solve: simple manufacturing ───────────────────────────────────────────

    #[test]
    fn solve_simple_manufacturing() {
        // Product 200 made from material 201 (5 per run).
        let mut input = empty_input(vec![target(200, 10)]);
        input.type_summaries.insert(200, simple_summary(200, "Widget"));
        input.type_summaries.insert(201, simple_summary(201, "Iron"));
        input.blueprints.insert(200, simple_blueprint(200, vec![(201, 5)]));

        let nodes = solve(&input);
        assert_eq!(nodes.len(), 1);
        let root = &nodes[0];
        assert!(matches!(root.kind, NodeKind::Manufacturing { .. }));
        assert_eq!(root.runs, 10);
        assert_eq!(root.quantity_produced, 10);
        assert_eq!(root.inputs.len(), 1);

        let mat = &root.inputs[0];
        assert_eq!(mat.type_id, 201);
        // ME 10 on 5 × 10 runs = floor(50 × 0.9) = 45; but minimum is runs (10), so 45
        assert_eq!(mat.quantity_needed, 45);
        assert_eq!(mat.quantity_to_buy, 45);
    }

    #[test]
    fn solve_job_cost_uses_base_materials_and_alpha_tax() {
        // 10 runs × 5 units at ME 10 consumes 45, but EIV uses the ME 0 base of 50.
        let mut input = empty_input(vec![target(200, 10)]);
        input.type_summaries.insert(200, simple_summary(200, "Widget"));
        input.type_summaries.insert(201, simple_summary(201, "Iron"));
        input.blueprints.insert(200, simple_blueprint(200, vec![(201, 5)]));
        input.adjusted_prices.insert(201, 100.0);
        input.cost_indices.insert(
            30000142,
            CostIndex { solar_system_id: 30000142, manufacturing: 0.05, reaction: 0.0, invention: 0.0 },
        );
        let mut p = profile(crate::types::JobType::Manufacturing);
        p.id = "p".to_string();
        p.solar_system_id = Some(30000142);
        p.facility_tax = 0.0;
        input.structure_profiles.insert("p".to_string(), p);

        // EIV 5000 × (0.05 + 0 + 0.04 SCC) = 450
        let root = &solve(&input)[0];
        assert_eq!(root.inputs[0].quantity_needed, 45);
        assert!((root.job_cost.unwrap() - 450.0).abs() < 0.01);

        // Alpha clone adds 0.25% of EIV: 450 + 12.5
        input.alpha_clone = true;
        let root = &solve(&input)[0];
        assert!((root.job_cost.unwrap() - 462.5).abs() < 0.01);
    }

    // ── solve: assets reduce to-buy ───────────────────────────────────────────

    #[test]
    fn solve_assets_reduce_to_buy() {
        let mut input = empty_input(vec![target(200, 10)]);
        input.type_summaries.insert(200, simple_summary(200, "Widget"));
        input.type_summaries.insert(201, simple_summary(201, "Iron"));
        input.blueprints.insert(200, simple_blueprint(200, vec![(201, 10)]));
        // We have 30 units of material 201 in assets.
        input.assets.insert(201, 30);

        let nodes = solve(&input);
        let mat = &nodes[0].inputs[0];
        // ME 10: floor(100 × 0.9) = 90 needed. on_hand = 30, to_buy = 60.
        assert_eq!(mat.quantity_on_hand, 30);
        assert_eq!(mat.quantity_to_buy, 60);
    }

    // ── solve: overbuild goes to hangar ───────────────────────────────────────

    #[test]
    fn solve_overbuild_deposited_to_hangar() {
        // Product 200 has output_qty = 5 per run (e.g. ammo).
        let mut input = empty_input(vec![target(200, 7)]);
        input.type_summaries.insert(200, simple_summary(200, "Ammo"));
        input.blueprints.insert(
            200,
            BlueprintData {
                blueprint_type_id: 1200,
                activity: ActivityId::Manufacturing,
                max_production_limit: 0,
                output_quantity: 5, // 5 ammo per run
                time_seconds: 60,
                materials: vec![],
                invention: None,
            },
        );

        let nodes = solve(&input);
        let root = &nodes[0];
        // Need 7, output_qty=5 → ceil(7/5)=2 runs → 10 produced → 3 to hangar
        assert_eq!(root.runs, 2);
        assert_eq!(root.quantity_produced, 10);
        assert_eq!(root.quantity_to_hangar, 3);
    }

    // ── solve: virtual hangar consumed ────────────────────────────────────────

    #[test]
    fn solve_hangar_stock_consumed_before_buy() {
        let mut input = empty_input(vec![target(100, 10)]);
        input.type_summaries.insert(100, simple_summary(100, "Gizmo"));
        // No blueprint → buy node. Hangar has 6 units.
        input.virtual_hangar.insert(100, 6);

        let nodes = solve(&input);
        assert_eq!(nodes[0].quantity_from_hangar, 6);
        assert_eq!(nodes[0].quantity_to_buy, 4);
    }

    // ── solve: blacklisted type is bought ─────────────────────────────────────

    #[test]
    fn solve_blacklist_forces_buy() {
        let mut input = empty_input(vec![target(200, 5)]);
        input.type_summaries.insert(200, simple_summary(200, "Restricted"));
        input.blueprints.insert(200, simple_blueprint(200, vec![]));
        input.blacklist.insert(200);

        let nodes = solve(&input);
        // Has a blueprint but is blacklisted → must be a buy node.
        assert!(matches!(nodes[0].kind, NodeKind::Buy));
        assert_eq!(nodes[0].quantity_to_buy, 5);
    }

    // ── solve: manual decision Buy overrides blueprint ────────────────────────

    #[test]
    fn solve_manual_buy_overrides_blueprint() {
        let mut input = empty_input(vec![target(200, 5)]);
        input.type_summaries.insert(200, simple_summary(200, "Override"));
        input.blueprints.insert(200, simple_blueprint(200, vec![]));
        input.manual_decisions.insert(200, Decision::Buy);

        let nodes = solve(&input);
        assert!(matches!(nodes[0].kind, NodeKind::Buy));
    }

    // ── solve: multi-target stock not double-counted ──────────────────────────

    #[test]
    fn solve_multi_target_stock_shared() {
        // Two targets each wanting 5 units of type 100, assets = 8.
        let targets = vec![target(100, 5), target(100, 5)];
        let mut input = empty_input(targets);
        input.type_summaries.insert(100, simple_summary(100, "Shared"));
        input.assets.insert(100, 8);

        let nodes = solve(&input);
        // First target: on_hand=5 (takes all 5 it needs), to_buy=0.
        assert_eq!(nodes[0].quantity_on_hand, 5);
        assert_eq!(nodes[0].quantity_to_buy, 0);
        // Second target: only 3 left, to_buy=2.
        assert_eq!(nodes[1].quantity_on_hand, 3);
        assert_eq!(nodes[1].quantity_to_buy, 2);
    }

    // ── decrypter selection ───────────────────────────────────────────────────

    fn t2_inv_bp(datacores: Vec<(TypeId, u64)>) -> crate::types::InventionBlueprint {
        crate::types::InventionBlueprint {
            t1_blueprint_type_id: 1,
            base_probability: 0.40,
            output_runs: 1,
            output_me: 2,
            output_te: 4,
            time_seconds: 1200,
            datacores,
            relevant_skill_ids: vec![],
        }
    }

    /// Sets every decrypter's adjusted price to a prohibitively high value
    /// except `cheap_type_id`, which is priced at 1.0 — makes the auto-pick
    /// outcome deterministic regardless of each candidate's attempt count.
    fn price_all_decrypters_except(input: &mut SolverInput, cheap_type_id: TypeId) {
        for spec in DECRYPTERS {
            input.adjusted_prices.insert(spec.type_id, 999_999.0);
        }
        input.adjusted_prices.insert(cheap_type_id, 1.0);
    }

    #[test]
    fn invention_autopick_chooses_cheapest_decrypter() {
        let inv_bp = t2_inv_bp(vec![(50, 1)]);
        let mut input = empty_input(vec![]);
        input.adjusted_prices.insert(50, 10.0);
        price_all_decrypters_except(&mut input, 34207);

        let summary = simple_summary(300, "T2 Widget");
        let mut state = SolverState::new(&input);
        let (node, _, _) = solve_invention_node(&inv_bp, 1, &summary, None, &[], 0.0, None, 0, &mut state, 0);
        match &node.kind {
            NodeKind::Invention(info) => {
                assert_eq!(info.decrypter.as_ref().map(|d| d.type_id), Some(34207));
                assert!(!info.is_overridden);
                assert_eq!(info.best_decrypter_type_id, Some(34207));
            }
            _ => panic!("expected invention node"),
        }
    }

    #[test]
    fn invention_autopick_weighs_downstream_material_cost() {
        // Process Decryptor (34205): run_mod 0, me_mod +3, prob_mult 1.1 — costs a
        // little more upfront (decrypter + slightly more attempts, wash) but yields
        // a better-ME BPC, which should win once the material bill it saves on every
        // manufacturing run is factored in.
        let inv_bp = t2_inv_bp(vec![(50, 1)]);
        let mut input = empty_input(vec![]);
        input.adjusted_prices.insert(50, 10.0); // datacore
        input.adjusted_prices.insert(60, 1.0); // product material
        price_all_decrypters_except(&mut input, 34205);
        input.adjusted_prices.insert(34205, 1.0); // cheap, not "free"

        let summary = simple_summary(300, "T2 Widget");
        let product_materials = vec![(60, 1000)];

        // Without material cost in the comparison, "none" would win (it's strictly
        // cheaper on invention-phase cost alone: no decrypter to buy).
        let mut state_no_materials = SolverState::new(&input);
        let (node_no_materials, _, _) =
            solve_invention_node(&inv_bp, 1, &summary, None, &[], 0.0, None, 0, &mut state_no_materials, 0);
        match &node_no_materials.kind {
            NodeKind::Invention(info) => assert!(info.best_decrypter_type_id.is_none()),
            _ => panic!("expected invention node"),
        }

        // With the downstream material bill included, the better-ME decrypter wins:
        // it saves more material cost than it costs to buy.
        let mut state_with_materials = SolverState::new(&input);
        let (node_with_materials, _, _) = solve_invention_node(
            &inv_bp, 1, &summary, None, &product_materials, 0.0, None, 0, &mut state_with_materials, 0,
        );
        match &node_with_materials.kind {
            NodeKind::Invention(info) => {
                assert_eq!(info.best_decrypter_type_id, Some(34205));
            }
            _ => panic!("expected invention node"),
        }
    }

    #[test]
    fn invention_autopick_time_mode_ignores_price() {
        // Every decrypter priced prohibitively — cost mode must fall back to "none".
        let inv_bp = t2_inv_bp(vec![(50, 1)]);
        let mut input = empty_input(vec![]);
        input.adjusted_prices.insert(50, 10.0);
        price_all_decrypters_except(&mut input, 999_999); // no real decrypter is "cheap"

        // A slow product blueprint (1000s/run × 100 runs) so a decrypter's TE/run
        // modifiers move the needle on total job time even though every decrypter
        // is priced far above what any ISK-based comparison would ever pick.
        input.blueprints.insert(
            300,
            crate::types::BlueprintData {
                blueprint_type_id: 3000,
                activity: crate::types::ActivityId::Manufacturing,
                max_production_limit: 0,
                output_quantity: 1,
                time_seconds: 1000,
                materials: vec![],
                invention: None,
            },
        );

        let summary = simple_summary(300, "T2 Widget");

        let mut state_cost = SolverState::new(&input);
        let (node_cost, _, _) =
            solve_invention_node(&inv_bp, 100, &summary, None, &[], 0.0, None, 0, &mut state_cost, 0);

        let mut input_time = input.clone();
        input_time.optimize_decrypters_for_time = true;
        let mut state_time = SolverState::new(&input_time);
        let (node_time, _, _) =
            solve_invention_node(&inv_bp, 100, &summary, None, &[], 0.0, None, 0, &mut state_time, 0);

        match (&node_cost.kind, &node_time.kind) {
            (NodeKind::Invention(cost_info), NodeKind::Invention(time_info)) => {
                assert!(cost_info.best_decrypter_type_id.is_none(), "cost mode should avoid every priced-out decrypter");
                assert!(time_info.best_decrypter_type_id.is_some(), "time mode should pick a decrypter purely on job time, ignoring its price");
            }
            _ => panic!("expected invention nodes"),
        }
    }

    #[test]
    fn invention_autopick_ties_favor_none() {
        // No adjusted_prices at all → every candidate (including "none") costs 0.
        let inv_bp = t2_inv_bp(vec![]);
        let input = empty_input(vec![]);
        let summary = simple_summary(300, "T2 Widget");
        let mut state = SolverState::new(&input);
        let (node, _, _) = solve_invention_node(&inv_bp, 1, &summary, None, &[], 0.0, None, 0, &mut state, 0);
        match &node.kind {
            NodeKind::Invention(info) => {
                assert!(info.decrypter.is_none());
                assert!(info.best_decrypter_type_id.is_none());
            }
            _ => panic!("expected invention node"),
        }
    }

    #[test]
    fn invention_override_wins_over_autopick() {
        let inv_bp = t2_inv_bp(vec![(50, 1)]);
        let mut input = empty_input(vec![]);
        input.adjusted_prices.insert(50, 10.0);
        // 34207 would win auto-pick, but we override with 34201 anyway.
        price_all_decrypters_except(&mut input, 34207);

        let summary = simple_summary(300, "T2 Widget");
        let mut state = SolverState::new(&input);
        let (node, _, _) = solve_invention_node(&inv_bp, 1, &summary, Some(34201), &[], 0.0, None, 0, &mut state, 0);
        match &node.kind {
            NodeKind::Invention(info) => {
                assert_eq!(info.decrypter.as_ref().map(|d| d.type_id), Some(34201));
                assert!(info.is_overridden);
                // The auto-pick result is still surfaced, for the UI's "best" hint.
                assert_eq!(info.best_decrypter_type_id, Some(34207));
            }
            _ => panic!("expected invention node"),
        }
    }

    #[test]
    fn invention_me_te_clamped_to_valid_range() {
        let mut inv_bp = t2_inv_bp(vec![]);
        inv_bp.output_me = 9;
        inv_bp.output_te = 1;
        let input = empty_input(vec![]);
        let summary = simple_summary(300, "T2 Widget");

        // Optimized Augmentation (34208): me_mod +2 → would be 11, clamps to 10.
        let mut state = SolverState::new(&input);
        let (_, me, _) = solve_invention_node(&inv_bp, 1, &summary, Some(34208), &[], 0.0, None, 0, &mut state, 0);
        assert_eq!(me, 10);

        // Parity (34204): te_mod -2 → would be -1, clamps to 0.
        let mut state2 = SolverState::new(&input);
        let (_, _, te) = solve_invention_node(&inv_bp, 1, &summary, Some(34204), &[], 0.0, None, 0, &mut state2, 0);
        assert_eq!(te, 0);
    }

    #[test]
    fn invention_positive_run_modifier_reduces_attempts() {
        let inv_bp = t2_inv_bp(vec![]);
        let input = empty_input(vec![]);
        let summary = simple_summary(300, "T2 Widget");

        // No decrypter: bpcs_needed = ceil(10/1) = 10; attempts = ceil(10/0.4) = 25.
        let mut state_none = SolverState::new(&input);
        let (node_none, _, _) = solve_invention_node(&inv_bp, 10, &summary, None, &[], 0.0, None, 0, &mut state_none, 0);
        assert_eq!(node_none.quantity_needed, 10);
        assert_eq!(node_none.runs, 25);

        // Attainment (34202): run_mod +4 → effective_runs=5, bpcs_needed=ceil(10/5)=2;
        // prob_mult 1.8 → probability=0.72, attempts=ceil(2/0.72)=3.
        let mut state_dec = SolverState::new(&input);
        let (node_dec, _, _) = solve_invention_node(&inv_bp, 10, &summary, Some(34202), &[], 0.0, None, 0, &mut state_dec, 0);
        assert_eq!(node_dec.quantity_needed, 2);
        assert_eq!(node_dec.runs, 3);
    }

    #[test]
    fn solve_invented_item_uses_effective_me_te_not_global_default() {
        let mut input = empty_input(vec![target(300, 1)]);
        input.type_summaries.insert(300, simple_summary(300, "T2 Widget"));
        input.type_summaries.insert(310, simple_summary(310, "Mineral"));
        // Global ME default the ordering bug used to leak into invented items.
        input.me_levels.insert(300, 10);
        input.blueprints.insert(
            300,
            BlueprintData {
                blueprint_type_id: 1300,
                activity: ActivityId::Manufacturing,
                max_production_limit: 0,
                output_quantity: 1,
                time_seconds: 600,
                materials: vec![(310, 100)],
                invention: Some(t2_inv_bp(vec![])),
            },
        );

        let nodes = solve(&input);
        let root = &nodes[0];
        match root.kind {
            NodeKind::Manufacturing { me, te, .. } => {
                // Effective ME/TE from the invention (base 2/4, no decrypter) —
                // NOT the global blueprint_overrides default of 10/20.
                assert_eq!(me, 2);
                assert_eq!(te, 4);
            }
            _ => panic!("expected manufacturing node"),
        }
        let mat = root.inputs.iter().find(|n| n.type_id == 310).unwrap();
        // ME2: floor(100 × 1 run × 0.98) = 98 (vs. 90 if the ME10 default leaked in).
        assert_eq!(mat.quantity_needed, 98);
    }

    // ── per-node structure profile auto-resolution ────────────────────────────

    #[test]
    fn solve_reaction_submaterial_auto_resolves_reaction_profile() {
        // Mirrors a real beta report: a Manufacturing target assigned to one
        // profile, whose materials are built via a Reaction blueprint that has
        // its own dedicated (but never manually assigned) structure profile.
        // Before this fix, the Reaction node blindly inherited the Manufacturing
        // profile's id, found no matching profile, and reported a null job
        // cost. It should now auto-resolve to the one configured Reaction
        // profile and get a real job cost.
        let mut input = empty_input(vec![BuildTarget {
            type_id: 200,
            quantity: 1,
            structure_profile_id: Some("mfg".to_string()),
            stock_target_type_id: None,
        }]);
        input.type_summaries.insert(200, simple_summary(200, "T2 Widget"));
        input.type_summaries.insert(201, simple_summary(201, "Fuel Block"));
        input.blueprints.insert(200, simple_blueprint(200, vec![(201, 5)]));
        input.blueprints.insert(
            201,
            BlueprintData {
                blueprint_type_id: 1201,
                activity: ActivityId::Reaction,
                max_production_limit: 0,
                output_quantity: 1,
                time_seconds: 300,
                materials: vec![],
                invention: None,
            },
        );

        input.structure_profiles.insert(
            "mfg".to_string(),
            StructureProfile {
                id: "mfg".to_string(),
                label: "Equipment T2".to_string(),
                solar_system_id: Some(30000142),
                job_type: crate::types::JobType::Manufacturing,
                facility_tax: 0.005,
                security: crate::types::SecurityClass::Highsec,
            hull: crate::types::StructureHull::None,
                rig_bonuses: vec![],
                installed_rigs: vec![],
            },
        );
        input.structure_profiles.insert(
            "react".to_string(),
            StructureProfile {
                id: "react".to_string(),
                label: "T2 Reprocessing".to_string(),
                solar_system_id: Some(30000144),
                job_type: crate::types::JobType::Reaction,
                facility_tax: 0.005,
                security: crate::types::SecurityClass::Highsec,
            hull: crate::types::StructureHull::None,
                rig_bonuses: vec![],
                installed_rigs: vec![],
            },
        );
        input.cost_indices.insert(
            30000142,
            CostIndex { solar_system_id: 30000142, manufacturing: 0.05, reaction: 0.0, invention: 0.0 },
        );
        input.cost_indices.insert(
            30000144,
            CostIndex { solar_system_id: 30000144, manufacturing: 0.0, reaction: 0.02, invention: 0.0 },
        );

        let nodes = solve(&input);
        let root = &nodes[0];
        assert!(root.job_cost.is_some(), "root manufacturing job cost should resolve via the assigned profile");

        let reaction_node = root.inputs.iter().find(|n| n.type_id == 201).unwrap();
        assert!(matches!(reaction_node.kind, NodeKind::Reaction { .. }));
        assert!(
            reaction_node.job_cost.is_some(),
            "reaction sub-node should auto-resolve the dedicated Reaction profile instead of inheriting the Manufacturing one"
        );
        if let NodeKind::Reaction { structure_profile_id, .. } = &reaction_node.kind {
            assert_eq!(structure_profile_id.as_deref(), Some("react"));
        }
    }

    // ── BPC inventory ─────────────────────────────────────────────────────────

    fn invented_widget_input(target_qty: u64) -> SolverInput {
        let mut input = empty_input(vec![target(300, target_qty)]);
        input.type_summaries.insert(300, simple_summary(300, "T2 Widget"));
        input.blueprints.insert(
            300,
            BlueprintData {
                blueprint_type_id: 1300,
                activity: ActivityId::Manufacturing,
                max_production_limit: 0,
                output_quantity: 1,
                time_seconds: 600,
                materials: vec![],
                invention: Some(t2_inv_bp(vec![])),
            },
        );
        input
    }

    #[test]
    fn bpc_stock_full_coverage_skips_invention() {
        let mut input = invented_widget_input(1);
        input.bpc_inventory.insert(
            300,
            crate::types::BpcStockEntry { me_level: 5, te_level: 10, runs_remaining: 1 },
        );

        let nodes = solve(&input);
        let root = &nodes[0];
        match root.kind {
            NodeKind::Manufacturing { me, te, .. } => {
                assert_eq!(me, 5);
                assert_eq!(te, 10);
            }
            _ => panic!("expected manufacturing node"),
        }
        assert!(root.inputs.iter().all(|n| !matches!(n.kind, NodeKind::Invention(_))));
    }

    #[test]
    fn bpc_stock_partial_coverage_reduces_invention() {
        let mut input = invented_widget_input(10);
        input.bpc_inventory.insert(
            300,
            crate::types::BpcStockEntry { me_level: 5, te_level: 10, runs_remaining: 4 },
        );
        let control = invented_widget_input(10);

        let nodes = solve(&input);
        let control_nodes = solve(&control);

        let inv_node = nodes[0].inputs.iter().find(|n| matches!(n.kind, NodeKind::Invention(_)))
            .expect("expected invention node for the uncovered shortfall");
        let control_node = control_nodes[0].inputs.iter().find(|n| matches!(n.kind, NodeKind::Invention(_)))
            .expect("expected invention node in the no-stock control");

        match &inv_node.kind {
            NodeKind::Invention(info) => assert_eq!(info.runs_from_stock, 4),
            _ => unreachable!(),
        }
        // Only 6 runs (10 needed - 4 from stock) require fresh invention, so
        // fewer BPCs are needed than the no-stock control's full 10.
        assert!(inv_node.quantity_needed < control_node.quantity_needed);
    }

    #[test]
    fn bpc_stock_absent_matches_today_behavior() {
        let input = invented_widget_input(1);
        let nodes = solve(&input);
        let root = &nodes[0];
        let inv = root.inputs.iter().find_map(|n| match &n.kind {
            NodeKind::Invention(info) => Some(info),
            _ => None,
        }).expect("expected invention node");
        assert_eq!(inv.runs_from_stock, 0);
    }

    // ── reactions ─────────────────────────────────────────────────────────────

    /// Widget 200 needs 5 × Fuel Block 201, which is reacted from 10 × 202 per run.
    fn reaction_input() -> SolverInput {
        let mut input = empty_input(vec![target(200, 1)]);
        input.type_summaries.insert(200, simple_summary(200, "Widget"));
        input.type_summaries.insert(201, simple_summary(201, "Fuel Block"));
        input.type_summaries.insert(202, simple_summary(202, "Gas"));
        input.blueprints.insert(200, simple_blueprint(200, vec![(201, 5)]));
        input.blueprints.insert(
            201,
            BlueprintData {
                blueprint_type_id: 1201,
                activity: ActivityId::Reaction,
                max_production_limit: 0,
                output_quantity: 1,
                time_seconds: 1000,
                materials: vec![(202, 10)],
                invention: None,
            },
        );
        input
    }

    #[test]
    fn reaction_ignores_default_me() {
        let input = reaction_input();
        let root = &solve(&input)[0];
        let reaction = root.inputs.iter().find(|n| n.type_id == 201).unwrap();
        assert!(matches!(reaction.kind, NodeKind::Reaction { te: 0, .. }));
        // 5 runs × 10 gas, no ME reduction
        assert_eq!(reaction.inputs[0].quantity_needed, 50);
    }

    // ── invention job cost and time ───────────────────────────────────────────

    #[test]
    fn invention_charges_job_cost_and_applies_time_bonuses() {
        let mut input = invented_widget_input(1);
        input.blueprints.get_mut(&300).unwrap().materials = vec![(301, 10)];
        input.type_summaries.insert(301, simple_summary(301, "Iron"));
        input.adjusted_prices.insert(301, 100.0);
        for spec in DECRYPTERS {
            input.adjusted_prices.insert(spec.type_id, 999_999.0);
        }
        input.cost_indices.insert(
            30000142,
            CostIndex { solar_system_id: 30000142, manufacturing: 0.0, reaction: 0.0, invention: 0.05 },
        );
        let mut p = profile(crate::types::JobType::Invention);
        p.id = "inv".to_string();
        p.solar_system_id = Some(30000142);
        p.facility_tax = 0.0;
        p.hull = crate::types::StructureHull::Raitaru;
        input.structure_profiles.insert("inv".to_string(), p);
        input.character_skills.insert(3388, 5); // Advanced Industry V

        let root = &solve(&input)[0];
        let inv = root.inputs.iter().find(|n| matches!(n.kind, NodeKind::Invention(_))).unwrap();
        // EIV 1000 × 2% = 20, × (0.05 × (1 − 0.03 Raitaru) + 0.04 SCC) = 1.77 per attempt
        let per_attempt = 20.0 * (0.05 * 0.97 + 0.04);
        assert!(inv.runs > 0);
        assert!((inv.job_cost.unwrap() - per_attempt * inv.runs as f64).abs() < 1e-6);
        let NodeKind::Invention(info) = &inv.kind else { unreachable!() };
        // 1200s × (1 − 0.15 Advanced Industry) × (1 − 0.15 Raitaru) = 867
        assert_eq!(info.time_per_attempt_seconds, 867);
    }
}
