#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod models;
mod seed;
mod state;

fn main() {
    let workspace_root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let core_state = state::DesktopCoreState::seeded(workspace_root)
        .expect("failed to initialize desktop core bridge");

    tauri::Builder::default()
        .manage(core_state)
        .invoke_handler(tauri::generate_handler![
            commands::core_bridge_status,
            commands::runtime_health_snapshot,
            commands::process_check_health,
            commands::process_start,
            commands::process_stop,
            commands::task_queue_snapshot,
            commands::task_detail,
            commands::memory_dashboard_snapshot,
            commands::capability_snapshot,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Local First Assistant");
}
