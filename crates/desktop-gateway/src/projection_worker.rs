use crate::{AppState, LocalTaskExecutionError};
use local_first_task_runtime::{
    ProjectionClaim, ProjectionErrorEvidence, TaskId, UserId, WorkspaceId,
    projection_outbox::CHAT_LIFECYCLE_PROJECTION,
};
use std::sync::{
    OnceLock,
    atomic::{AtomicBool, AtomicU64, Ordering},
};
use time::OffsetDateTime;
use tokio::sync::Notify;

const MAX_DRAIN_BATCH: usize = 1_024;
const MAX_RETRY_BACKOFF_SECONDS: i64 = 60;

static PROCESS_GENERATION: AtomicU64 = AtomicU64::new(1);
static WORKER_STARTED: AtomicBool = AtomicBool::new(false);
static WORKER_NOTIFY: OnceLock<Notify> = OnceLock::new();

pub(crate) async fn drain_at_startup(
    state: &AppState,
    generation: u64,
) -> Result<usize, LocalTaskExecutionError> {
    if generation == 0 {
        return Err(worker_error(
            "projection process generation must be positive",
        ));
    }
    PROCESS_GENERATION.store(generation, Ordering::Release);
    drain_available(state).await
}

pub(crate) fn start(state: AppState) {
    if WORKER_STARTED.swap(true, Ordering::AcqRel) {
        return;
    }
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = notify_handle().notified() => {}
                _ = tokio::time::sleep(std::time::Duration::from_secs(1)) => {}
            }
            if let Err(error) = drain_available(&state).await {
                eprintln!("execution projection worker: {}", error.message);
            }
        }
    });
}

pub(crate) fn notify() {
    notify_handle().notify_one();
}

pub(crate) async fn drain_available(state: &AppState) -> Result<usize, LocalTaskExecutionError> {
    let generation = PROCESS_GENERATION.load(Ordering::Acquire);
    let owner = worker_owner();
    let mut processed = 0usize;
    while processed < MAX_DRAIN_BATCH {
        let now = OffsetDateTime::now_utc().unix_timestamp();
        let claim = state
            .task_store
            .lock()
            .map_err(worker_lock_error)?
            .claim_projection(CHAT_LIFECYCLE_PROJECTION, &owner, generation, now)
            .map_err(worker_store_error)?;
        let Some(claim) = claim else {
            break;
        };
        if let Err(error) = process_claim(state, &claim).await {
            let retry_at = now.saturating_add(retry_backoff_seconds(claim.record.attempt_count));
            state
                .task_store
                .lock()
                .map_err(worker_lock_error)?
                .retry_projection(
                    &claim,
                    &ProjectionErrorEvidence {
                        code: "projection_attempt_failed".into(),
                        redacted_detail: crate::redact_sensitive_text(&error.message),
                    },
                    retry_at,
                    now,
                )
                .map_err(worker_store_error)?;
            return Err(error);
        }
        processed = processed.saturating_add(1);
    }
    Ok(processed)
}

async fn process_claim(
    state: &AppState,
    claim: &ProjectionClaim,
) -> Result<(), LocalTaskExecutionError> {
    let (task, contract, outcome) = {
        let store = state.task_store.lock().map_err(worker_lock_error)?;
        let execution = store
            .execution_revision(&claim.record.execution_id, claim.record.revision)
            .map_err(worker_store_error)?
            .ok_or_else(|| worker_error("projection references a missing execution revision"))?;
        let outcome = execution.outcome.ok_or_else(|| {
            worker_error("projection references an uncommitted execution revision")
        })?;
        let scope = &execution.contract.as_ref().scope;
        let task = store
            .get_task(
                &TaskId::new(claim.record.execution_id.clone()),
                &UserId::new(scope.user_id.clone()),
                &WorkspaceId::new(scope.workspace_id.clone()),
            )
            .map_err(worker_store_error)?
            .ok_or_else(|| worker_error("projection references a missing scoped task"))?;
        (task, execution.contract, outcome)
    };
    validate_binding(&task, &contract, claim)?;

    let attempt = if crate::execution_runtime::should_project_chat(state, &task, outcome.as_ref())?
    {
        crate::execution_projection::project_chat_execution(
            state,
            &task,
            &contract,
            outcome.as_ref(),
        )
        .await?
    } else {
        crate::execution_projection::ProjectionAttempt::Completed
    };
    let now = OffsetDateTime::now_utc().unix_timestamp();
    let store = state.task_store.lock().map_err(worker_lock_error)?;
    match attempt {
        crate::execution_projection::ProjectionAttempt::Completed => store
            .complete_projection(claim, now)
            .map_err(worker_store_error),
        crate::execution_projection::ProjectionAttempt::BlockedOnEffect(receipt_ref) => store
            .block_projection(claim, &receipt_ref, now)
            .map_err(worker_store_error),
    }
}

fn validate_binding(
    task: &local_first_task_runtime::TaskRecord,
    contract: &local_first_execution_protocol::ValidatedExecutionContract,
    claim: &ProjectionClaim,
) -> Result<(), LocalTaskExecutionError> {
    let raw = contract.as_ref();
    if raw.execution_id != claim.record.execution_id
        || raw.revision != claim.record.revision
        || task.task_id.as_str() != raw.execution_id
        || task.user_id.as_str() != raw.scope.user_id
        || task.workspace_id.as_str() != raw.scope.workspace_id
        || task.kind != raw.kind
    {
        return Err(worker_error(
            "projection task, scope, kind, or revision binding is inconsistent",
        ));
    }
    Ok(())
}

fn retry_backoff_seconds(attempt_count: u64) -> i64 {
    let exponent = u32::try_from(attempt_count.saturating_sub(1).min(6)).unwrap_or(6);
    i64::from(2_u32.saturating_pow(exponent)).min(MAX_RETRY_BACKOFF_SECONDS)
}

fn worker_owner() -> String {
    format!("projection-worker-{}", std::process::id())
}

fn notify_handle() -> &'static Notify {
    WORKER_NOTIFY.get_or_init(Notify::new)
}

fn worker_store_error(
    error: local_first_task_runtime::TaskRuntimeError,
) -> LocalTaskExecutionError {
    worker_error(error.to_string())
}

fn worker_lock_error<T>(error: std::sync::PoisonError<T>) -> LocalTaskExecutionError {
    worker_error(error.to_string())
}

fn worker_error(message: impl Into<String>) -> LocalTaskExecutionError {
    LocalTaskExecutionError {
        message: message.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::retry_backoff_seconds;

    #[test]
    fn projection_retry_backoff_is_bounded() {
        assert_eq!(retry_backoff_seconds(1), 1);
        assert_eq!(retry_backoff_seconds(2), 2);
        assert_eq!(retry_backoff_seconds(7), 60);
        assert_eq!(retry_backoff_seconds(u64::MAX), 60);
    }
}
