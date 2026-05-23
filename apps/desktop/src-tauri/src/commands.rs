use crate::models::{
    BridgeStatus, CapabilitySnapshot, DesktopTaskDetail, DesktopTaskQueueSnapshot,
    RuntimeHealthSnapshot, RuntimeProcessItem,
};
use crate::state::DesktopCoreState;
use local_first_memory::MemoryDashboard;

#[tauri::command]
pub fn core_bridge_status(state: tauri::State<'_, DesktopCoreState>) -> BridgeStatus {
    state.bridge_status()
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
