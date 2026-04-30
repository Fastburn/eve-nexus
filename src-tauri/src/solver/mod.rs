//! Recursive BuildNode solver.
//!
//! Entry point: `solve(input)` — takes an immutable `SolverInput` snapshot and
//! returns one `BuildNode` tree per target. Pure logic — no I/O, no side effects.
//!
//! `commands/` is responsible for assembling the `SolverInput` (ESI data, SDE
//! blueprint map, virtual hangar, etc.) before calling `solve`.

mod cost;
mod invention;
mod node;

use std::collections::{HashMap, HashSet};

use crate::types::{BuildNode, SolverInput, TypeId};

pub use cost::{apply_me, get_rig_me, get_rig_te};

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

        Self {
            input,
            available_assets: input.assets.clone(),
            available_jobs,
            available_hangar: input.virtual_hangar.clone(),
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
        cost::{apply_me, eiv, get_rig_me, get_rig_te, job_cost},
        invention::{attempts_needed, calculate_probability},
        solve,
    };

    // ── Helpers ───────────────────────────────────────────────────────────────

    fn simple_summary(type_id: TypeId, name: &str) -> TypeSummary {
        TypeSummary { type_id, type_name: name.to_string(), category_id: 7, volume: 1.0 }
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
            adjusted_prices: HashMap::new(),
            cost_indices: HashMap::new(),
            structure_profiles: HashMap::new(),
            manual_decisions: HashMap::new(),
            blacklist: HashSet::new(),
            type_summaries: HashMap::new(),
            blueprints: HashMap::new(),
            me_levels: HashMap::new(),
            te_levels: HashMap::new(),
            character_skills: HashMap::new(),
        }
    }

    fn target(type_id: TypeId, quantity: u64) -> BuildTarget {
        BuildTarget { type_id, quantity, structure_profile_id: None }
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
        // floor(100 × 0.9 × 0.98) = floor(88.2) = 88
        assert_eq!(apply_me(100, 1, 10, 0.02), 88);
    }

    // ── rig bonus lookup ──────────────────────────────────────────────────────

    fn profile_with_rig(category_id: i32, me: f64, te: f64) -> StructureProfile {
        StructureProfile {
            id: "test".to_string(),
            label: "Test".to_string(),
            solar_system_id: None,
            job_type: crate::types::JobType::Manufacturing,
            facility_tax: 0.1,
            space_modifier: 1.0,
            rig_bonuses: vec![RigBonus { category_id, me_bonus: me, te_bonus: te }],
        }
    }

    #[test]
    fn rig_me_matching_category() {
        let p = profile_with_rig(7, 0.02, 0.20);
        assert!((get_rig_me(&p, 7) - 0.02).abs() < f64::EPSILON);
    }

    #[test]
    fn rig_me_no_match() {
        let p = profile_with_rig(7, 0.02, 0.20);
        assert_eq!(get_rig_me(&p, 99), 0.0);
    }

    #[test]
    fn rig_te_with_space_modifier() {
        let mut p = profile_with_rig(7, 0.02, 0.20);
        p.space_modifier = 2.1; // null sec
        // te = 0.20 × 2.1 = 0.42
        assert!((get_rig_te(&p, 7) - 0.42).abs() < 1e-10);
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
            space_modifier: 1.0,
            rig_bonuses: vec![],
        };
        input.structure_profiles.insert("p1".to_string(), profile);

        // eiv=10_000, index=0.05, tax=0.10 → 10000 × 0.05 × 1.10 = 550
        let result = job_cost(10_000.0, ActivityId::Manufacturing, Some(30000142), Some("p1"), &input);
        assert!((result.unwrap() - 550.0).abs() < 0.01);
    }

    #[test]
    fn job_cost_no_system_returns_none() {
        let input = empty_input(vec![]);
        assert!(job_cost(1000.0, ActivityId::Manufacturing, None, None, &input).is_none());
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
}
