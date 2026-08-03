use crate::TaskStatus;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnLifecycleClass {
    ActiveWork,
    WaitingUser,
    Parked,
    Terminal,
    InternalFinalizing,
}

pub const ACTIVE_CHAT_TURN_EXCLUDED_SQL_STATUSES: &str =
    "'completed', 'failed', 'cancelled', 'expired', 'finalizing'";

pub fn classify_task_status(status: &str) -> TurnLifecycleClass {
    match status {
        "completed" | "failed" | "cancelled" | "expired" => TurnLifecycleClass::Terminal,
        "finalizing" => TurnLifecycleClass::InternalFinalizing,
        "waiting_user_approval" => TurnLifecycleClass::WaitingUser,
        "parked" => TurnLifecycleClass::Parked,
        _ => TurnLifecycleClass::ActiveWork,
    }
}

pub fn task_status_is_terminal(status: TaskStatus) -> bool {
    matches!(
        status,
        TaskStatus::Completed | TaskStatus::Failed | TaskStatus::Cancelled | TaskStatus::Expired
    )
}

pub fn status_has_active_turn_projection(status: &str) -> bool {
    !matches!(
        classify_task_status(status),
        TurnLifecycleClass::Terminal | TurnLifecycleClass::InternalFinalizing
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_terminal_statuses() {
        for status in ["completed", "failed", "cancelled", "expired"] {
            assert_eq!(classify_task_status(status), TurnLifecycleClass::Terminal);
        }
    }

    #[test]
    fn classifies_waiting_parked_and_finalizing() {
        assert_eq!(
            classify_task_status("waiting_user_approval"),
            TurnLifecycleClass::WaitingUser,
        );
        assert_eq!(classify_task_status("parked"), TurnLifecycleClass::Parked);
        assert_eq!(
            classify_task_status("finalizing"),
            TurnLifecycleClass::InternalFinalizing,
        );
    }

    #[test]
    fn unknown_non_terminal_statuses_are_active_work() {
        assert_eq!(
            classify_task_status("running"),
            TurnLifecycleClass::ActiveWork
        );
        assert_eq!(
            classify_task_status("queued"),
            TurnLifecycleClass::ActiveWork
        );
    }

    #[test]
    fn active_turn_projection_excludes_terminal_and_internal_finalizing() {
        for status in ["completed", "failed", "cancelled", "expired", "finalizing"] {
            assert!(!status_has_active_turn_projection(status));
        }

        for status in [
            "queued",
            "running",
            "waiting_user_approval",
            "parked",
            "unknown",
        ] {
            assert!(status_has_active_turn_projection(status));
        }
    }

    #[test]
    fn active_turn_sql_exclusion_list_matches_classifier() {
        let statuses: Vec<_> = ACTIVE_CHAT_TURN_EXCLUDED_SQL_STATUSES
            .split(',')
            .map(|status| status.trim().trim_matches('\''))
            .collect();

        assert_eq!(
            statuses,
            vec!["completed", "failed", "cancelled", "expired", "finalizing"]
        );
        for status in statuses {
            assert!(!status_has_active_turn_projection(status));
        }
    }

    #[test]
    fn typed_task_status_terminal_set_excludes_sql_internal_finalizing() {
        for status in [
            TaskStatus::Completed,
            TaskStatus::Failed,
            TaskStatus::Cancelled,
            TaskStatus::Expired,
        ] {
            assert!(task_status_is_terminal(status));
        }

        for status in [
            TaskStatus::Queued,
            TaskStatus::Pending,
            TaskStatus::Running,
            TaskStatus::WaitingUserApproval,
            TaskStatus::Parked,
        ] {
            assert!(!task_status_is_terminal(status));
        }
    }
}
