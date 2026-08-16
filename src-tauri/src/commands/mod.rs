// Copyright (C) 2026 Eve Nexus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Tauri IPC command handlers.
//!
//! Thin layer: validate input, assemble `SolverInput` from all data sources,
//! call the solver or SDE, return results. No business logic lives here.
//!
//! Command groups live in submodules and are re-exported here so `lib.rs` can
//! reference them as `commands::function_name`.

pub mod characters;
pub mod import;
pub mod inventory;
pub mod market;
pub mod plans;
pub mod schedule;
pub mod sde;
pub mod settings;
pub mod solver;
pub mod updater;

pub use characters::*;
pub use import::*;
pub use inventory::*;
pub use market::*;
pub use plans::*;
pub use schedule::*;
pub use sde::*;
pub use settings::*;
pub use solver::*;
pub use updater::*;


use serde::Serialize;

// ─── Error ────────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum CommandError {
    SdeNotAvailable { message: String },
    SdeQuery { message: String },
    LocalDb { message: String },
    InvalidInput { message: String },
}

impl CommandError {
    pub fn sde_not_available() -> Self {
        CommandError::SdeNotAvailable {
            message: "EVE static data isn't loaded yet — download it from Settings.".into(),
        }
    }
}

impl From<crate::db::sde::SdeError> for CommandError {
    fn from(e: crate::db::sde::SdeError) -> Self {
        CommandError::SdeQuery { message: e.to_string() }
    }
}

impl From<crate::db::local::LocalDbError> for CommandError {
    fn from(e: crate::db::local::LocalDbError) -> Self {
        CommandError::LocalDb { message: e.to_string() }
    }
}