use crate::{AllowedAction, SubagentTask};

pub fn validate_task_permissions(task: &SubagentTask) -> Vec<String> {
    let mut errors = Vec::new();
    for action in &task.permission_envelope.allowed_actions {
        let required_level = required_autonomy_level(action);
        if task.permission_envelope.max_autonomy_level < required_level {
            errors.push(format!(
                "action {} requires autonomy level {}, task allows {}",
                action.as_str(),
                required_level,
                task.permission_envelope.max_autonomy_level
            ));
        }
    }
    errors
}

pub fn required_autonomy_level(action: &AllowedAction) -> u8 {
    match action {
        AllowedAction::Read => 0,
        AllowedAction::Draft => 2,
        AllowedAction::WriteWithConfirmation => 3,
        AllowedAction::ApprovedAutomation => 4,
    }
}
