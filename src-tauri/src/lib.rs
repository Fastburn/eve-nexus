pub mod analytics;
pub mod auth;
pub mod commands;
pub mod db;
pub mod esi;
pub mod solver;
pub mod types;

use std::sync::Arc;

use auth::{AuthManager, AuthState};
use db::local::{LocalDb, LocalState};
use db::sde::{SdeDb, SdeState};
use esi::{EsiClient, EsiState};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let handle = app.handle().clone();

            // ── Local DB: always open (created on first launch) ──────────────
            let data_dir = handle
                .path()
                .app_data_dir()
                .expect("could not resolve app data directory");
            std::fs::create_dir_all(&data_dir)
                .expect("could not create app data directory");

            let local_db = Arc::new(LocalDb::open(&db::local::local_db_path(&data_dir))
                .expect("could not open local database"));
            app.manage(LocalState::new(local_db.clone()));

            // ── Auth + ESI client ────────────────────────────────────────────
            let auth = Arc::new(AuthManager::new(local_db));
            app.manage(AuthState(auth.clone()));
            app.manage(EsiState(EsiClient::new(auth)));

            // ── SDE: open if already downloaded, otherwise None ──────────────
            // Tauri wraps managed state in Arc internally — do NOT double-wrap
            // with Arc here, or State<'_, SdeState> in commands won't find it.
            let sde_db = db::updater::sde_db_path(&handle)
                .and_then(|p| {
                    match SdeDb::open(&p) {
                        Ok(db) => Some(db),
                        Err(e) => { eprintln!("[eve-nexus] SDE open FAILED: {e}"); None }
                    }
                });
            app.manage(SdeState::new(sde_db));

            // ── Analytics: opt-in launch ping ────────────────────────────────
            {
                let db = app.state::<LocalState>().0.clone();
                let consent = db.get_analytics_consent()
                    .unwrap_or(db::local::AnalyticsConsent::Pending);
                match db.get_or_create_device_id() {
                    Ok(device_id) => {
                        tauri::async_runtime::spawn(async move {
                            analytics::maybe_ping_launch(consent, device_id).await;
                        });
                    }
                    Err(e) => {
                        eprintln!("[eve-nexus] analytics: failed to get device_id, skipping ping: {e}");
                    }
                }
            }

            // ── SDE: background version check on every launch ────────────────
            // Clone the inner Arc so the async task owns it without borrowing
            // the State<'_, SdeState> handle across await points.
            let handle_update = handle.clone();
            let sde_inner = app.state::<SdeState>().0.clone();
            tauri::async_runtime::spawn(async move {
                db::updater::check_and_update(handle_update.clone()).await;

                // After update, (re-)open the SDE so the new file is live
                // without requiring a restart.
                if let Some(path) = db::updater::sde_db_path(&handle_update) {
                    match SdeDb::open(&path) {
                        Ok(new_db) => {
                            if let Ok(mut guard) = sde_inner.lock() {
                                *guard = Some(new_db);
                            }
                        }
                        Err(e) => eprintln!("[eve-nexus] SDE re-open after update FAILED: {e}"),
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Solver
            commands::solve_build_plan,
            // SDE
            commands::search_types,
            commands::get_sde_status,
            commands::get_sde_version,
            commands::trigger_sde_update,
            // Virtual hangar
            commands::get_virtual_hangar,
            commands::set_hangar_quantity,
            // Structure profiles
            commands::get_structure_profiles,
            commands::save_structure_profile,
            commands::delete_structure_profile,
            // Blueprint overrides
            commands::get_blueprint_overrides,
            commands::set_blueprint_override,
            commands::clear_blueprint_override,
            // Manual decisions & blacklist
            commands::get_manual_decisions,
            commands::get_blacklist,
            commands::set_manual_decision,
            commands::clear_manual_decision,
            commands::add_to_blacklist,
            commands::remove_from_blacklist,
            // Settings
            commands::get_analytics_consent,
            commands::set_analytics_consent,
            // Production plans
            commands::list_plans,
            commands::get_plan,
            commands::save_plan,
            commands::delete_plan,
            // App updater
            commands::check_for_app_update,
            commands::install_app_update,
            // SDE type name lookup
            commands::get_type_names,
            // Blueprint browser
            commands::get_industry_categories,
            commands::get_industry_groups,
            commands::browse_blueprints,
            commands::get_character_blueprints,
            // Auth + ESI
            commands::add_character,
            commands::remove_character,
            commands::list_characters,
            commands::list_industry_jobs,
            commands::get_industry_skills,
            commands::get_slot_info,
            commands::refresh_esi_data,
            commands::refresh_all_esi_data,
            // Market regions + prices
            commands::get_market_regions,
            commands::save_market_region,
            commands::delete_market_region,
            commands::fetch_market_prices,
            // Structure search
            commands::search_market_structures,
            commands::get_asset_structures,
            commands::debug_asset_locations,
            // System cost index
            commands::search_solar_systems,
            commands::get_system_cost_info,
            commands::get_cheapest_systems,
            // Restock planner
            commands::get_restock_rows,
            commands::save_restock_target,
            commands::delete_restock_target,
            commands::get_restock_margin,
            commands::set_restock_margin,
            commands::get_default_overproduction_multiplier,
            commands::set_default_overproduction_multiplier,
            commands::get_default_freight_isk_per_m3,
            commands::set_default_freight_isk_per_m3,
            // Watched systems
            commands::get_watched_systems,
            commands::add_watched_system,
            commands::remove_watched_system,
            commands::import_eft_fit,
            commands::set_corp_assets_mode,
            commands::open_app_data_folder,
            commands::get_wizard_completed,
            commands::set_wizard_completed,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
