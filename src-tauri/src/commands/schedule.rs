// Copyright (C) 2026 Eve Nexus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

//! `compute_schedule` Tauri command.

use tauri::State;

use crate::db::local::LocalState;
use crate::db::sde::SdeState;
use crate::types::PlanSchedule;
use crate::solver;

use super::solver::SolvePlanRequest;
use super::CommandError;

macro_rules! sde_lock {
    ($state:expr) => {
        $state.0.lock().map_err(|_| CommandError::sde_not_available())?
    };
}

#[tauri::command]
pub fn compute_schedule(
    request: SolvePlanRequest,
    industry_slots: u32,
    science_slots: u32,
    sde: State<'_, SdeState>,
    local: State<'_, LocalState>,
) -> Result<PlanSchedule, CommandError> {
    let guard = sde_lock!(sde);
    let sde_db = guard.as_ref().ok_or(CommandError::sde_not_available())?;

    if request.targets.is_empty() {
        return Ok(empty_schedule(industry_slots, science_slots));
    }

    let input = super::solver::assemble_solver_input(request, sde_db, &local.0)?;
    let nodes = solver::solve(&input);
    Ok(solver::compute_schedule(&nodes, &input, industry_slots, science_slots))
}

fn empty_schedule(industry_slots: u32, science_slots: u32) -> PlanSchedule {
    PlanSchedule {
        manufacturing: vec![],
        invention: vec![],
        industry_slots,
        science_slots,
        derived_industry_slots: 0,
        derived_science_slots: 0,
        manufacturing_wall_clock_seconds: 0,
        invention_wall_clock_seconds: 0,
        critical_path_seconds: 0,
    }
}