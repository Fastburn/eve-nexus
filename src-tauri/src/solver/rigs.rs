// Copyright (C) 2026 Eve Nexus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Static structure rig data (verified against EVE Ref / everef.net).
//!
//! Rigs are fitted to a structure independent of any specific build, so this
//! table intentionally keeps the same coarse SDE-category granularity the app
//! already used for manual rig entry (all ships share one "Ship" bucket, not
//! split by hull size) — several distinctly-named real rigs below (e.g. Basic
//! Small/Medium/Large Ship ME I) resolve to the same category bonus. Their
//! base percentages are uniform across every manufacturing/reaction category
//! (Mk I = 2% ME / 20% TE, Mk II = 2.4% ME / 24% TE) — confirmed by
//! cross-checking Advanced Component, Basic Large Ship, and Hybrid Reactor
//! rigs, which all report identical base values before the structure's
//! security-space multiplier.
//!
//! Not modeled: Thukker faction rigs (non-uniform multiplier profile plus a
//! secondary sub-bonus) and Invention/Research Accelerator & Cost
//! Optimization rigs (this app already treats invention job time as
//! unaffected by skills or rigs — see `InventionInfo::time_per_attempt_seconds`).
//!
//! `category_names` are resolved against the live SDE category list at solve
//! time (`expand_installed_rigs`), not hardcoded IDs — a name with no match
//! in the current SDE simply contributes nothing, it never errors.

use std::collections::HashMap;

use crate::types::{JobType, RigBonus, TypeId};

/// One real structure rig's identity, tier, and ME/TE bonus magnitude.
#[derive(Debug, Clone, Copy)]
pub struct RigSpec {
    pub type_id: TypeId,
    pub name: &'static str,
    /// 1 = Mk I, 2 = Mk II. Display metadata only — `me_bonus`/`te_bonus`
    /// already hold the resolved fraction.
    pub tier: u8,
    /// Material reduction fraction (e.g. `0.02` = 2% fewer materials). `0.0`
    /// for TE-only rigs.
    pub me_bonus: f64,
    /// Job time reduction fraction (e.g. `0.20` = 20% faster jobs). `0.0`
    /// for ME-only rigs.
    pub te_bonus: f64,
    pub job_type: JobType,
    /// SDE category names this rig's bonus applies to.
    pub category_names: &'static [&'static str],
}

const SHIP: &[&str] = &["Ship"];
const CHARGE: &[&str] = &["Charge"];
const COMMODITY: &[&str] = &["Commodity"];
const DRONE_FIGHTER: &[&str] = &["Drone", "Fighter"];
const EQUIPMENT: &[&str] = &["Module", "Deployable", "Implant"];
// "Material" here is fuel blocks, the only Manufacturing-activity product in
// that SDE category — confirmed against EVE Ref's own description of this
// rig, which explicitly lists fuel blocks alongside structure components/
// modules/hulls.
const STRUCTURE: &[&str] = &["Structure", "Structure Module", "Material"];
const REACTION: &[&str] = &["Material"];

