//! Turn broker: orchestration of the chat_turn lifecycle in the store.
//! Phase 0: testable synchronous primitives. Phase 1 wraps them in an async executor.

use crate::{
    ResourceClass, ResourceRequirement, RetryPolicy, TaskId, TaskPriority, TaskRecord,
    TaskRuntimeError, TaskRuntimeResult, TaskStatus, TaskStore, TurnEventKind, UserId, WorkspaceId,
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
    /// Inline image data URLs from the composer. Clipboard images have no host
    /// path, so the durable task must carry their content to its worker.
    pub images: Vec<String>,
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

/// Retry policy for a chat_turn, by source. Transient failures (LLM 5xx, timeout,
/// rate limit) get retried; once attempts are exhausted the turn goes to `failed`
/// (never to the `waiting_external_event` limbo — that would soft-lock the thread
/// forever on a turn the user can't unstick). Interactive turns retry less
/// aggressively than automation because the user is waiting on screen.
pub fn chat_turn_retry_policy(source: ChatTurnSource) -> RetryPolicy {
    match source {
        ChatTurnSource::Interactive => RetryPolicy {
            max_attempts: 2,
            backoff_seconds: 15,
        },
        ChatTurnSource::Channel => RetryPolicy {
            max_attempts: 3,
            backoff_seconds: 30,
        },
        ChatTurnSource::Automation | ChatTurnSource::Connector => RetryPolicy {
            max_attempts: 3,
            backoff_seconds: 60,
        },
    }
}

/// Resource requirements for a chat_turn in agent mode. The agent MAY use the
/// shared browser at any point during the turn, so every agent turn reserves one
/// `BrowserSession` unit up front. The ResourceGovernor (limit=1 in
/// `conservative_defaults`) then guarantees only one chat_turn drives the single
/// shared Chromium at a time — superseding the old `browse_web_lock` Mutex. The
/// inline lock remains as a defensive backstop (double-gating), but the governor
/// is now the authoritative gate: it surfaces a turn as `WaitingResource` (visible
/// to the user via the existing turn_events path) instead of FIFO-blocking silently.
pub fn chat_turn_resource_requirements() -> Vec<ResourceRequirement> {
    vec![ResourceRequirement::new(ResourceClass::BrowserSession, 1)]
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
        "images": input.images,
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
    task.retry_policy = chat_turn_retry_policy(input.source);
    task.resource_requirements = chat_turn_resource_requirements();
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

/// Atomic variant of `enqueue_chat_turn`: runs the broker insert AND a
/// caller-provided chat_message insert in the SAME SQLite transaction. If either
/// fails, both roll back — guaranteeing the prompt+turn atomicity invariant.
///
/// The `insert_user_message` closure receives a `&Transaction` and must insert
/// the user message row (the caller knows the chat_messages schema, which lives
/// in chat_store). It should be idempotent on the request_id (use INSERT OR IGNORE)
/// so re-enqueue after a crash doesn't duplicate.
pub fn enqueue_chat_turn_atomic<F>(
    store: &TaskStore,
    user_id: &UserId,
    workspace_id: &WorkspaceId,
    input: &ChatTurnInput,
    insert_user_message: F,
) -> Result<EnqueuedTurn, EnqueueError>
where
    F: FnOnce(&rusqlite::Transaction<'_>) -> TaskRuntimeResult<()>,
{
    // Pre-check (the tx below hardens against races).
    if let Some(active) = store.active_chat_turn_for_thread(&input.thread_id)? {
        return Err(EnqueueError::ThreadBusy {
            thread_id: input.thread_id.clone(),
            active_turn_id: active,
        });
    }

    let task_id = chat_turn_task_id(&input.request_id);
    let now = OffsetDateTime::now_utc();
    let input_json = serde_json::json!({
        "thread_id": input.thread_id,
        "request_id": input.request_id,
        "prompt": input.prompt,
        "visible_prompt": input.visible_prompt,
        "images": input.images,
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
    task.retry_policy = chat_turn_retry_policy(input.source);
    task.resource_requirements = chat_turn_resource_requirements();
    task.created_at = now;
    task.updated_at = now;

    // Atomic section: insert_user_message + insert task in one tx.
    let task_clone = task.clone();
    let thread_id = input.thread_id.clone();
    let request_id = input.request_id.clone();
    let source = input.source.as_str().to_string();
    let approval = input.approval.as_str().to_string();
    store.with_transaction(|tx| {
        // Caller inserts the chat message in the same tx.
        insert_user_message(tx)?;

        // Insert the task + indexed columns in the same tx.
        let task_json = serde_json::to_string(&task_clone)
            .map_err(|e| TaskRuntimeError::Store(e.to_string()))?;
        tx.execute(
            "INSERT INTO tasks (
                task_id, user_id, workspace_id, workflow_id, kind, status, priority,
                created_at, updated_at, blocked_reason, task_json
            )
            VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?6, ?7, ?8, NULL, ?9)
            ON CONFLICT(task_id, user_id, workspace_id) DO UPDATE SET
                kind = excluded.kind, status = excluded.status, priority = excluded.priority,
                updated_at = excluded.updated_at, task_json = excluded.task_json",
            rusqlite::params![
                task_clone.task_id.as_str(),
                task_clone.user_id.as_str(),
                task_clone.workspace_id.as_str(),
                task_clone.kind,
                "queued",
                "high",
                now.unix_timestamp(),
                now.unix_timestamp(),
                task_json,
            ],
        )?;
        tx.execute(
            "UPDATE tasks SET thread_id = ?1, request_id = ?2, source = ?3, approval = ?4
             WHERE task_id = ?5 AND user_id = ?6 AND workspace_id = ?7",
            rusqlite::params![
                thread_id, request_id, source, approval,
                task_clone.task_id.as_str(),
                task_clone.user_id.as_str(),
                task_clone.workspace_id.as_str(),
            ],
        )?;
        Ok(())
    })?;

    // Post-insert double-check (outside tx).
    if let Some(a) = store.active_chat_turn_for_thread(&input.thread_id)? {
        if a != task.task_id.as_str() {
            store.update_task_status(
                &task.task_id,
                user_id,
                workspace_id,
                TaskStatus::Cancelled,
                Some("race lost on thread enqueue"),
            )?;
            return Err(EnqueueError::ThreadBusy {
                thread_id: input.thread_id.clone(),
                active_turn_id: a,
            });
        }
    }

    Ok(EnqueuedTurn {
        task_id,
        thread_id: input.thread_id.clone(),
        position_in_queue: 0,
    })
}


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

/// Cancel notification hook: the gateway (Phase 1) implements this with a tokio::sync::Notify
/// per turn_id in the active-executor registry. Phase 0: default no-op.
/// The executor receives the cancel via this channel (instant) + via DB poll (fallback).
pub trait CancelNotify: Send + Sync {
    fn notify_cancel(&self, turn_id: &str);
}

/// Default no-op cancel notify (Phase 0: the in-process notify lives in the gateway, not here).
pub struct NoopCancelNotify;
impl CancelNotify for NoopCancelNotify {
    fn notify_cancel(&self, _turn_id: &str) {}
}

/// Marks a chat_turn as Cancelled (durable source of truth) and notifies the in-process
/// executor via hook. Idempotent: no-op if already terminal (Completed/Failed/Cancelled).
/// Writes a `cancelled` event in turn_events for subscribers.
pub fn cancel_chat_turn(
    store: &TaskStore,
    user_id: &UserId,
    workspace_id: &WorkspaceId,
    task_id: &TaskId,
    notify: &dyn CancelNotify,
) -> TaskRuntimeResult<bool> {
    let Some(mut task) = store.get_task(task_id, user_id, workspace_id)? else {
        return Ok(false);
    };
    if matches!(task.status, TaskStatus::Completed | TaskStatus::Failed | TaskStatus::Cancelled) {
        return Ok(false); // idempotent
    }
    let now = OffsetDateTime::now_utc();
    task.status = TaskStatus::Cancelled;
    task.blocked_reason = Some("cancelled by user/server".into());
    task.updated_at = now;
    let thread_id = task.input_json.get("thread_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let request_id = task.input_json.get("request_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let source = task.input_json.get("source").and_then(|v| v.as_str()).unwrap_or("interactive");
    let approval = task.input_json.get("approval").and_then(|v| v.as_str()).unwrap_or("full");
    store.insert_chat_turn(&task, &thread_id, &request_id, source, approval)?;
    store.insert_turn_event(
        task_id.as_str(),
        TurnEventKind::Cancelled,
        serde_json::json!({ "reason": "user_cancel", "at": now.unix_timestamp() }),
    )?;
    // notify the in-process executor (instant); no-op if not active
    notify.notify_cancel(task_id.as_str());
    Ok(true)
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
            images: Vec::new(),
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
    fn enqueue_persists_inline_images_for_the_executor() {
        let s = store();
        let mut turn = input("r1", "t1");
        turn.images = vec!["data:image/png;base64,AA==".to_string()];

        let enqueued = enqueue_chat_turn(&s, &UserId::new("u"), &WorkspaceId::new("w"), &turn)
            .expect("enqueue image turn");
        let stored = s
            .get_task(&enqueued.task_id, &UserId::new("u"), &WorkspaceId::new("w"))
            .expect("load queued turn")
            .expect("queued turn exists");

        assert_eq!(
            stored.input_json["images"],
            serde_json::json!(["data:image/png;base64,AA=="]),
        );
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

#[cfg(test)]
mod cancel_tests {
    use super::*;
    use crate::{TaskStore, TaskStatus, UserId, WorkspaceId};
    use std::sync::{Arc, Mutex};

    struct RecordingNotify { turns: Arc<Mutex<Vec<String>>> }
    impl CancelNotify for RecordingNotify {
        fn notify_cancel(&self, turn_id: &str) { self.turns.lock().unwrap().push(turn_id.into()); }
    }

    fn make_input(request_id: &str, thread_id: &str) -> ChatTurnInput {
        ChatTurnInput {
            thread_id: thread_id.to_string(),
            request_id: request_id.to_string(),
            prompt: "hi".into(),
            visible_prompt: None,
            images: Vec::new(),
            attachments: None,
            mode: None,
            model: None,
            source: ChatTurnSource::Interactive,
            approval: TurnApproval::Full,
        }
    }

    #[test]
    fn cancel_marks_cancelled_and_writes_event_and_notifies() {
        let s = TaskStore::open_in_memory().unwrap();
        let r = enqueue_chat_turn(&s, &UserId::new("u"), &WorkspaceId::new("w"), &make_input("r1", "t1")).unwrap();
        let turns = Arc::new(Mutex::new(Vec::new()));
        let notify = RecordingNotify { turns: turns.clone() };
        let ok = cancel_chat_turn(&s, &UserId::new("u"), &WorkspaceId::new("w"), &r.task_id, &notify).unwrap();
        assert!(ok);
        let t = s.get_task(&r.task_id, &UserId::new("u"), &WorkspaceId::new("w")).unwrap().unwrap();
        assert_eq!(t.status, TaskStatus::Cancelled);
        let events = s.read_turn_events(r.task_id.as_str(), 0).unwrap();
        assert!(events.iter().any(|e| e.kind == TurnEventKind::Cancelled));
        assert_eq!(turns.lock().unwrap().clone(), vec![r.task_id.as_str().to_string()]);
    }

    #[test]
    fn cancel_is_idempotent_on_terminal() {
        let s = TaskStore::open_in_memory().unwrap();
        let r = enqueue_chat_turn(&s, &UserId::new("u"), &WorkspaceId::new("w"), &make_input("r1", "t1")).unwrap();
        s.update_task_status(&r.task_id, &UserId::new("u"), &WorkspaceId::new("w"),
            TaskStatus::Completed, None).unwrap();
        let notify = NoopCancelNotify;
        let ok = cancel_chat_turn(&s, &UserId::new("u"), &WorkspaceId::new("w"), &r.task_id, &notify).unwrap();
        assert!(!ok, "no-op on already-terminal turn");
    }
}

#[cfg(test)]
mod atomic_tests {
    use super::*;
    use crate::TaskStore;

    fn make_input(request_id: &str, thread_id: &str) -> ChatTurnInput {
        ChatTurnInput {
            thread_id: thread_id.to_string(),
            request_id: request_id.to_string(),
            prompt: "p".into(),
            visible_prompt: None,
            images: Vec::new(),
            attachments: None,
            mode: None,
            model: None,
            source: ChatTurnSource::Interactive,
            approval: TurnApproval::Full,
        }
    }

    #[test]
    fn atomic_enqueue_skips_closure_when_pre_check_fails() {
        let s = TaskStore::open_in_memory().unwrap();
        // Pre-insert a conflicting turn on the same thread.
        enqueue_chat_turn(
            &s,
            &UserId::new("u"),
            &WorkspaceId::new("w"),
            &make_input("r1", "t1"),
        )
        .unwrap();
        let called = std::sync::Arc::new(std::sync::Mutex::new(false));
        let called_clone = called.clone();
        let result = enqueue_chat_turn_atomic(
            &s,
            &UserId::new("u"),
            &WorkspaceId::new("w"),
            &make_input("r2", "t1"),
            |_tx| {
                *called_clone.lock().unwrap() = true;
                Ok(())
            },
        );
        assert!(matches!(result, Err(EnqueueError::ThreadBusy { .. })));
        assert!(
            !*called.lock().unwrap(),
            "user_message closure should NOT be called when pre-check fails"
        );
    }

    #[test]
    fn atomic_enqueue_runs_both_inserts_on_success() {
        let s = TaskStore::open_in_memory().unwrap();
        let called = std::sync::Arc::new(std::sync::Mutex::new(false));
        let called_clone = called.clone();
        let result = enqueue_chat_turn_atomic(
            &s,
            &UserId::new("u"),
            &WorkspaceId::new("w"),
            &make_input("r1", "t1"),
            |tx| {
                *called_clone.lock().unwrap() = true;
                // Simulate a chat_messages-like insert in the same tx.
                tx.execute_batch(
                    "CREATE TABLE IF NOT EXISTS chat_messages (id TEXT PRIMARY KEY);
                     INSERT INTO chat_messages VALUES ('local_user_r1');",
                )?;
                Ok(())
            },
        );
        assert!(result.is_ok(), "atomic enqueue should succeed: {:?}", result.err());
        assert!(*called.lock().unwrap());
        // The marker row landed in the same DB (atomicity verified) — read it
        // back via a public helper instead of the private `connection` field.
        // We rely on active_chat_turn_for_thread (public) to confirm the task
        // landed, and the closure's INSERT is implicitly verified because it
        // shared the same tx (if it hadn't landed, the task wouldn't either).
        let active = s.active_chat_turn_for_thread("t1").unwrap();
        assert_eq!(active.as_deref(), Some("turn_r1"));
    }

    #[test]
    fn atomic_enqueue_rolls_back_when_closure_fails() {
        let s = TaskStore::open_in_memory().unwrap();
        let result = enqueue_chat_turn_atomic(
            &s,
            &UserId::new("u"),
            &WorkspaceId::new("w"),
            &make_input("r1", "t1"),
            |_tx| {
                Err(TaskRuntimeError::Store(
                    "simulated chat_message insert failure".to_string(),
                ))
            },
        );
        assert!(result.is_err(), "should propagate the closure error");
        // Verify the task was NOT inserted (rolled back).
        let active = s.active_chat_turn_for_thread("t1").unwrap();
        assert!(
            active.is_none(),
            "task must not be inserted when the closure fails (rollback)"
        );
    }
}
