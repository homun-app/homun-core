use crate::{AppState, LocalTaskExecutionError};
use local_first_task_runtime::{
    ProjectionClaim, ProjectionErrorEvidence, TaskId, UserId, WorkspaceId,
    projection_outbox::CHAT_LIFECYCLE_PROJECTION,
};
use std::sync::{
    Mutex, OnceLock,
    atomic::{AtomicBool, AtomicU64, Ordering},
};
use time::OffsetDateTime;
use tokio::sync::Notify;

const MAX_DRAIN_BATCH: usize = 1_024;
const MAX_RETRY_BACKOFF_SECONDS: i64 = 60;
const CLAIM_HEARTBEAT_SECONDS: u64 = 30;

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
    let result = run_supervised_drain(state.clone()).await;
    if let Err(error) = &result {
        record_worker_failure(error);
    }
    result
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
            if let Err(error) = run_supervised_drain(state.clone()).await {
                record_worker_failure(&error);
                eprintln!("execution projection worker: {}", error.message);
            }
        }
    });
}

async fn run_supervised_drain(state: AppState) -> Result<usize, LocalTaskExecutionError> {
    let attempt = tokio::spawn(async move { drain_available(&state).await });
    await_worker_attempt(attempt).await
}

async fn await_worker_attempt(
    attempt: tokio::task::JoinHandle<Result<usize, LocalTaskExecutionError>>,
) -> Result<usize, LocalTaskExecutionError> {
    attempt.await.map_err(|error| {
        worker_error(format!(
            "projection worker attempt panicked or was cancelled: {error}"
        ))
    })?
}

pub(crate) fn notify() {
    notify_handle().notify_one();
}

pub(crate) fn health_error() -> Option<String> {
    worker_health_error()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
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
            refresh_health_from_store(state, false)?;
            return Err(error);
        }
        processed = processed.saturating_add(1);
    }
    refresh_health_from_store(state, processed > 0)?;
    Ok(processed)
}

async fn process_claim(
    state: &AppState,
    claim: &ProjectionClaim,
) -> Result<(), LocalTaskExecutionError> {
    let source = {
        let store = state.task_store.lock().map_err(worker_lock_error)?;
        store
            .assert_projection_claim_current(claim)
            .map_err(worker_store_error)?;
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
            .map_err(worker_store_error)?;
        let terminal_ref =
            terminal_projection_ref(&claim.record.execution_id, claim.record.revision);
        match task {
            Some(task) => Some((task, execution.contract, outcome)),
            None if store
                .read_turn_events(&claim.record.execution_id, 0)
                .map_err(worker_store_error)?
                .iter()
                .any(|event| {
                    event
                        .payload
                        .get("projection_ref")
                        .and_then(serde_json::Value::as_str)
                        == Some(terminal_ref.as_str())
                }) =>
            {
                None
            }
            None => {
                return Err(worker_error(
                    "projection references a missing scoped task without acknowledgement",
                ));
            }
        }
    };
    let Some((task, contract, outcome)) = source else {
        return state
            .task_store
            .lock()
            .map_err(worker_lock_error)?
            .complete_projection(claim, OffsetDateTime::now_utc().unix_timestamp())
            .map_err(worker_store_error);
    };
    validate_binding(&task, &contract, claim)?;

    let _heartbeat = start_claim_heartbeat(state.clone(), claim.clone());
    let attempt =
        match crate::execution_runtime::should_project_chat(state, &task, outcome.as_ref()) {
            Ok(true) => {
                crate::execution_projection::project_chat_execution(
                    state,
                    &task,
                    &contract,
                    outcome.as_ref(),
                    Some(claim),
                )
                .await
            }
            Ok(false) => Ok(crate::execution_projection::ProjectionAttempt::Completed),
            Err(error) => Err(error),
        }?;
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

struct ClaimHeartbeat {
    handle: tokio::task::JoinHandle<()>,
}

impl Drop for ClaimHeartbeat {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

fn start_claim_heartbeat(state: AppState, claim: ProjectionClaim) -> ClaimHeartbeat {
    let handle = tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(CLAIM_HEARTBEAT_SECONDS)).await;
            let result = state
                .task_store
                .lock()
                .map_err(worker_lock_error)
                .and_then(|store| {
                    store
                        .renew_projection_claim(&claim, OffsetDateTime::now_utc().unix_timestamp())
                        .map_err(worker_store_error)
                });
            if let Err(error) = result {
                record_worker_failure(&error);
                eprintln!("execution projection heartbeat: {}", error.message);
                break;
            }
        }
    });
    ClaimHeartbeat { handle }
}

