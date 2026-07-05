//! Turn broker: orchestration of the chat_turn lifecycle in the store.
//! Phase 0: testable synchronous primitives. Phase 1 wraps them in an async executor.

use crate::{
    TaskId, TaskPriority, TaskRecord, TaskRuntimeError, TaskRuntimeResult, TaskStatus, TaskStore,
    TurnEventKind, UserId, WorkspaceId,
};
use serde_json::{json, Value};
use time::OffsetDateTime;

/// Input for a new chat_turn. Prompt is embedded for atomicity.
#[derive(Debug, Clone)]
pub struct ChatTurnInput {
    pub thread_id: String,
    pub request_id: String,
    pub prompt: String,
    pub visible_prompt: Option<String>,
    pub attachments: Option<Value>,
    pub mode: Option<String>,
    pub model: Option<String>,
    pub source: ChatTurnSource,
    pub approval: TurnApproval,
}

/// Origin of the turn. Discriminator for executor + visibility in the queue.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChatTurnSource {
    Interactive,
    Automation,
    Channel,
    Connector,
}

impl ChatTurnSource {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Interactive => "interactive",
            Self::Automation => "automation",
            Self::Channel => "channel",
            Self::Connector => "connector",
        }
    }
}

/// Allowed effects policy. Maps to input_json.approval of the existing executor.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnApproval {
    Full,       // interactive turns
    Confirm,    // automation with ApprovalPolicy::Confirm
    Autonomous, // automation with ApprovalPolicy::Autonomous
    ReadOnly,
}

impl TurnApproval {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Full => "full",
            Self::Confirm => "confirm",
            Self::Autonomous => "autonomous",
            Self::ReadOnly => "read_only",
        }
    }
}

/// Enqueue error. ThreadBusy → 409 in the gateway.
#[derive(Debug)]
pub enum EnqueueError {
    ThreadBusy { thread_id: String, active_turn_id: String },
    Store(TaskRuntimeError),
}

impl From<TaskRuntimeError> for EnqueueError {
    fn from(e: TaskRuntimeError) -> Self { Self::Store(e) }
}

impl std::fmt::Display for EnqueueError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ThreadBusy { thread_id, active_turn_id } => write!(
                f, "thread {thread_id} already has an active turn ({active_turn_id})"
            ),
            Self::Store(e) => write!(f, "store error: {e}"),
        }
    }
}

impl std::error::Error for EnqueueError {}

/// Result of a successful enqueue.
#[derive(Debug, Clone)]
pub struct EnqueuedTurn {
    pub task_id: TaskId,
    pub thread_id: String,
    pub position_in_queue: u32,
}

/// Generates a chat_turn task_id. Stable, debuggable.
pub fn chat_turn_task_id(request_id: &str) -> TaskId {
    // request_id is already unique ("chat_stream_<ts>_<rand>" or "autorun_<uuid>");
    // using it as the base for task_id makes the turn_id ↔ request_id join direct.
    TaskId::new(format!("turn_{request_id}"))
}

