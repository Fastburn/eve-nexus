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
//! M-Set rigs (Raitaru, Azbel, Athanor, Tatara) come as separate ME and TE
//! items; L-Set (Azbel, Sotiyo, Tatara) and XL-Set (Sotiyo) rigs each give
//! both. All type IDs and
//! values below were checked against SDE dogma (`attributeEngRigMatBonus`,
//! `attributeEngRigTimeBonus`, `RefRigMatBonus`, `RefRigTimeBonus`, and the
//! rig's `rig*Manufacture*` / `rigReaction*` effects).
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
    /// SDE group IDs the bonus is limited to within those categories. Empty
    /// means the whole category.
    pub group_ids: &'static [i32],
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
// M-Set reactor rigs each cover one reaction formula family. Every reaction
// product is in the "Material" category, so they are told apart by product
// group (SDE group IDs, mapped from the formula group that makes them).
// Molecular-Forged reactions (group 4096) aren't assigned to any M-Set
// family here; only the L-Set rig, which covers all reactions, applies.
/// Composite Reaction Formulas: Composite, Intermediate Materials, Unrefined Mineral.
const COMPOSITE_GROUPS: &[i32] = &[429, 428, 4932];
/// Polymer Reaction Formulas: Hybrid Polymers.
const HYBRID_GROUPS: &[i32] = &[974];
/// Biochemical Reaction Formulas: Biochemical Material.
const BIOCHEMICAL_GROUPS: &[i32] = &[712];
// XL-Set rigs merge several M/L-Set coverages (confirmed via their SDE dogma
// effects): Equipment & Consumable = equipment + ammunition + drones/fighters;
// Structure & Component = advanced/capital components + structure.
const XL_EQUIPMENT_CONSUMABLE: &[&str] = &["Module", "Deployable", "Implant", "Charge", "Drone", "Fighter"];
const XL_STRUCTURE_COMPONENT: &[&str] = &["Commodity", "Structure", "Structure Module", "Material"];

