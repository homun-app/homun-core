#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod local_computer_smoke;
mod models;
mod prompt_plan_executor;
mod prompt_submission;
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
            commands::chat_thread_snapshot,
            commands::create_chat_thread,
            commands::runtime_health_snapshot,
            commands::process_check_health,
            commands::process_start,
            commands::process_stop,
            commands::task_queue_snapshot,
            commands::task_detail,
            commands::approval_approve,
            commands::approval_reject,
            commands::memory_dashboard_snapshot,
            commands::capability_snapshot,
            commands::local_computer_session_snapshot,
            commands::local_computer_run_smoke_test,
            commands::local_computer_request_takeover,
            commands::local_computer_pause_session,
            commands::local_computer_resume_session,
            commands::submit_user_prompt,
            commands::prompt_plan_run_next_step,
            commands::prompt_plan_run_ready_steps,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Local First Assistant");
}