/// Transactional enqueue: INSERT task(queued) + check 1-turn-per-thread constraint.
/// Returns ThreadBusy if the thread already has an active chat_turn.
pub fn enqueue_chat_turn(
    store: &TaskStore,
    user_id: &UserId,
    workspace_id: &WorkspaceId,
    input: &ChatTurnInput,
) -> Result<EnqueuedTurn, EnqueueError> {
    // Pre-check (the post-insert double-check below hardens against races; the pre-check
    // gives a clear error before constructing the task).
    if let Some(active) = store.active_chat_turn_for_thread(&input.thread_id)? {
        return Err(EnqueueError::ThreadBusy {
            thread_id: input.thread_id.clone(),
            active_turn_id: active,
        });
    }

    let task_id = chat_turn_task_id(&input.request_id);
    let now = OffsetDateTime::now_utc();
    let input_json = json!({
        "thread_id": input.thread_id,
        "request_id": input.request_id,
        "prompt": input.prompt,
        "visible_prompt": input.visible_prompt,
        "attachments": input.attachments,
        "mode": input.mode,
        "model": input.model,
        "source": input.source.as_str(),
        "approval": input.approval.as_str(),
    });

    let mut task = TaskRecord::new(
        task_id.as_str(),
        user_id.clone(),
        workspace_id.clone(),
        "chat_turn",
        input.prompt.clone(),
        input_json,
    );
    task.status = TaskStatus::Queued;
    task.priority = match input.source {
        ChatTurnSource::Interactive => TaskPriority::High,
        ChatTurnSource::Channel => TaskPriority::Low,
        ChatTurnSource::Automation | ChatTurnSource::Connector => TaskPriority::Background,
    };
    task.created_at = now;
    task.updated_at = now;

    store.insert_chat_turn(
        &task,
        &input.thread_id,
        &input.request_id,
        input.source.as_str(),
        input.approval.as_str(),
    )?;

    // Post-insert double-check: if a race inserted a second concurrent turn for the same
    // thread, back out. SELECT + INSERT isn't in the same tx here (SQLite serialized helps
    // but isn't guaranteed under WAL); the double-check handles the edge case in
    // single-process. (In single-process with an external mutex this never happens; kept
    // as defensive coverage.)
    if let Some(a) = store.active_chat_turn_for_thread(&input.thread_id)? {
        if a != task.task_id.as_str() {
            // race lost: another turn slipped in. Cancel ours and return busy.
            store.update_task_status(
                &task.task_id, user_id, workspace_id,
                TaskStatus::Cancelled, Some("race lost on thread enqueue"),
            )?;
            return Err(EnqueueError::ThreadBusy {
                thread_id: input.thread_id.clone(),
                active_turn_id: a,
            });
        }
    }

    let position_in_queue =
        count_queued_chat_turns_for_thread(store, user_id, workspace_id, &input.thread_id)?;

    Ok(EnqueuedTurn { task_id, thread_id: input.thread_id.clone(), position_in_queue })
}

fn count_queued_chat_turns_for_thread(
    _store: &TaskStore,
    _user_id: &UserId,
    _workspace_id: &WorkspaceId,
    _thread_id: &str,
) -> TaskRuntimeResult<u32> {
    // With the 1-turn-per-thread constraint the queue is always empty or has the turn just
    // inserted, so position is always 0. Kept as a hook for a future FIFO-multi extension.
    Ok(0)
}

