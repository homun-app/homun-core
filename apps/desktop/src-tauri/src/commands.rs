use crate::models::{
    BridgeStatus, CapabilitySnapshot, ComputerArtifactPreview, DesktopChatThread,
    DesktopChatThreadSnapshot, DesktopTaskDetail, DesktopTaskQueueSnapshot,
    PromptPlanBatchRunResult, PromptPlanStepRunResult, RuntimeHealthSnapshot, RuntimeProcessItem,
};
use crate::prompt_submission::PromptSubmissionResult;
use crate::state::DesktopCoreState;
use local_first_local_computer_session::ComputerSessionSnapshot;
use local_first_memory::MemoryDashboard;

#[tauri::command]
pub fn core_bridge_status(state: tauri::State<'_, DesktopCoreState>) -> BridgeStatus {
    state.bridge_status()
}

#[tauri::command]
pub fn chat_thread_snapshot(
    state: tauri::State<'_, DesktopCoreState>,
) -> Result<DesktopChatThreadSnapshot, String> {
    state.chat_thread_snapshot()
}

#[tauri::command]
pub fn create_chat_thread(
    state: tauri::State<'_, DesktopCoreState>,
) -> Result<DesktopChatThread, String> {
    state.create_chat_thread()
}

#[tauri::command]
pub fn runtime_health_snapshot(
    state: tauri::State<'_, DesktopCoreState>,
) -> Result<RuntimeHealthSnapshot, String> {
    state.runtime_health_snapshot()
}

#[tauri::command]
pub fn process_check_health(
    state: tauri::State<'_, DesktopCoreState>,
    process_id: String,
) -> Result<RuntimeProcessItem, String> {
    state.check_process_health(&process_id)
}

#[tauri::command]
pub fn process_start(
    state: tauri::State<'_, DesktopCoreState>,
    process_id: String,
) -> Result<RuntimeProcessItem, String> {
    state.start_process(&process_id)
}

#[tauri::command]
pub fn process_stop(
    state: tauri::State<'_, DesktopCoreState>,
    process_id: String,
) -> Result<RuntimeProcessItem, String> {
    state.stop_process(&process_id)
}

#[tauri::command]
pub fn task_queue_snapshot(
    state: tauri::State<'_, DesktopCoreState>,
) -> Result<DesktopTaskQueueSnapshot, String> {
    state.task_queue_snapshot()
}

#[tauri::command]
pub fn task_detail(
    state: tauri::State<'_, DesktopCoreState>,
    task_id: String,
) -> Result<Option<DesktopTaskDetail>, String> {
    state.task_detail(&task_id)
}

#[tauri::command]
pub fn approval_approve(
    state: tauri::State<'_, DesktopCoreState>,
    approval_id: String,
) -> Result<DesktopTaskQueueSnapshot, String> {
    state.approve_task_approval(&approval_id)
}

#[tauri::command]
pub fn approval_reject(
    state: tauri::State<'_, DesktopCoreState>,
    approval_id: String,
    reason: String,
) -> Result<DesktopTaskQueueSnapshot, String> {
    state.reject_task_approval(&approval_id, &reason)
}

#[tauri::command]
pub fn memory_dashboard_snapshot(
    state: tauri::State<'_, DesktopCoreState>,
) -> Result<MemoryDashboard, String> {
    state.memory_dashboard_snapshot()
}

#[tauri::command]
pub fn capability_snapshot(
    state: tauri::State<'_, DesktopCoreState>,
) -> Result<CapabilitySnapshot, String> {
    state.capability_snapshot()
}

#[tauri::command]
pub fn local_computer_session_snapshot(
    state: tauri::State<'_, DesktopCoreState>,
    session_id: String,
) -> Result<Option<ComputerSessionSnapshot>, String> {
    state.local_computer_session_snapshot(&session_id)
}

#[tauri::command]
pub fn local_computer_artifact_preview(
    state: tauri::State<'_, DesktopCoreState>,
    session_id: String,
    artifact_id: String,
) -> Result<Option<ComputerArtifactPreview>, String> {
    state.local_computer_artifact_preview(&session_id, &artifact_id)
}

#[tauri::command]
pub fn local_computer_run_smoke_test(
    state: tauri::State<'_, DesktopCoreState>,
    session_id: String,
) -> Result<ComputerSessionSnapshot, String> {
    state.run_local_computer_smoke_test(&session_id)
}

#[tauri::command]
pub fn local_computer_request_takeover(
    state: tauri::State<'_, DesktopCoreState>,
    session_id: String,
) -> Result<ComputerSessionSnapshot, String> {
    state.request_local_computer_takeover(&session_id)
}

#[tauri::command]
pub fn local_computer_pause_session(
    state: tauri::State<'_, DesktopCoreState>,
    session_id: String,
) -> Result<ComputerSessionSnapshot, String> {
    state.pause_local_computer_session(&session_id)
}

#[tauri::command]
pub fn local_computer_resume_session(
    state: tauri::State<'_, DesktopCoreState>,
    session_id: String,
) -> Result<ComputerSessionSnapshot, String> {
    state.resume_local_computer_session(&session_id)
}

#[tauri::command]
pub fn submit_user_prompt(
    state: tauri::State<'_, DesktopCoreState>,
    session_id: String,
    prompt: String,
) -> Result<PromptSubmissionResult, String> {
    state.submit_user_prompt(&session_id, &prompt)
}

#[tauri::command]
pub fn prompt_plan_run_next_step(
    state: tauri::State<'_, DesktopCoreState>,
    session_id: String,
) -> Result<PromptPlanStepRunResult, String> {
    state.run_prompt_plan_next_step(&session_id)
}

#[tauri::command]
pub fn prompt_plan_run_ready_steps(
    state: tauri::State<'_, DesktopCoreState>,
    session_id: String,
    max_steps: usize,
) -> Result<PromptPlanBatchRunResult, String> {
    state.run_prompt_plan_ready_steps(&session_id, max_steps)
}