pub const RIGS: &[RigSpec] = &[
    // ── Advanced Component ──────────────────────────────────────────────────
    RigSpec { type_id: 43867, name: "Standup M-Set Advanced Component Manufacturing Material Efficiency I", tier: 1, me_bonus: 0.02, te_bonus: 0.0, job_type: JobType::Manufacturing, category_names: COMMODITY },
    RigSpec { type_id: 43866, name: "Standup M-Set Advanced Component Manufacturing Material Efficiency II", tier: 2, me_bonus: 0.024, te_bonus: 0.0, job_type: JobType::Manufacturing, category_names: COMMODITY },
    RigSpec { type_id: 43869, name: "Standup M-Set Advanced Component Manufacturing Time Efficiency I", tier: 1, me_bonus: 0.0, te_bonus: 0.20, job_type: JobType::Manufacturing, category_names: COMMODITY },
    RigSpec { type_id: 43868, name: "Standup M-Set Advanced Component Manufacturing Time Efficiency II", tier: 2, me_bonus: 0.0, te_bonus: 0.24, job_type: JobType::Manufacturing, category_names: COMMODITY },

    // ── Advanced Large Ship ──────────────────────────────────────────────────
    RigSpec { type_id: 43862, name: "Standup M-Set Advanced Large Ship Manufacturing Material Efficiency I", tier: 1, me_bonus: 0.02, te_bonus: 0.0, job_type: JobType::Manufacturing, category_names: SHIP },
    RigSpec { type_id: 43863, name: "Standup M-Set Advanced Large Ship Manufacturing Material Efficiency II", tier: 2, me_bonus: 0.024, te_bonus: 0.0, job_type: JobType::Manufacturing, category_names: SHIP },
    RigSpec { type_id: 43865, name: "Standup M-Set Advanced Large Ship Manufacturing Time Efficiency I", tier: 1, me_bonus: 0.0, te_bonus: 0.20, job_type: JobType::Manufacturing, category_names: SHIP },
    RigSpec { type_id: 43864, name: "Standup M-Set Advanced Large Ship Manufacturing Time Efficiency II", tier: 2, me_bonus: 0.0, te_bonus: 0.24, job_type: JobType::Manufacturing, category_names: SHIP },

    // ── Advanced Medium Ship ─────────────────────────────────────────────────
    RigSpec { type_id: 43858, name: "Standup M-Set Advanced Medium Ship Manufacturing Material Efficiency I", tier: 1, me_bonus: 0.02, te_bonus: 0.0, job_type: JobType::Manufacturing, category_names: SHIP },
    RigSpec { type_id: 43859, name: "Standup M-Set Advanced Medium Ship Manufacturing Material Efficiency II", tier: 2, me_bonus: 0.024, te_bonus: 0.0, job_type: JobType::Manufacturing, category_names: SHIP },
    RigSpec { type_id: 43860, name: "Standup M-Set Advanced Medium Ship Manufacturing Time Efficiency I", tier: 1, me_bonus: 0.0, te_bonus: 0.20, job_type: JobType::Manufacturing, category_names: SHIP },
    RigSpec { type_id: 43861, name: "Standup M-Set Advanced Medium Ship Manufacturing Time Efficiency II", tier: 2, me_bonus: 0.0, te_bonus: 0.24, job_type: JobType::Manufacturing, category_names: SHIP },

    // ── Advanced Small Ship ──────────────────────────────────────────────────
    RigSpec { type_id: 43855, name: "Standup M-Set Advanced Small Ship Manufacturing Material Efficiency I", tier: 1, me_bonus: 0.02, te_bonus: 0.0, job_type: JobType::Manufacturing, category_names: SHIP },
    RigSpec { type_id: 43854, name: "Standup M-Set Advanced Small Ship Manufacturing Material Efficiency II", tier: 2, me_bonus: 0.024, te_bonus: 0.0, job_type: JobType::Manufacturing, category_names: SHIP },
    RigSpec { type_id: 43856, name: "Standup M-Set Advanced Small Ship Manufacturing Time Efficiency I", tier: 1, me_bonus: 0.0, te_bonus: 0.20, job_type: JobType::Manufacturing, category_names: SHIP },
    RigSpec { type_id: 43857, name: "Standup M-Set Advanced Small Ship Manufacturing Time Efficiency II", tier: 2, me_bonus: 0.0, te_bonus: 0.24, job_type: JobType::Manufacturing, category_names: SHIP },

    // ── Ammunition ───────────────────────────────────────────────────────────
    RigSpec { type_id: 37158, name: "Standup M-Set Ammunition Manufacturing Material Efficiency I", tier: 1, me_bonus: 0.02, te_bonus: 0.0, job_type: JobType::Manufacturing, category_names: CHARGE },
    RigSpec { type_id: 37159, name: "Standup M-Set Ammunition Manufacturing Material Efficiency II", tier: 2, me_bonus: 0.024, te_bonus: 0.0, job_type: JobType::Manufacturing, category_names: CHARGE },
    RigSpec { type_id: 37150, name: "Standup M-Set Ammunition Manufacturing Time Efficiency I", tier: 1, me_bonus: 0.0, te_bonus: 0.20, job_type: JobType::Manufacturing, category_names: CHARGE },
    RigSpec { type_id: 37151, name: "Standup M-Set Ammunition Manufacturing Time Efficiency II", tier: 2, me_bonus: 0.0, te_bonus: 0.24, job_type: JobType::Manufacturing, category_names: CHARGE },

    // ── Basic Capital Component ─────────────────────────────────────────────
    RigSpec { type_id: 43870, name: "Standup M-Set Basic Capital Component Manufacturing Material Efficiency I", tier: 1, me_bonus: 0.02, te_bonus: 0.0, job_type: JobType::Manufacturing, category_names: COMMODITY },
    RigSpec { type_id: 43871, name: "Standup M-Set Basic Capital Component Manufacturing Material Efficiency II", tier: 2, me_bonus: 0.024, te_bonus: 0.0, job_type: JobType::Manufacturing, category_names: COMMODITY },
    RigSpec { type_id: 43872, name: "Standup M-Set Basic Capital Component Manufacturing Time Efficiency I", tier: 1, me_bonus: 0.0, te_bonus: 0.20, job_type: JobType::Manufacturing, category_names: COMMODITY },
    RigSpec { type_id: 43873, name: "Standup M-Set Basic Capital Component Manufacturing Time Efficiency II", tier: 2, me_bonus: 0.0, te_bonus: 0.24, job_type: JobType::Manufacturing, category_names: COMMODITY },

    // ── Basic Large Ship ─────────────────────────────────────────────────────
    RigSpec { type_id: 43732, name: "Standup M-Set Basic Large Ship Manufacturing Material Efficiency I", tier: 1, me_bonus: 0.02, te_bonus: 0.0, job_type: JobType::Manufacturing, category_names: SHIP },
    RigSpec { type_id: 37152, name: "Standup M-Set Basic Large Ship Manufacturing Material Efficiency II", tier: 2, me_bonus: 0.024, te_bonus: 0.0, job_type: JobType::Manufacturing, category_names: SHIP },
    RigSpec { type_id: 43733, name: "Standup M-Set Basic Large Ship Manufacturing Time Efficiency I", tier: 1, me_bonus: 0.0, te_bonus: 0.20, job_type: JobType::Manufacturing, category_names: SHIP },
    RigSpec { type_id: 43734, name: "Standup M-Set Basic Large Ship Manufacturing Time Efficiency II", tier: 2, me_bonus: 0.0, te_bonus: 0.24, job_type: JobType::Manufacturing, category_names: SHIP },

    // ── Basic Medium Ship ────────────────────────────────────────────────────
    RigSpec { type_id: 37146, name: "Standup M-Set Basic Medium Ship Manufacturing Material Efficiency I", tier: 1, me_bonus: 0.02, te_bonus: 0.0, job_type: JobType::Manufacturing, category_names: SHIP },
    RigSpec { type_id: 37147, name: "Standup M-Set Basic Medium Ship Manufacturing Material Efficiency II", tier: 2, me_bonus: 0.024, te_bonus: 0.0, job_type: JobType::Manufacturing, category_names: SHIP },
    RigSpec { type_id: 43919, name: "Standup M-Set Basic Medium Ship Manufacturing Time Efficiency I", tier: 1, me_bonus: 0.0, te_bonus: 0.20, job_type: JobType::Manufacturing, category_names: SHIP },
    RigSpec { type_id: 37153, name: "Standup M-Set Basic Medium Ship Manufacturing Time Efficiency II", tier: 2, me_bonus: 0.0, te_bonus: 0.24, job_type: JobType::Manufacturing, category_names: SHIP },

    // ── Basic Small Ship ─────────────────────────────────────────────────────
    RigSpec { type_id: 37154, name: "Standup M-Set Basic Small Ship Manufacturing Material Efficiency I", tier: 1, me_bonus: 0.02, te_bonus: 0.0, job_type: JobType::Manufacturing, category_names: SHIP },
    RigSpec { type_id: 37155, name: "Standup M-Set Basic Small Ship Manufacturing Material Efficiency II", tier: 2, me_bonus: 0.024, te_bonus: 0.0, job_type: JobType::Manufacturing, category_names: SHIP },
    RigSpec { type_id: 37162, name: "Standup M-Set Basic Small Ship Manufacturing Time Efficiency I", tier: 1, me_bonus: 0.0, te_bonus: 0.20, job_type: JobType::Manufacturing, category_names: SHIP },
    RigSpec { type_id: 37163, name: "Standup M-Set Basic Small Ship Manufacturing Time Efficiency II", tier: 2, me_bonus: 0.0, te_bonus: 0.24, job_type: JobType::Manufacturing, category_names: SHIP },

    // ── Drone and Fighter ────────────────────────────────────────────────────
    RigSpec { type_id: 37156, name: "Standup M-Set Drone and Fighter Manufacturing Material Efficiency I", tier: 1, me_bonus: 0.02, te_bonus: 0.0, job_type: JobType::Manufacturing, category_names: DRONE_FIGHTER },
    RigSpec { type_id: 37157, name: "Standup M-Set Drone and Fighter Manufacturing Material Efficiency II", tier: 2, me_bonus: 0.024, te_bonus: 0.0, job_type: JobType::Manufacturing, category_names: DRONE_FIGHTER },
    RigSpec { type_id: 37148, name: "Standup M-Set Drone and Fighter Manufacturing Time Efficiency I", tier: 1, me_bonus: 0.0, te_bonus: 0.20, job_type: JobType::Manufacturing, category_names: DRONE_FIGHTER },
    RigSpec { type_id: 37149, name: "Standup M-Set Drone and Fighter Manufacturing Time Efficiency II", tier: 2, me_bonus: 0.0, te_bonus: 0.24, job_type: JobType::Manufacturing, category_names: DRONE_FIGHTER },

    // ── Equipment (modules, deployables, implants) ──────────────────────────
    RigSpec { type_id: 43920, name: "Standup M-Set Equipment Manufacturing Material Efficiency I", tier: 1, me_bonus: 0.02, te_bonus: 0.0, job_type: JobType::Manufacturing, category_names: EQUIPMENT },
    RigSpec { type_id: 43921, name: "Standup M-Set Equipment Manufacturing Material Efficiency II", tier: 2, me_bonus: 0.024, te_bonus: 0.0, job_type: JobType::Manufacturing, category_names: EQUIPMENT },
    RigSpec { type_id: 37160, name: "Standup M-Set Equipment Manufacturing Time Efficiency I", tier: 1, me_bonus: 0.0, te_bonus: 0.20, job_type: JobType::Manufacturing, category_names: EQUIPMENT },
    RigSpec { type_id: 37161, name: "Standup M-Set Equipment Manufacturing Time Efficiency II", tier: 2, me_bonus: 0.0, te_bonus: 0.24, job_type: JobType::Manufacturing, category_names: EQUIPMENT },

    // ── Structure (components, modules, rigs, Upwell hulls, and fuel blocks —
    // fuel blocks fall in the "Material" SDE category, see STRUCTURE const) ─
    RigSpec { type_id: 43875, name: "Standup M-Set Structure Manufacturing Material Efficiency I", tier: 1, me_bonus: 0.02, te_bonus: 0.0, job_type: JobType::Manufacturing, category_names: STRUCTURE },
    RigSpec { type_id: 43874, name: "Standup M-Set Structure Manufacturing Material Efficiency II", tier: 2, me_bonus: 0.024, te_bonus: 0.0, job_type: JobType::Manufacturing, category_names: STRUCTURE },
    RigSpec { type_id: 43876, name: "Standup M-Set Structure Manufacturing Time Efficiency I", tier: 1, me_bonus: 0.0, te_bonus: 0.20, job_type: JobType::Manufacturing, category_names: STRUCTURE },
    RigSpec { type_id: 43877, name: "Standup M-Set Structure Manufacturing Time Efficiency II", tier: 2, me_bonus: 0.0, te_bonus: 0.24, job_type: JobType::Manufacturing, category_names: STRUCTURE },

    // ── Reaction (Composite / Hybrid / Biochemical, combined ME+TE) ────────
    RigSpec { type_id: 46496, name: "Standup L-Set Reactor Efficiency I", tier: 1, me_bonus: 0.02, te_bonus: 0.20, job_type: JobType::Reaction, category_names: REACTION },
    RigSpec { type_id: 46497, name: "Standup L-Set Reactor Efficiency II", tier: 2, me_bonus: 0.024, te_bonus: 0.24, job_type: JobType::Reaction, category_names: REACTION },
];