/// Lease-aware recovery at boot. Call AFTER `bump_process_generation`.
///
/// Rule: every chat_turn Running whose lease_owner does NOT belong to the current
/// generation is stale (the process that held it has died). We re-queue it (status=Queued,
/// clear the lease) and write an `aborted` event in turn_events (so a reconnecting client
/// knows to discard the previous execution's deltas).
///
/// In single-process today: all Running have a previous generation (we just started) →
/// all are re-queued. Respects the LeaseManager even in multi-process (current-generation
/// leases are left alone).
pub fn recover_chat_turns_at_boot(
    store: &TaskStore,
    user_id: &UserId,
    workspace_id: &WorkspaceId,
    current_generation: u64,
) -> TaskRuntimeResult<Vec<TaskId>> {
    let mut recovered = Vec::new();
    for mut task in store.list_tasks(user_id, workspace_id)? {
        if task.kind != "chat_turn" || task.status != TaskStatus::Running {
            continue;
        }
        // lease_owner has the form "<generation>:<worker_id>". If the generation is the
        // current one, the worker is (theoretically) still active: leave it alone. In
        // single-process just after start this branch is impossible — the check is for
        // future multi-process defense.
        let owned_by_current = task
            .lease_owner
            .as_deref()
            .and_then(|o| o.split(':').next())
            .map(|g| g.parse::<u64>().ok() == Some(current_generation))
            .unwrap_or(false);
        if owned_by_current {
            continue;
        }

        // release resources, clear lease, re-queue
        store.release_resources(&task)?;
        task.status = TaskStatus::Queued;
        task.lease_owner = None;
        task.lease_expires_at = None;
        task.last_heartbeat_at = None;
        task.blocked_reason = Some("recovered at boot (stale lease)".into());
        task.updated_at = OffsetDateTime::now_utc();
        let task_id = task.task_id.clone();
        store.insert_chat_turn(
            &task,
            task.input_json.get("thread_id").and_then(|v| v.as_str()).unwrap_or(""),
            task.input_json.get("request_id").and_then(|v| v.as_str()).unwrap_or(""),
            task.input_json.get("source").and_then(|v| v.as_str()).unwrap_or("interactive"),
            task.input_json.get("approval").and_then(|v| v.as_str()).unwrap_or("full"),
        )?;

        // aborted marker: the reconnecting client discards previous deltas
        let turn_id = task_id.as_str().to_string();
        store.insert_turn_event(
            &turn_id,
            TurnEventKind::Aborted,
            serde_json::json!({
                "reason": "lease_expired_at_boot",
                "generation": current_generation,
            }),
        )?;

        recovered.push(task_id);
    }
    Ok(recovered)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{TaskStore, TaskStatus, UserId, WorkspaceId};

    fn store() -> TaskStore { TaskStore::open_in_memory().unwrap() }
    fn input(request_id: &str, thread_id: &str) -> ChatTurnInput {
        ChatTurnInput {
            thread_id: thread_id.to_string(),
            request_id: request_id.to_string(),
            prompt: "hi".into(),
            visible_prompt: None,
            attachments: None,
            mode: None,
            model: None,
            source: ChatTurnSource::Interactive,
            approval: TurnApproval::Full,
        }
    }

    #[test]
    fn enqueue_succeeds_on_idle_thread() {
        let s = store();
        let r = enqueue_chat_turn(&s, &UserId::new("u"), &WorkspaceId::new("w"), &input("r1", "t1")).unwrap();
        assert_eq!(r.thread_id, "t1");
        assert_eq!(r.task_id.as_str(), "turn_r1");
    }

    #[test]
    fn enqueue_returns_thread_busy_on_second_active_turn() {
        let s = store();
        enqueue_chat_turn(&s, &UserId::new("u"), &WorkspaceId::new("w"), &input("r1", "t1")).unwrap();
        let err = enqueue_chat_turn(&s, &UserId::new("u"), &WorkspaceId::new("w"), &input("r2", "t1")).unwrap_err();
        match err {
            EnqueueError::ThreadBusy { thread_id, active_turn_id } => {
                assert_eq!(thread_id, "t1");
                assert_eq!(active_turn_id, "turn_r1");
            }
            other => panic!("expected ThreadBusy, got {other:?}"),
        }
    }

    #[test]
    fn enqueue_again_after_completion_succeeds() {
        let s = store();
        let r = enqueue_chat_turn(&s, &UserId::new("u"), &WorkspaceId::new("w"), &input("r1", "t1")).unwrap();
        s.update_task_status(&r.task_id, &UserId::new("u"), &WorkspaceId::new("w"),
                             TaskStatus::Completed, None).unwrap();
        // now a new enqueue on the same thread must pass
        enqueue_chat_turn(&s, &UserId::new("u"), &WorkspaceId::new("w"), &input("r2", "t1"))
            .expect("enqueue succeeds after previous turn completed");
    }

    #[test]
    fn different_threads_do_not_collide() {
        let s = store();
        enqueue_chat_turn(&s, &UserId::new("u"), &WorkspaceId::new("w"), &input("r1", "t1")).unwrap();
        enqueue_chat_turn(&s, &UserId::new("u"), &WorkspaceId::new("w"), &input("r2", "t2"))
            .expect("different threads are independent");
    }
}