pub(crate) fn assert_claim_current(
    state: &AppState,
    claim: Option<&ProjectionClaim>,
) -> Result<(), LocalTaskExecutionError> {
    let Some(claim) = claim else {
        return Ok(());
    };
    state
        .task_store
        .lock()
        .map_err(worker_lock_error)?
        .assert_projection_claim_current(claim)
        .map_err(worker_store_error)
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

fn terminal_projection_ref(execution_id: &str, revision: u64) -> String {
    format!("{execution_id}:{revision}")
}

fn notify_handle() -> &'static Notify {
    WORKER_NOTIFY.get_or_init(Notify::new)
}

fn worker_health_error() -> &'static Mutex<Option<String>> {
    static ERROR: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    ERROR.get_or_init(|| Mutex::new(None))
}

fn set_health_error(error: Option<String>) {
    *worker_health_error()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = error;
}

fn record_worker_failure(error: &LocalTaskExecutionError) {
    set_health_error(Some(crate::redact_sensitive_text(&error.message)));
}

fn refresh_health_from_store(
    state: &AppState,
    made_progress: bool,
) -> Result<(), LocalTaskExecutionError> {
    let store = state.task_store.lock().map_err(worker_lock_error)?;
    let error = store
        .pending_projection_error(CHAT_LIFECYCLE_PROJECTION)
        .map_err(worker_store_error)?
        .map(|evidence| format!("{}: {}", evidence.code, evidence.redacted_detail));
    let has_unfinished = store
        .has_unfinished_projection(CHAT_LIFECYCLE_PROJECTION)
        .map_err(worker_store_error)?;
    if error.is_some() || made_progress || !has_unfinished {
        set_health_error(error);
    }
    Ok(())
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
    use super::{
        ClaimHeartbeat, await_worker_attempt, health_error, record_worker_failure,
        retry_backoff_seconds, set_health_error, terminal_projection_ref,
    };

    #[test]
    fn projection_retry_backoff_is_bounded() {
        assert_eq!(retry_backoff_seconds(1), 1);
        assert_eq!(retry_backoff_seconds(2), 2);
        assert_eq!(retry_backoff_seconds(7), 60);
        assert_eq!(retry_backoff_seconds(u64::MAX), 60);
    }

    #[test]
    fn terminal_acknowledgement_identity_excludes_outbox_kind() {
        assert_eq!(terminal_projection_ref("turn-1", 2), "turn-1:2");
    }

    #[test]
    fn unpersisted_worker_failure_is_visible_in_health() {
        set_health_error(None);
        record_worker_failure(&super::worker_error(
            "claim failed before retry persistence",
        ));
        assert_eq!(
            health_error().as_deref(),
            Some("claim failed before retry persistence")
        );
        set_health_error(None);
    }

    #[tokio::test]
    async fn dropping_claim_heartbeat_aborts_its_task() {
        let reached_tail = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let reached_tail_in_task = reached_tail.clone();
        let heartbeat = ClaimHeartbeat {
            handle: tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(25)).await;
                reached_tail_in_task.store(true, std::sync::atomic::Ordering::Release);
            }),
        };

        drop(heartbeat);
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        assert!(!reached_tail.load(std::sync::atomic::Ordering::Acquire));
    }

    #[tokio::test]
    async fn worker_supervisor_converts_panics_to_retryable_errors() {
        let attempt = tokio::spawn(async {
            panic!("projection panic");
            #[allow(unreachable_code)]
            Ok(0)
        });

        let error = await_worker_attempt(attempt)
            .await
            .expect_err("panic must not terminate the supervisor");

        assert!(error.message.contains("panicked"));
    }
}