pub const RIGS: &[RigSpec] = &[
    // ── Advanced Component ──────────────────────────────────────────────────
    RigSpec { type_id: 43867, name: "Standup M-Set Advanced Component Manufacturing Material Efficiency I", tier: 1, me_bonus: 0.02, te_bonus: 0.0, job_type: JobType::Manufacturing, category_names: COMMODITY, group_ids: &[] },
    RigSpec { type_id: 43866, name: "Standup M-Set Advanced Component Manufacturing Material Efficiency II", tier: 2, me_bonus: 0.024, te_bonus: 0.0, job_type: JobType::Manufacturing, category_names: COMMODITY, group_ids: &[] },
    RigSpec { type_id: 43869, name: "Standup M-Set Advanced Component Manufacturing Time Efficiency I", tier: 1, me_bonus: 0.0, te_bonus: 0.20, job_type: JobType::Manufacturing, category_names: COMMODITY, group_ids: &[] },
    RigSpec { type_id: 43868, name: "Standup M-Set Advanced Component Manufacturing Time Efficiency II", tier: 2, me_bonus: 0.0, te_bonus: 0.24, job_type: JobType::Manufacturing, category_names: COMMODITY, group_ids: &[] },

    // ── Advanced Large Ship ──────────────────────────────────────────────────
    RigSpec { type_id: 43862, name: "Standup M-Set Advanced Large Ship Manufacturing Material Efficiency I", tier: 1, me_bonus: 0.02, te_bonus: 0.0, job_type: JobType::Manufacturing, category_names: SHIP, group_ids: &[] },
    RigSpec { type_id: 43863, name: "Standup M-Set Advanced Large Ship Manufacturing Material Efficiency II", tier: 2, me_bonus: 0.024, te_bonus: 0.0, job_type: JobType::Manufacturing, category_names: SHIP, group_ids: &[] },
    RigSpec { type_id: 43865, name: "Standup M-Set Advanced Large Ship Manufacturing Time Efficiency I", tier: 1, me_bonus: 0.0, te_bonus: 0.20, job_type: JobType::Manufacturing, category_names: SHIP, group_ids: &[] },
    RigSpec { type_id: 43864, name: "Standup M-Set Advanced Large Ship Manufacturing Time Efficiency II", tier: 2, me_bonus: 0.0, te_bonus: 0.24, job_type: JobType::Manufacturing, category_names: SHIP, group_ids: &[] },

    // ── Advanced Medium Ship ─────────────────────────────────────────────────
    RigSpec { type_id: 43858, name: "Standup M-Set Advanced Medium Ship Manufacturing Material Efficiency I", tier: 1, me_bonus: 0.02, te_bonus: 0.0, job_type: JobType::Manufacturing, category_names: SHIP, group_ids: &[] },
    RigSpec { type_id: 43859, name: "Standup M-Set Advanced Medium Ship Manufacturing Material Efficiency II", tier: 2, me_bonus: 0.024, te_bonus: 0.0, job_type: JobType::Manufacturing, category_names: SHIP, group_ids: &[] },
    RigSpec { type_id: 43860, name: "Standup M-Set Advanced Medium Ship Manufacturing Time Efficiency I", tier: 1, me_bonus: 0.0, te_bonus: 0.20, job_type: JobType::Manufacturing, category_names: SHIP, group_ids: &[] },
    RigSpec { type_id: 43861, name: "Standup M-Set Advanced Medium Ship Manufacturing Time Efficiency II", tier: 2, me_bonus: 0.0, te_bonus: 0.24, job_type: JobType::Manufacturing, category_names: SHIP, group_ids: &[] },

    // ── Advanced Small Ship ──────────────────────────────────────────────────
    RigSpec { type_id: 43855, name: "Standup M-Set Advanced Small Ship Manufacturing Material Efficiency I", tier: 1, me_bonus: 0.02, te_bonus: 0.0, job_type: JobType::Manufacturing, category_names: SHIP, group_ids: &[] },
    RigSpec { type_id: 43854, name: "Standup M-Set Advanced Small Ship Manufacturing Material Efficiency II", tier: 2, me_bonus: 0.024, te_bonus: 0.0, job_type: JobType::Manufacturing, category_names: SHIP, group_ids: &[] },
    RigSpec { type_id: 43856, name: "Standup M-Set Advanced Small Ship Manufacturing Time Efficiency I", tier: 1, me_bonus: 0.0, te_bonus: 0.20, job_type: JobType::Manufacturing, category_names: SHIP, group_ids: &[] },
    RigSpec { type_id: 43857, name: "Standup M-Set Advanced Small Ship Manufacturing Time Efficiency II", tier: 2, me_bonus: 0.0, te_bonus: 0.24, job_type: JobType::Manufacturing, category_names: SHIP, group_ids: &[] },

    // ── Ammunition ───────────────────────────────────────────────────────────
    RigSpec { type_id: 37158, name: "Standup M-Set Ammunition Manufacturing Material Efficiency I", tier: 1, me_bonus: 0.02, te_bonus: 0.0, job_type: JobType::Manufacturing, category_names: CHARGE, group_ids: &[] },
    RigSpec { type_id: 37159, name: "Standup M-Set Ammunition Manufacturing Material Efficiency II", tier: 2, me_bonus: 0.024, te_bonus: 0.0, job_type: JobType::Manufacturing, category_names: CHARGE, group_ids: &[] },
    RigSpec { type_id: 37150, name: "Standup M-Set Ammunition Manufacturing Time Efficiency I", tier: 1, me_bonus: 0.0, te_bonus: 0.20, job_type: JobType::Manufacturing, category_names: CHARGE, group_ids: &[] },
    RigSpec { type_id: 37151, name: "Standup M-Set Ammunition Manufacturing Time Efficiency II", tier: 2, me_bonus: 0.0, te_bonus: 0.24, job_type: JobType::Manufacturing, category_names: CHARGE, group_ids: &[] },

    // ── Basic Capital Component ─────────────────────────────────────────────
    RigSpec { type_id: 43870, name: "Standup M-Set Basic Capital Component Manufacturing Material Efficiency I", tier: 1, me_bonus: 0.02, te_bonus: 0.0, job_type: JobType::Manufacturing, category_names: COMMODITY, group_ids: &[] },
    RigSpec { type_id: 43871, name: "Standup M-Set Basic Capital Component Manufacturing Material Efficiency II", tier: 2, me_bonus: 0.024, te_bonus: 0.0, job_type: JobType::Manufacturing, category_names: COMMODITY, group_ids: &[] },
    RigSpec { type_id: 43872, name: "Standup M-Set Basic Capital Component Manufacturing Time Efficiency I", tier: 1, me_bonus: 0.0, te_bonus: 0.20, job_type: JobType::Manufacturing, category_names: COMMODITY, group_ids: &[] },
    RigSpec { type_id: 43873, name: "Standup M-Set Basic Capital Component Manufacturing Time Efficiency II", tier: 2, me_bonus: 0.0, te_bonus: 0.24, job_type: JobType::Manufacturing, category_names: COMMODITY, group_ids: &[] },

    // ── Basic Large Ship ─────────────────────────────────────────────────────
    RigSpec { type_id: 43732, name: "Standup M-Set Basic Large Ship Manufacturing Material Efficiency I", tier: 1, me_bonus: 0.02, te_bonus: 0.0, job_type: JobType::Manufacturing, category_names: SHIP, group_ids: &[] },
    RigSpec { type_id: 37152, name: "Standup M-Set Basic Large Ship Manufacturing Material Efficiency II", tier: 2, me_bonus: 0.024, te_bonus: 0.0, job_type: JobType::Manufacturing, category_names: SHIP, group_ids: &[] },
    RigSpec { type_id: 43733, name: "Standup M-Set Basic Large Ship Manufacturing Time Efficiency I", tier: 1, me_bonus: 0.0, te_bonus: 0.20, job_type: JobType::Manufacturing, category_names: SHIP, group_ids: &[] },
    RigSpec { type_id: 43734, name: "Standup M-Set Basic Large Ship Manufacturing Time Efficiency II", tier: 2, me_bonus: 0.0, te_bonus: 0.24, job_type: JobType::Manufacturing, category_names: SHIP, group_ids: &[] },

    // ── Basic Medium Ship ────────────────────────────────────────────────────
    RigSpec { type_id: 37146, name: "Standup M-Set Basic Medium Ship Manufacturing Material Efficiency I", tier: 1, me_bonus: 0.02, te_bonus: 0.0, job_type: JobType::Manufacturing, category_names: SHIP, group_ids: &[] },
    RigSpec { type_id: 37147, name: "Standup M-Set Basic Medium Ship Manufacturing Material Efficiency II", tier: 2, me_bonus: 0.024, te_bonus: 0.0, job_type: JobType::Manufacturing, category_names: SHIP, group_ids: &[] },
    RigSpec { type_id: 43919, name: "Standup M-Set Basic Medium Ship Manufacturing Time Efficiency I", tier: 1, me_bonus: 0.0, te_bonus: 0.20, job_type: JobType::Manufacturing, category_names: SHIP, group_ids: &[] },
    RigSpec { type_id: 37153, name: "Standup M-Set Basic Medium Ship Manufacturing Time Efficiency II", tier: 2, me_bonus: 0.0, te_bonus: 0.24, job_type: JobType::Manufacturing, category_names: SHIP, group_ids: &[] },

    // ── Basic Small Ship ─────────────────────────────────────────────────────
    RigSpec { type_id: 37154, name: "Standup M-Set Basic Small Ship Manufacturing Material Efficiency I", tier: 1, me_bonus: 0.02, te_bonus: 0.0, job_type: JobType::Manufacturing, category_names: SHIP, group_ids: &[] },
    RigSpec { type_id: 37155, name: "Standup M-Set Basic Small Ship Manufacturing Material Efficiency II", tier: 2, me_bonus: 0.024, te_bonus: 0.0, job_type: JobType::Manufacturing, category_names: SHIP, group_ids: &[] },
    RigSpec { type_id: 37162, name: "Standup M-Set Basic Small Ship Manufacturing Time Efficiency I", tier: 1, me_bonus: 0.0, te_bonus: 0.20, job_type: JobType::Manufacturing, category_names: SHIP, group_ids: &[] },
    RigSpec { type_id: 37163, name: "Standup M-Set Basic Small Ship Manufacturing Time Efficiency II", tier: 2, me_bonus: 0.0, te_bonus: 0.24, job_type: JobType::Manufacturing, category_names: SHIP, group_ids: &[] },

    // ── Drone and Fighter ────────────────────────────────────────────────────
    RigSpec { type_id: 37156, name: "Standup M-Set Drone and Fighter Manufacturing Material Efficiency I", tier: 1, me_bonus: 0.02, te_bonus: 0.0, job_type: JobType::Manufacturing, category_names: DRONE_FIGHTER, group_ids: &[] },
    RigSpec { type_id: 37157, name: "Standup M-Set Drone and Fighter Manufacturing Material Efficiency II", tier: 2, me_bonus: 0.024, te_bonus: 0.0, job_type: JobType::Manufacturing, category_names: DRONE_FIGHTER, group_ids: &[] },
    RigSpec { type_id: 37148, name: "Standup M-Set Drone and Fighter Manufacturing Time Efficiency I", tier: 1, me_bonus: 0.0, te_bonus: 0.20, job_type: JobType::Manufacturing, category_names: DRONE_FIGHTER, group_ids: &[] },
    RigSpec { type_id: 37149, name: "Standup M-Set Drone and Fighter Manufacturing Time Efficiency II", tier: 2, me_bonus: 0.0, te_bonus: 0.24, job_type: JobType::Manufacturing, category_names: DRONE_FIGHTER, group_ids: &[] },

    // ── Equipment (modules, deployables, implants) ──────────────────────────
    RigSpec { type_id: 43920, name: "Standup M-Set Equipment Manufacturing Material Efficiency I", tier: 1, me_bonus: 0.02, te_bonus: 0.0, job_type: JobType::Manufacturing, category_names: EQUIPMENT, group_ids: &[] },
    RigSpec { type_id: 43921, name: "Standup M-Set Equipment Manufacturing Material Efficiency II", tier: 2, me_bonus: 0.024, te_bonus: 0.0, job_type: JobType::Manufacturing, category_names: EQUIPMENT, group_ids: &[] },
    RigSpec { type_id: 37160, name: "Standup M-Set Equipment Manufacturing Time Efficiency I", tier: 1, me_bonus: 0.0, te_bonus: 0.20, job_type: JobType::Manufacturing, category_names: EQUIPMENT, group_ids: &[] },
    RigSpec { type_id: 37161, name: "Standup M-Set Equipment Manufacturing Time Efficiency II", tier: 2, me_bonus: 0.0, te_bonus: 0.24, job_type: JobType::Manufacturing, category_names: EQUIPMENT, group_ids: &[] },

    // ── Structure (components, modules, rigs, Upwell hulls, and fuel blocks —
    // fuel blocks fall in the "Material" SDE category, see STRUCTURE const) ─
    RigSpec { type_id: 43875, name: "Standup M-Set Structure Manufacturing Material Efficiency I", tier: 1, me_bonus: 0.02, te_bonus: 0.0, job_type: JobType::Manufacturing, category_names: STRUCTURE, group_ids: &[] },
    RigSpec { type_id: 43874, name: "Standup M-Set Structure Manufacturing Material Efficiency II", tier: 2, me_bonus: 0.024, te_bonus: 0.0, job_type: JobType::Manufacturing, category_names: STRUCTURE, group_ids: &[] },
    RigSpec { type_id: 43876, name: "Standup M-Set Structure Manufacturing Time Efficiency I", tier: 1, me_bonus: 0.0, te_bonus: 0.20, job_type: JobType::Manufacturing, category_names: STRUCTURE, group_ids: &[] },
    RigSpec { type_id: 43877, name: "Standup M-Set Structure Manufacturing Time Efficiency II", tier: 2, me_bonus: 0.0, te_bonus: 0.24, job_type: JobType::Manufacturing, category_names: STRUCTURE, group_ids: &[] },

    // ══ L-Set (Azbel, Sotiyo): one rig gives both ME and TE ══════════════

    // ── L-Set Advanced Component ──
    RigSpec { type_id: 37174, name: "Standup L-Set Advanced Component Manufacturing Efficiency I", tier: 1, me_bonus: 0.02, te_bonus: 0.20, job_type: JobType::Manufacturing, category_names: COMMODITY, group_ids: &[] },
    RigSpec { type_id: 37175, name: "Standup L-Set Advanced Component Manufacturing Efficiency II", tier: 2, me_bonus: 0.024, te_bonus: 0.24, job_type: JobType::Manufacturing, category_names: COMMODITY, group_ids: &[] },

    // ── L-Set Advanced Large Ship ──
    RigSpec { type_id: 37168, name: "Standup L-Set Advanced Large Ship Manufacturing Efficiency I", tier: 1, me_bonus: 0.02, te_bonus: 0.20, job_type: JobType::Manufacturing, category_names: SHIP, group_ids: &[] },
    RigSpec { type_id: 37169, name: "Standup L-Set Advanced Large Ship Manufacturing Efficiency II", tier: 2, me_bonus: 0.024, te_bonus: 0.24, job_type: JobType::Manufacturing, category_names: SHIP, group_ids: &[] },

    // ── L-Set Advanced Medium Ship ──
    RigSpec { type_id: 43709, name: "Standup L-Set Advanced Medium Ship Manufacturing Efficiency I", tier: 1, me_bonus: 0.02, te_bonus: 0.20, job_type: JobType::Manufacturing, category_names: SHIP, group_ids: &[] },
    RigSpec { type_id: 43711, name: "Standup L-Set Advanced Medium Ship Manufacturing Efficiency II", tier: 2, me_bonus: 0.024, te_bonus: 0.24, job_type: JobType::Manufacturing, category_names: SHIP, group_ids: &[] },

    // ── L-Set Advanced Small Ship ──
    RigSpec { type_id: 43707, name: "Standup L-Set Advanced Small Ship Manufacturing Efficiency I", tier: 1, me_bonus: 0.02, te_bonus: 0.20, job_type: JobType::Manufacturing, category_names: SHIP, group_ids: &[] },
    RigSpec { type_id: 43708, name: "Standup L-Set Advanced Small Ship Manufacturing Efficiency II", tier: 2, me_bonus: 0.024, te_bonus: 0.24, job_type: JobType::Manufacturing, category_names: SHIP, group_ids: &[] },

    // ── L-Set Ammunition ──
    RigSpec { type_id: 37164, name: "Standup L-Set Ammunition Manufacturing Efficiency I", tier: 1, me_bonus: 0.02, te_bonus: 0.20, job_type: JobType::Manufacturing, category_names: CHARGE, group_ids: &[] },
    RigSpec { type_id: 37165, name: "Standup L-Set Ammunition Manufacturing Efficiency II", tier: 2, me_bonus: 0.024, te_bonus: 0.24, job_type: JobType::Manufacturing, category_names: CHARGE, group_ids: &[] },

    // ── L-Set Basic Capital Component ──
    RigSpec { type_id: 43718, name: "Standup L-Set Basic Capital Component Manufacturing Efficiency I", tier: 1, me_bonus: 0.02, te_bonus: 0.20, job_type: JobType::Manufacturing, category_names: COMMODITY, group_ids: &[] },
    RigSpec { type_id: 43719, name: "Standup L-Set Basic Capital Component Manufacturing Efficiency II", tier: 2, me_bonus: 0.024, te_bonus: 0.24, job_type: JobType::Manufacturing, category_names: COMMODITY, group_ids: &[] },

    // ── L-Set Basic Large Ship ──
    RigSpec { type_id: 37166, name: "Standup L-Set Basic Large Ship Manufacturing Efficiency I", tier: 1, me_bonus: 0.02, te_bonus: 0.20, job_type: JobType::Manufacturing, category_names: SHIP, group_ids: &[] },
    RigSpec { type_id: 37167, name: "Standup L-Set Basic Large Ship Manufacturing Efficiency II", tier: 2, me_bonus: 0.024, te_bonus: 0.24, job_type: JobType::Manufacturing, category_names: SHIP, group_ids: &[] },

    // ── L-Set Basic Medium Ship ──
    RigSpec { type_id: 43716, name: "Standup L-Set Basic Medium Ship Manufacturing Efficiency I", tier: 1, me_bonus: 0.02, te_bonus: 0.20, job_type: JobType::Manufacturing, category_names: SHIP, group_ids: &[] },
    RigSpec { type_id: 43717, name: "Standup L-Set Basic Medium Ship Manufacturing Efficiency II", tier: 2, me_bonus: 0.024, te_bonus: 0.24, job_type: JobType::Manufacturing, category_names: SHIP, group_ids: &[] },

    // ── L-Set Basic Small Ship ──
    RigSpec { type_id: 43714, name: "Standup L-Set Basic Small Ship Manufacturing Efficiency I", tier: 1, me_bonus: 0.02, te_bonus: 0.20, job_type: JobType::Manufacturing, category_names: SHIP, group_ids: &[] },
    RigSpec { type_id: 43715, name: "Standup L-Set Basic Small Ship Manufacturing Efficiency II", tier: 2, me_bonus: 0.024, te_bonus: 0.24, job_type: JobType::Manufacturing, category_names: SHIP, group_ids: &[] },

    // ── L-Set Capital Ship ──
    RigSpec { type_id: 37173, name: "Standup L-Set Capital Ship Manufacturing Efficiency I", tier: 1, me_bonus: 0.02, te_bonus: 0.20, job_type: JobType::Manufacturing, category_names: SHIP, group_ids: &[] },
    RigSpec { type_id: 37172, name: "Standup L-Set Capital Ship Manufacturing Efficiency II", tier: 2, me_bonus: 0.024, te_bonus: 0.24, job_type: JobType::Manufacturing, category_names: SHIP, group_ids: &[] },

    // ── L-Set Drone and Fighter ──
    RigSpec { type_id: 43712, name: "Standup L-Set Drone and Fighter Manufacturing Efficiency I", tier: 1, me_bonus: 0.02, te_bonus: 0.20, job_type: JobType::Manufacturing, category_names: DRONE_FIGHTER, group_ids: &[] },
    RigSpec { type_id: 43713, name: "Standup L-Set Drone and Fighter Manufacturing Efficiency II", tier: 2, me_bonus: 0.024, te_bonus: 0.24, job_type: JobType::Manufacturing, category_names: DRONE_FIGHTER, group_ids: &[] },

    // ── L-Set Equipment ──
    RigSpec { type_id: 37170, name: "Standup L-Set Equipment Manufacturing Efficiency I", tier: 1, me_bonus: 0.02, te_bonus: 0.20, job_type: JobType::Manufacturing, category_names: EQUIPMENT, group_ids: &[] },
    RigSpec { type_id: 37171, name: "Standup L-Set Equipment Manufacturing Efficiency II", tier: 2, me_bonus: 0.024, te_bonus: 0.24, job_type: JobType::Manufacturing, category_names: EQUIPMENT, group_ids: &[] },

    // ── L-Set Structure ──
    RigSpec { type_id: 43720, name: "Standup L-Set Structure Manufacturing Efficiency I", tier: 1, me_bonus: 0.02, te_bonus: 0.20, job_type: JobType::Manufacturing, category_names: STRUCTURE, group_ids: &[] },
    RigSpec { type_id: 43721, name: "Standup L-Set Structure Manufacturing Efficiency II", tier: 2, me_bonus: 0.024, te_bonus: 0.24, job_type: JobType::Manufacturing, category_names: STRUCTURE, group_ids: &[] },

    // ══ XL-Set (Sotiyo only): broad combined ME+TE rigs ══════════════════

    // ── XL-Set Equipment and Consumable ──
    RigSpec { type_id: 37178, name: "Standup XL-Set Equipment and Consumable Manufacturing Efficiency I", tier: 1, me_bonus: 0.02, te_bonus: 0.20, job_type: JobType::Manufacturing, category_names: XL_EQUIPMENT_CONSUMABLE, group_ids: &[] },
    RigSpec { type_id: 37179, name: "Standup XL-Set Equipment and Consumable Manufacturing Efficiency II", tier: 2, me_bonus: 0.024, te_bonus: 0.24, job_type: JobType::Manufacturing, category_names: XL_EQUIPMENT_CONSUMABLE, group_ids: &[] },

    // ── XL-Set Ship ──
    RigSpec { type_id: 37180, name: "Standup XL-Set Ship Manufacturing Efficiency I", tier: 1, me_bonus: 0.02, te_bonus: 0.20, job_type: JobType::Manufacturing, category_names: SHIP, group_ids: &[] },
    RigSpec { type_id: 37181, name: "Standup XL-Set Ship Manufacturing Efficiency II", tier: 2, me_bonus: 0.024, te_bonus: 0.24, job_type: JobType::Manufacturing, category_names: SHIP, group_ids: &[] },

    // ── XL-Set Structure and Component ──
    RigSpec { type_id: 43704, name: "Standup XL-Set Structure and Component Manufacturing Efficiency I", tier: 1, me_bonus: 0.02, te_bonus: 0.20, job_type: JobType::Manufacturing, category_names: XL_STRUCTURE_COMPONENT, group_ids: &[] },
    RigSpec { type_id: 43705, name: "Standup XL-Set Structure and Component Manufacturing Efficiency II", tier: 2, me_bonus: 0.024, te_bonus: 0.24, job_type: JobType::Manufacturing, category_names: XL_STRUCTURE_COMPONENT, group_ids: &[] },

    // ── Reaction, M-Set (Athanor, Tatara): separate ME and TE per family ────
    RigSpec { type_id: 46484, name: "Standup M-Set Composite Reactor Time Efficiency I", tier: 1, me_bonus: 0.0, te_bonus: 0.20, job_type: JobType::Reaction, category_names: REACTION, group_ids: COMPOSITE_GROUPS },
    RigSpec { type_id: 46485, name: "Standup M-Set Composite Reactor Time Efficiency II", tier: 2, me_bonus: 0.0, te_bonus: 0.24, job_type: JobType::Reaction, category_names: REACTION, group_ids: COMPOSITE_GROUPS },
    RigSpec { type_id: 46486, name: "Standup M-Set Composite Reactor Material Efficiency I", tier: 1, me_bonus: 0.02, te_bonus: 0.0, job_type: JobType::Reaction, category_names: REACTION, group_ids: COMPOSITE_GROUPS },
    RigSpec { type_id: 46487, name: "Standup M-Set Composite Reactor Material Efficiency II", tier: 2, me_bonus: 0.024, te_bonus: 0.0, job_type: JobType::Reaction, category_names: REACTION, group_ids: COMPOSITE_GROUPS },
    RigSpec { type_id: 46488, name: "Standup M-Set Hybrid Reactor Time Efficiency I", tier: 1, me_bonus: 0.0, te_bonus: 0.20, job_type: JobType::Reaction, category_names: REACTION, group_ids: HYBRID_GROUPS },
    RigSpec { type_id: 46489, name: "Standup M-Set Hybrid Reactor Time Efficiency II", tier: 2, me_bonus: 0.0, te_bonus: 0.24, job_type: JobType::Reaction, category_names: REACTION, group_ids: HYBRID_GROUPS },
    RigSpec { type_id: 46490, name: "Standup M-Set Hybrid Reactor Material Efficiency I", tier: 1, me_bonus: 0.02, te_bonus: 0.0, job_type: JobType::Reaction, category_names: REACTION, group_ids: HYBRID_GROUPS },
    RigSpec { type_id: 46491, name: "Standup M-Set Hybrid Reactor Material Efficiency II", tier: 2, me_bonus: 0.024, te_bonus: 0.0, job_type: JobType::Reaction, category_names: REACTION, group_ids: HYBRID_GROUPS },
    RigSpec { type_id: 46492, name: "Standup M-Set Biochemical Reactor Time Efficiency I", tier: 1, me_bonus: 0.0, te_bonus: 0.20, job_type: JobType::Reaction, category_names: REACTION, group_ids: BIOCHEMICAL_GROUPS },
    RigSpec { type_id: 46493, name: "Standup M-Set Biochemical Reactor Time Efficiency II", tier: 2, me_bonus: 0.0, te_bonus: 0.24, job_type: JobType::Reaction, category_names: REACTION, group_ids: BIOCHEMICAL_GROUPS },
    RigSpec { type_id: 46494, name: "Standup M-Set Biochemical Reactor Material Efficiency I", tier: 1, me_bonus: 0.02, te_bonus: 0.0, job_type: JobType::Reaction, category_names: REACTION, group_ids: BIOCHEMICAL_GROUPS },
    RigSpec { type_id: 46495, name: "Standup M-Set Biochemical Reactor Material Efficiency II", tier: 2, me_bonus: 0.024, te_bonus: 0.0, job_type: JobType::Reaction, category_names: REACTION, group_ids: BIOCHEMICAL_GROUPS },

    // ── Reaction, L-Set (Tatara): all families, combined ME+TE ─────────────
    RigSpec { type_id: 46496, name: "Standup L-Set Reactor Efficiency I", tier: 1, me_bonus: 0.02, te_bonus: 0.20, job_type: JobType::Reaction, category_names: REACTION, group_ids: &[] },
    RigSpec { type_id: 46497, name: "Standup L-Set Reactor Efficiency II", tier: 2, me_bonus: 0.024, te_bonus: 0.24, job_type: JobType::Reaction, category_names: REACTION, group_ids: &[] },
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
///
/// `job_type` is the owning profile's activity; any installed rig whose own
/// `job_type` doesn't match is skipped. This matters because Manufacturing's
/// `STRUCTURE` rigs and Reaction's `REACTION` rig both resolve to the
/// "Material" SDE category (fuel blocks vs. reaction intermediates) — without
/// this check, a rig left over from switching a profile's job type could
/// silently bleed its bonus into the wrong activity.
pub fn expand_installed_rigs(
    installed: &[TypeId],
    job_type: JobType,
    category_ids_by_name: &HashMap<String, i32>,
) -> Vec<RigBonus> {
    let mut acc: HashMap<(i32, Option<i32>), (f64, f64)> = HashMap::new();
    for &type_id in installed {
        let Some(spec) = RIGS.iter().find(|r| r.type_id == type_id) else {
            continue;
        };
        if spec.job_type != job_type {
            continue;
        }
        for &name in spec.category_names {
            let Some(&category_id) = category_ids_by_name.get(name) else {
                continue;
            };
            let groups: Vec<Option<i32>> = if spec.group_ids.is_empty() {
                vec![None]
            } else {
                spec.group_ids.iter().copied().map(Some).collect()
            };
            for group_id in groups {
                let entry = acc.entry((category_id, group_id)).or_insert((0.0, 0.0));
                entry.0 = entry.0.max(spec.me_bonus);
                entry.1 = entry.1.max(spec.te_bonus);
            }
        }
    }
    acc.into_iter()
        .map(|((category_id, group_id), (me_bonus, te_bonus))| RigBonus { category_id, group_id, me_bonus, te_bonus })
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
        let bonuses = expand_installed_rigs(&[37146, 43732], JobType::Manufacturing, &categories);
        assert_eq!(bonuses.len(), 1);
        assert_eq!(bonuses[0].category_id, 6);
        assert!((bonuses[0].me_bonus - 0.02).abs() < 1e-9);
        assert_eq!(bonuses[0].te_bonus, 0.0);
    }

    #[test]
    fn expand_combines_me_and_te_rigs_for_same_category() {
        let categories: HashMap<String, i32> = [("Ship".to_string(), 6)].into_iter().collect();
        // One ME rig + one TE rig targeting Ship should both apply.
        let bonuses = expand_installed_rigs(&[37154, 37162], JobType::Manufacturing, &categories);
        assert_eq!(bonuses.len(), 1);
        assert!((bonuses[0].me_bonus - 0.02).abs() < 1e-9);
        assert!((bonuses[0].te_bonus - 0.20).abs() < 1e-9);
    }

    #[test]
    fn expand_ignores_unmatched_category_names() {
        let categories: HashMap<String, i32> = HashMap::new();
        let bonuses = expand_installed_rigs(&[37154], JobType::Manufacturing, &categories);
        assert!(bonuses.is_empty());
    }

    #[test]
    fn l_set_rig_gives_both_me_and_te() {
        let categories: HashMap<String, i32> = [("Ship".to_string(), 6)].into_iter().collect();
        // Standup L-Set Capital Ship Manufacturing Efficiency II
        let bonuses = expand_installed_rigs(&[37172], JobType::Manufacturing, &categories);
        assert_eq!(bonuses.len(), 1);
        assert!((bonuses[0].me_bonus - 0.024).abs() < 1e-9);
        assert!((bonuses[0].te_bonus - 0.24).abs() < 1e-9);
    }

    #[test]
    fn xl_equipment_rig_covers_ammo_and_drones() {
        let categories: HashMap<String, i32> = [
            ("Module".to_string(), 7),
            ("Charge".to_string(), 8),
            ("Drone".to_string(), 18),
            ("Ship".to_string(), 6),
        ]
        .into_iter()
        .collect();
        // Standup XL-Set Equipment and Consumable Manufacturing Efficiency I
        let mut ids: Vec<i32> = expand_installed_rigs(&[37178], JobType::Manufacturing, &categories)
            .into_iter()
            .map(|b| b.category_id)
            .collect();
        ids.sort_unstable();
        assert_eq!(ids, vec![7, 8, 18]);
    }

    #[test]
    fn m_set_reactor_rig_is_limited_to_its_family() {
        let categories: HashMap<String, i32> = [("Material".to_string(), 4)].into_iter().collect();
        // Standup M-Set Hybrid Reactor Material Efficiency II
        let bonuses = expand_installed_rigs(&[46491], JobType::Reaction, &categories);
        assert_eq!(bonuses.len(), 1);
        assert_eq!(bonuses[0].group_id, Some(974));
        assert!((bonuses[0].me_bonus - 0.024).abs() < 1e-9);
        // L-Set reactor rig stays category-wide.
        let bonuses = expand_installed_rigs(&[46496], JobType::Reaction, &categories);
        assert_eq!(bonuses.len(), 1);
        assert_eq!(bonuses[0].group_id, None);
    }

    #[test]
    fn rig_type_ids_are_unique() {
        let mut ids: Vec<TypeId> = RIGS.iter().map(|r| r.type_id).collect();
        ids.sort_unstable();
        let before = ids.len();
        ids.dedup();
        assert_eq!(before, ids.len());
    }

    #[test]
    fn expand_ignores_unknown_type_ids() {
        let categories: HashMap<String, i32> = [("Ship".to_string(), 6)].into_iter().collect();
        let bonuses = expand_installed_rigs(&[999_999], JobType::Manufacturing, &categories);
        assert!(bonuses.is_empty());
    }

    #[test]
    fn expand_does_not_leak_reaction_rig_into_manufacturing_material_category() {
        // Both the Structure Manufacturing rig (fuel blocks) and the Reactor
        // Efficiency rig (reaction intermediates) resolve to "Material" — a
        // Reaction-job-type rig ID must never contribute a bonus when the
        // profile being expanded is Manufacturing, and vice versa.
        let categories: HashMap<String, i32> = [("Material".to_string(), 4)].into_iter().collect();
        let mfg_bonuses = expand_installed_rigs(&[46496], JobType::Manufacturing, &categories);
        assert!(mfg_bonuses.is_empty(), "Reaction rig must not apply to a Manufacturing profile");

        let reaction_bonuses = expand_installed_rigs(&[46496], JobType::Reaction, &categories);
        assert_eq!(reaction_bonuses.len(), 1);
        assert_eq!(reaction_bonuses[0].category_id, 4);
    }
}