/// The static table of all structure rigs, for frontend display.
pub fn list_rigs() -> &'static [RigSpec] {
    RIGS
}

/// Expand a structure's installed rig type IDs into per-category `RigBonus`
/// rows. `category_ids_by_name` maps live SDE category names (from
/// `get_industry_categories`) to their numeric IDs — a `RigSpec` category
/// name with no match contributes nothing rather than erroring.
///
/// When multiple installed rigs resolve to the same category, ME and TE
/// bonuses are combined independently by taking the larger of each
/// (correctly handles one ME rig + one TE rig both targeting the same
/// category, while still tolerating an accidental duplicate pick).
pub fn expand_installed_rigs(
    installed: &[TypeId],
    category_ids_by_name: &HashMap<String, i32>,
) -> Vec<RigBonus> {
    let mut acc: HashMap<i32, (f64, f64)> = HashMap::new();
    for &type_id in installed {
        let Some(spec) = RIGS.iter().find(|r| r.type_id == type_id) else {
            continue;
        };
        for &name in spec.category_names {
            let Some(&category_id) = category_ids_by_name.get(name) else {
                continue;
            };
            let entry = acc.entry(category_id).or_insert((0.0, 0.0));
            entry.0 = entry.0.max(spec.me_bonus);
            entry.1 = entry.1.max(spec.te_bonus);
        }
    }
    acc.into_iter()
        .map(|(category_id, (me_bonus, te_bonus))| RigBonus { category_id, me_bonus, te_bonus })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expand_dedupes_same_category_by_max() {
        let categories: HashMap<String, i32> = [("Ship".to_string(), 6)].into_iter().collect();
        // Basic Medium Ship ME I (37146) + Basic Large Ship ME I (43732) both
        // resolve to category 6 with identical 0.02 me_bonus — must collapse
        // to one row, not sum (which would double the bonus).
        let bonuses = expand_installed_rigs(&[37146, 43732], &categories);
        assert_eq!(bonuses.len(), 1);
        assert_eq!(bonuses[0].category_id, 6);
        assert!((bonuses[0].me_bonus - 0.02).abs() < 1e-9);
        assert_eq!(bonuses[0].te_bonus, 0.0);
    }

    #[test]
    fn expand_combines_me_and_te_rigs_for_same_category() {
        let categories: HashMap<String, i32> = [("Ship".to_string(), 6)].into_iter().collect();
        // One ME rig + one TE rig targeting Ship should both apply.
        let bonuses = expand_installed_rigs(&[37154, 37162], &categories);
        assert_eq!(bonuses.len(), 1);
        assert!((bonuses[0].me_bonus - 0.02).abs() < 1e-9);
        assert!((bonuses[0].te_bonus - 0.20).abs() < 1e-9);
    }

    #[test]
    fn expand_ignores_unmatched_category_names() {
        let categories: HashMap<String, i32> = HashMap::new();
        let bonuses = expand_installed_rigs(&[37154], &categories);
        assert!(bonuses.is_empty());
    }

    #[test]
    fn expand_ignores_unknown_type_ids() {
        let categories: HashMap<String, i32> = [("Ship".to_string(), 6)].into_iter().collect();
        let bonuses = expand_installed_rigs(&[999_999], &categories);
        assert!(bonuses.is_empty());
    }
}
