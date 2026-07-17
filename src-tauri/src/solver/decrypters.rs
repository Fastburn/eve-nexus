// Copyright (C) 2026 Eve Nexus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Static T2 decrypter data (verified against EVE Ref / everef.net).
//!
//! These 8 items never change, so they're hardcoded here rather than
//! pulled through the SDE importer, which doesn't import dogma attributes.

use crate::types::TypeId;

/// One decrypter's item identity and invention modifiers.
#[derive(Debug, Clone, Copy)]
pub struct DecrypterSpec {
    pub type_id: TypeId,
    pub name: &'static str,
    /// Added to the output BPC's max runs.
    pub run_modifier: i32,
    /// Added to the output BPC's ME level.
    pub me_modifier: i32,
    /// Added to the output BPC's TE level.
    pub te_modifier: i32,
    /// Multiplied against the base invention probability.
    pub probability_multiplier: f64,
}

pub const DECRYPTERS: &[DecrypterSpec] = &[
    DecrypterSpec { type_id: 34201, name: "Accelerant Decryptor", run_modifier: 1, me_modifier: 2, te_modifier: 10, probability_multiplier: 1.2 },
    DecrypterSpec { type_id: 34202, name: "Attainment Decryptor", run_modifier: 4, me_modifier: -1, te_modifier: 4, probability_multiplier: 1.8 },
    DecrypterSpec { type_id: 34203, name: "Augmentation Decryptor", run_modifier: 9, me_modifier: -2, te_modifier: 2, probability_multiplier: 0.6 },
    DecrypterSpec { type_id: 34204, name: "Parity Decryptor", run_modifier: 3, me_modifier: 1, te_modifier: -2, probability_multiplier: 1.5 },
    DecrypterSpec { type_id: 34205, name: "Process Decryptor", run_modifier: 0, me_modifier: 3, te_modifier: 6, probability_multiplier: 1.1 },
    DecrypterSpec { type_id: 34206, name: "Symmetry Decryptor", run_modifier: 2, me_modifier: 1, te_modifier: 8, probability_multiplier: 1.0 },
    DecrypterSpec { type_id: 34207, name: "Optimized Attainment Decryptor", run_modifier: 2, me_modifier: 1, te_modifier: -2, probability_multiplier: 1.9 },
    DecrypterSpec { type_id: 34208, name: "Optimized Augmentation Decryptor", run_modifier: 7, me_modifier: 2, te_modifier: 0, probability_multiplier: 0.9 },
];

/// Look up a decrypter's spec by type_id.
pub fn find_decrypter(type_id: TypeId) -> Option<&'static DecrypterSpec> {
    DECRYPTERS.iter().find(|d| d.type_id == type_id)
}
