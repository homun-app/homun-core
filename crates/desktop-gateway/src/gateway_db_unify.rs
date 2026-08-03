use std::path::Path;

use crate::{
    db_migrate::{self, UnifyReport},
    gateway_paths::{
        gateway_legacy_chat_database_path, gateway_legacy_task_database_path,
        gateway_unified_database_path,
    },
};

/// Phase 1b: fuse the legacy two-DB layout (`desktop-gateway.sqlite` +
/// `task-runtime.sqlite`) into the unified `homun.sqlite`.
///
/// Idempotent, and intentionally called before `AppState` opens any stores on
/// the unified path.
pub(crate) fn unify_legacy_databases_at_startup() -> Result<(), std::io::Error> {
    let unified = gateway_unified_database_path()?;
    let legacy_chat = gateway_legacy_chat_database_path()?;
    let legacy_task = gateway_legacy_task_database_path()?;
    let report = db_migrate::unify_databases_if_needed(&legacy_chat, &legacy_task, &unified)
        .map_err(|error| {
            std::io::Error::other(format!(
                "db unify failed for {}: {error}",
                unified.display()
            ))
        })?;
    if let Some(message) = unified_database_startup_message(&report, &unified) {
        eprintln!("{message}");
    }
    Ok(())
}

fn unified_database_startup_message(report: &UnifyReport, unified: &Path) -> Option<String> {
    if !report.unified {
        return None;
    }
    let total_chat: usize = report.chat_rows.values().sum();
    let total_task: usize = report.task_rows.values().sum();
    Some(format!(
        "db unify: migrated legacy chat ({total_chat} rows across {} tables) + task ({total_task} rows across {} tables) into {}",
        report.chat_rows.len(),
        report.task_rows.len(),
        unified.display()
    ))
}

#[cfg(test)]
mod tests {
    use std::{collections::HashMap, path::Path};

    use crate::db_migrate::UnifyReport;

    use super::unified_database_startup_message;

    #[test]
    fn startup_message_is_absent_when_unify_did_not_run() {
        let report = UnifyReport {
            unified: false,
            chat_rows: HashMap::from([("chat_threads".to_string(), 2)]),
            task_rows: HashMap::from([("tasks".to_string(), 3)]),
        };
        assert_eq!(
            unified_database_startup_message(&report, Path::new("/tmp/homun.sqlite")),
            None
        );
    }

    #[test]
    fn startup_message_summarizes_chat_and_task_rows() {
        let report = UnifyReport {
            unified: true,
            chat_rows: HashMap::from([
                ("chat_threads".to_string(), 2),
                ("chat_messages".to_string(), 4),
            ]),
            task_rows: HashMap::from([("tasks".to_string(), 3)]),
        };
        assert_eq!(
            unified_database_startup_message(&report, Path::new("/tmp/homun.sqlite")),
            Some(
                "db unify: migrated legacy chat (6 rows across 2 tables) + task (3 rows across 1 tables) into /tmp/homun.sqlite"
                    .to_string()
            )
        );
    }
}