#[cfg(test)]
mod recovery_tests {
    use super::*;
    use crate::{TaskRecord, TaskStore, TaskStatus, UserId, WorkspaceId};
    use serde_json::json;
    use time::Duration;

    fn store() -> TaskStore { TaskStore::open_in_memory().unwrap() }

    fn seed_running_with_generation(store: &TaskStore, gen_val: u64) -> TaskId {
        // inserts a chat_turn Running with a lease_owner of the given generation
        let mut t = TaskRecord::new(
            "turn_stale", UserId::new("u"), WorkspaceId::new("w"),
            "chat_turn", "prompt",
            json!({"thread_id":"t1","request_id":"r1","source":"interactive","approval":"full"}),
        );
        t.status = TaskStatus::Running;
        t.lease_owner = Some(format!("{gen_val}:worker_0"));
        t.lease_expires_at = Some(time::OffsetDateTime::now_utc() + Duration::minutes(5));
        store.insert_chat_turn(&t, "t1", "r1", "interactive", "full").unwrap();
        TaskId::new("turn_stale")
    }

    #[test]
    fn recover_requeues_stale_running_from_previous_generation() {
        let s = store();
        seed_running_with_generation(&s, 1);
        // bump twice to simulate "we are generation 2, the lease is from generation 1"
        s.bump_process_generation().unwrap();
        let gen_now = s.bump_process_generation().unwrap();
        assert_eq!(gen_now, 2);
        let recovered = recover_chat_turns_at_boot(&s, &UserId::new("u"), &WorkspaceId::new("w"), gen_now).unwrap();
        assert_eq!(recovered.len(), 1);
        // now it's Queued
        let t = s.get_task(&TaskId::new("turn_stale"), &UserId::new("u"), &WorkspaceId::new("w")).unwrap().unwrap();
        assert_eq!(t.status, TaskStatus::Queued);
        assert!(t.lease_owner.is_none());
        // and the aborted event was written
        let events = s.read_turn_events("turn_stale", 0).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, TurnEventKind::Aborted);
    }

    #[test]
    fn recover_does_not_touch_current_generation_running() {
        let s = store();
        let gen_now = s.bump_process_generation().unwrap(); // 1
        seed_running_with_generation(&s, gen_now); // lease of the current generation
        let recovered = recover_chat_turns_at_boot(&s, &UserId::new("u"), &WorkspaceId::new("w"), gen_now).unwrap();
        assert!(recovered.is_empty(), "current-generation leases are left alone");
    }

    #[test]
    fn recover_ignores_completed_chat_turns() {
        let s = store();
        let mut t = TaskRecord::new(
            "turn_done", UserId::new("u"), WorkspaceId::new("w"),
            "chat_turn", "prompt",
            json!({"thread_id":"t1","request_id":"r2","source":"interactive","approval":"full"}),
        );
        t.status = TaskStatus::Completed;
        s.insert_chat_turn(&t, "t1", "r2", "interactive", "full").unwrap();
        let generation = s.bump_process_generation().unwrap();
        let recovered =
            recover_chat_turns_at_boot(&s, &UserId::new("u"), &WorkspaceId::new("w"), generation)
                .unwrap();
        assert!(recovered.is_empty());
    }

    #[test]
    fn recover_ignores_non_chat_turn_running() {
        let s = store();
        let mut other = TaskRecord::new(
            "bg1", UserId::new("u"), WorkspaceId::new("w"),
            "background_job", "thing", json!({}),
        );
        other.status = TaskStatus::Running;
        s.insert_task(&other).unwrap();
        let generation = s.bump_process_generation().unwrap();
        let recovered =
            recover_chat_turns_at_boot(&s, &UserId::new("u"), &WorkspaceId::new("w"), generation)
                .unwrap();
        assert!(recovered.is_empty(), "non-chat_turn tasks are not the broker's business");
    }
}
