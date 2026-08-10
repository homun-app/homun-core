//! Turn broker: orchestration of the chat_turn lifecycle in the store.
//! Phase 0: testable synchronous primitives. Phase 1 wraps them in an async executor.

use crate::{
    NewTurnSteering, ResourceClass, ResourceRequirement, RetryPolicy, TaskId, TaskPriority,
    TaskRecord, TaskRuntimeError, TaskRuntimeResult, TaskStatus, TaskStore, TerminalWrite,
    TurnEvent, TurnEventKind, TurnSteeringRecord, UserId, WorkspaceId,
};
use local_first_execution_protocol::{CancelReason, ExecutionOutcome, ValidatedExecutionOutcome};
use rusqlite::{Connection, OptionalExtension};
use serde_json::{Value, json};
use time::OffsetDateTime;

/// Input for a new chat_turn. Prompt is embedded for atomicity.
#[derive(Debug, Clone)]
pub struct ChatTurnInput {
    pub thread_id: String,
    pub request_id: String,
    pub assistant_message_id: String,
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
    ThreadBusy {
        thread_id: String,
        active_turn_id: String,
    },
    Store(TaskRuntimeError),
}

impl From<TaskRuntimeError> for EnqueueError {
    fn from(e: TaskRuntimeError) -> Self {
        Self::Store(e)
    }
}

impl std::fmt::Display for EnqueueError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ThreadBusy {
                thread_id,
                active_turn_id,
            } => write!(
                f,
                "thread {thread_id} already has an active turn ({active_turn_id})"
            ),
            Self::Store(e) => write!(f, "store error: {e}"),
        }
    }
}

impl std::error::Error for EnqueueError {}

const TRANSIENT_ENQUEUE_ATTEMPTS: u32 = 5;

fn retry_transient_enqueue<T>(
    mut operation: impl FnMut() -> Result<T, EnqueueError>,
) -> Result<T, EnqueueError> {
    for attempt in 1..=TRANSIENT_ENQUEUE_ATTEMPTS {
        match operation() {
            Err(EnqueueError::Store(error))
                if error.is_transient_store_contention()
                    && attempt < TRANSIENT_ENQUEUE_ATTEMPTS =>
            {
                std::thread::sleep(std::time::Duration::from_millis(u64::from(attempt) * 40));
            }
            result => return result,
        }
    }
    unreachable!("the bounded enqueue retry loop always returns")
}

/// Result of a successful enqueue.
#[derive(Debug, Clone)]
pub struct EnqueuedTurn {
    pub task_id: TaskId,
    pub thread_id: String,
    pub position_in_queue: u32,
}

#[derive(Debug, Clone)]
pub struct PromotedSteering {
    pub steering: TurnSteeringRecord,
    pub turn: EnqueuedTurn,
}

#[derive(Debug, Clone)]
pub enum EnqueueTurnOutcome {
    Enqueued(EnqueuedTurn),
    SteeringQueued {
        thread_id: String,
        active_turn_id: String,
        steering: Box<TurnSteeringRecord>,
    },
}

enum EnqueueOrSteerTransactionOutcome {
    Outcome(EnqueueTurnOutcome),
    ThreadBusy(String),
}

pub fn promote_held_turn_steering<F>(
    store: &TaskStore,
    user_id: &UserId,
    workspace_id: &WorkspaceId,
    steering_id: i64,
    expected_revision: u64,
    insert_turn_messages: F,
) -> Result<PromotedSteering, EnqueueError>
where
    F: FnOnce(&rusqlite::Transaction<'_>, &ChatTurnInput) -> TaskRuntimeResult<()>,
{
    store
        .with_transaction(|tx| {
            let steering = TaskStore::load_turn_steering_by_id_on(
                tx,
                steering_id,
                user_id.as_str(),
                workspace_id.as_str(),
            )?
            .ok_or_else(|| TaskRuntimeError::NotFound("steering".into()))?;
            if steering.status != crate::TurnSteeringStatus::Held
                || steering.revision != expected_revision
            {
                return Err(TaskRuntimeError::Conflict("held steering changed".into()));
            }
            if active_chat_turn_on(tx, &steering.thread_id)?.is_some() {
                return Err(TaskRuntimeError::Conflict(
                    "thread already has an active turn".into(),
                ));
            }
            let request_id = format!("steering_{}_{}", steering.steering_id, steering.revision);
            let input = ChatTurnInput {
                thread_id: steering.thread_id.clone(),
                request_id: request_id.clone(),
                assistant_message_id: format!("local_assistant_{request_id}"),
                prompt: steering.prompt.clone(),
                visible_prompt: Some(steering.visible_prompt.clone()),
                images: steering.images.clone(),
                attachments: Some(steering.attachments.clone()),
                mode: steering.mode.clone(),
                model: steering.model.clone(),
                source: ChatTurnSource::Interactive,
                approval: TurnApproval::Full,
            };
            let task = queued_chat_turn_task(user_id, workspace_id, &input);
            insert_turn_messages(tx, &input)?;
            insert_chat_turn_on(tx, &task, &input)?;
            let steering = TaskStore::promote_turn_steering_on(
                tx,
                steering_id,
                user_id.as_str(),
                workspace_id.as_str(),
                expected_revision,
            )?;
            Ok(PromotedSteering {
                steering,
                turn: EnqueuedTurn {
                    task_id: task.task_id,
                    thread_id: input.thread_id,
                    position_in_queue: 0,
                },
            })
        })
        .map_err(EnqueueError::Store)
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
        "assistant_message_id": input.assistant_message_id,
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
    if let Some(a) = store.active_chat_turn_for_thread(&input.thread_id)?
        && a != task.task_id.as_str()
    {
        // race lost: another turn slipped in. Cancel ours and return busy.
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

    let position_in_queue =
        count_queued_chat_turns_for_thread(store, user_id, workspace_id, &input.thread_id)?;

    Ok(EnqueuedTurn {
        task_id,
        thread_id: input.thread_id.clone(),
        position_in_queue,
    })
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
/// caller-provided user+assistant turn-message insert in the SAME SQLite transaction. If either
/// fails, both roll back — guaranteeing the prompt+turn atomicity invariant.
///
/// The `insert_turn_messages` closure receives a `&Transaction` and must insert
/// the linked user and assistant rows atomically (the caller owns the
/// chat_messages schema). It is responsible for checking same-turn idempotency
/// and rejecting incompatible message-id collisions; this crate deliberately
/// does not depend on chat_messages.
fn queued_chat_turn_task(
    user_id: &UserId,
    workspace_id: &WorkspaceId,
    input: &ChatTurnInput,
) -> TaskRecord {
    let task_id = chat_turn_task_id(&input.request_id);
    let now = OffsetDateTime::now_utc();
    let input_json = json!({
        "thread_id": input.thread_id,
        "request_id": input.request_id,
        "assistant_message_id": input.assistant_message_id,
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
    task
}

fn active_chat_turn_on(conn: &Connection, thread_id: &str) -> TaskRuntimeResult<Option<String>> {
    let query = format!(
        "SELECT task_id FROM tasks
         WHERE thread_id = ?1 AND kind = 'chat_turn'
           AND status NOT IN ({})
         LIMIT 1",
        crate::turn_lifecycle::ACTIVE_CHAT_TURN_EXCLUDED_SQL_STATUSES,
    );
    Ok(conn
        .query_row(&query, rusqlite::params![thread_id], |row| row.get(0))
        .optional()?)
}

fn insert_chat_turn_on(
    tx: &rusqlite::Transaction<'_>,
    task: &TaskRecord,
    input: &ChatTurnInput,
) -> TaskRuntimeResult<()> {
    let existing = tx
        .query_row(
            "SELECT task_json FROM tasks
             WHERE task_id = ?1 AND user_id = ?2 AND workspace_id = ?3",
            rusqlite::params![
                task.task_id.as_str(),
                task.user_id.as_str(),
                task.workspace_id.as_str(),
            ],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    if let Some(existing) = existing {
        let existing: TaskRecord = serde_json::from_str(&existing)
            .map_err(|error| TaskRuntimeError::Store(error.to_string()))?;
        let compatible = existing.kind == "chat_turn" && existing.input_json == task.input_json;
        if !compatible {
            return Err(TaskRuntimeError::Store(format!(
                "chat turn task id collision for {}",
                task.task_id.as_str()
            )));
        }
        // Same logical turn: preserve its stored status (including running or
        // terminal) rather than re-queueing it during a crash retry.
        return Ok(());
    }
    let task_json =
        serde_json::to_string(task).map_err(|error| TaskRuntimeError::Store(error.to_string()))?;
    tx.execute(
        "INSERT INTO tasks (
            task_id, user_id, workspace_id, workflow_id, kind, status, priority,
            created_at, updated_at, blocked_reason, task_json
        )
        VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?6, ?7, ?8, NULL, ?9)
        ",
        rusqlite::params![
            task.task_id.as_str(),
            task.user_id.as_str(),
            task.workspace_id.as_str(),
            task.kind,
            "queued",
            "high",
            task.created_at.unix_timestamp(),
            task.updated_at.unix_timestamp(),
            task_json,
        ],
    )?;
    tx.execute(
        "UPDATE tasks SET thread_id = ?1, request_id = ?2, source = ?3, approval = ?4
         WHERE task_id = ?5 AND user_id = ?6 AND workspace_id = ?7",
        rusqlite::params![
            input.thread_id,
            input.request_id,
            input.source.as_str(),
            input.approval.as_str(),
            task.task_id.as_str(),
            task.user_id.as_str(),
            task.workspace_id.as_str(),
        ],
    )?;
    Ok(())
}

pub fn enqueue_chat_turn_atomic<F>(
    store: &TaskStore,
    user_id: &UserId,
    workspace_id: &WorkspaceId,
    input: &ChatTurnInput,
    insert_turn_messages: F,
) -> Result<EnqueuedTurn, EnqueueError>
where
    F: FnMut(&rusqlite::Transaction<'_>) -> TaskRuntimeResult<()>,
{
    let mut insert_turn_messages = insert_turn_messages;
    retry_transient_enqueue(|| {
        // Pre-check (the tx below hardens against races).
        if let Some(active) = store.active_chat_turn_for_thread(&input.thread_id)? {
            return Err(EnqueueError::ThreadBusy {
                thread_id: input.thread_id.clone(),
                active_turn_id: active,
            });
        }

        let task = queued_chat_turn_task(user_id, workspace_id, input);
        let task_id = task.task_id.clone();
        let active = store.with_transaction(|tx| {
            if let Some(active) = active_chat_turn_on(tx, &input.thread_id)? {
                return Ok(Some(active));
            }
            insert_turn_messages(tx)?;
            insert_chat_turn_on(tx, &task, input)?;
            Ok(None)
        })?;
        if let Some(active_turn_id) = active {
            return Err(EnqueueError::ThreadBusy {
                thread_id: input.thread_id.clone(),
                active_turn_id,
            });
        }

        Ok(EnqueuedTurn {
            task_id,
            thread_id: input.thread_id.clone(),
            position_in_queue: 0,
        })
    })
}

/// Interactive input submitted while a thread is active is user steering for
/// that run, not a competing turn. Persist only the steering envelope until a
/// round boundary claims and materializes it exactly once in the transcript.
pub fn enqueue_or_steer_chat_turn_atomic<F, G>(
    store: &TaskStore,
    user_id: &UserId,
    workspace_id: &WorkspaceId,
    input: &ChatTurnInput,
    insert_turn_messages: F,
    _insert_steering_user_message: G,
) -> Result<EnqueueTurnOutcome, EnqueueError>
where
    F: FnMut(&rusqlite::Transaction<'_>) -> TaskRuntimeResult<()>,
    G: FnOnce(&rusqlite::Transaction<'_>) -> TaskRuntimeResult<()>,
{
    let mut insert_turn_messages = insert_turn_messages;
    retry_transient_enqueue(|| {
        let objective_revision = store
            .load_objective_contract(user_id.as_str(), workspace_id.as_str(), &input.thread_id)?
            .map(|objective| objective.revision)
            .unwrap_or(0);
        let source_message_id = format!("local_user_{}", input.request_id);
        let steering_input = NewTurnSteering {
            source_message_id: source_message_id.clone(),
            prompt: input.prompt.clone(),
            visible_prompt: input
                .visible_prompt
                .clone()
                .unwrap_or_else(|| input.prompt.clone()),
            images: input.images.clone(),
            attachments: input
                .attachments
                .clone()
                .unwrap_or_else(|| Value::Array(Vec::new())),
            mode: input.mode.clone(),
            model: input.model.clone(),
        };
        let now = OffsetDateTime::now_utc().unix_timestamp();
        let task = queued_chat_turn_task(user_id, workspace_id, input);
        let outcome = store.with_transaction(|tx| {
            let Some(active_turn_id) = active_chat_turn_on(tx, &input.thread_id)? else {
                insert_turn_messages(tx)?;
                insert_chat_turn_on(tx, &task, input)?;
                return Ok(EnqueueOrSteerTransactionOutcome::Outcome(
                    EnqueueTurnOutcome::Enqueued(EnqueuedTurn {
                        task_id: task.task_id.clone(),
                        thread_id: input.thread_id.clone(),
                        position_in_queue: 0,
                    }),
                ));
            };
            if input.source != ChatTurnSource::Interactive {
                return Ok(EnqueueOrSteerTransactionOutcome::ThreadBusy(active_turn_id));
            }
            tx.execute(
                "INSERT INTO turn_steering (
                user_id, workspace_id, thread_id, active_turn_id, source_message_id,
                content, payload_json, objective_revision, status, revision, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'pending', 1, ?9, ?9)
             ON CONFLICT(user_id, workspace_id, thread_id, source_message_id) DO NOTHING",
                rusqlite::params![
                    user_id.as_str(),
                    workspace_id.as_str(),
                    input.thread_id,
                    active_turn_id,
                    source_message_id,
                    steering_input.prompt,
                    serde_json::to_string(&steering_input)?,
                    objective_revision as i64,
                    now,
                ],
            )?;
            let steering = crate::store::load_turn_steering_by_source_message(
                tx,
                user_id.as_str(),
                workspace_id.as_str(),
                &input.thread_id,
                &source_message_id,
            )?
            .ok_or_else(|| TaskRuntimeError::Store("steering disappeared after append".into()))?;
            Ok(EnqueueOrSteerTransactionOutcome::Outcome(
                EnqueueTurnOutcome::SteeringQueued {
                    thread_id: input.thread_id.clone(),
                    active_turn_id,
                    steering: Box::new(steering),
                },
            ))
        })?;
        match outcome {
            EnqueueOrSteerTransactionOutcome::Outcome(outcome) => Ok(outcome),
            EnqueueOrSteerTransactionOutcome::ThreadBusy(active_turn_id) => {
                Err(EnqueueError::ThreadBusy {
                    thread_id: input.thread_id.clone(),
                    active_turn_id,
                })
            }
        }
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
        if task.kind != "chat_turn" {
            continue;
        }
        if matches!(
            task.status,
            TaskStatus::Completed
                | TaskStatus::Failed
                | TaskStatus::Cancelled
                | TaskStatus::Expired
        ) {
            store.release_resources(&task)?;
            if task.lease_owner.is_some()
                || task.lease_expires_at.is_some()
                || task.last_heartbeat_at.is_some()
            {
                task.clear_lease();
                task.updated_at = OffsetDateTime::now_utc();
                store.insert_chat_turn(
                    &task,
                    task.input_json
                        .get("thread_id")
                        .and_then(|v| v.as_str())
                        .unwrap_or(""),
                    task.input_json
                        .get("request_id")
                        .and_then(|v| v.as_str())
                        .unwrap_or(""),
                    task.input_json
                        .get("source")
                        .and_then(|v| v.as_str())
                        .unwrap_or("interactive"),
                    task.input_json
                        .get("approval")
                        .and_then(|v| v.as_str())
                        .unwrap_or("full"),
                )?;
            }
            continue;
        }
        if task.status != TaskStatus::Running {
            if task.status == TaskStatus::WaitingResource
                && (store.has_resource_reservation(&task)?
                    || task.lease_owner.is_some()
                    || task.lease_expires_at.is_some()
                    || task.last_heartbeat_at.is_some())
            {
                store.abort_running_agent_runs_for_turn(
                    task.task_id.as_str(),
                    user_id.as_str(),
                    workspace_id.as_str(),
                    "gateway_restart",
                )?;
                store.release_resources(&task)?;
                task.status = TaskStatus::Queued;
                task.clear_lease();
                task.blocked_reason = Some("recovered at boot (stale resource reservation)".into());
                task.updated_at = OffsetDateTime::now_utc();
                let task_id = task.task_id.clone();
                store.insert_chat_turn(
                    &task,
                    task.input_json
                        .get("thread_id")
                        .and_then(|v| v.as_str())
                        .unwrap_or(""),
                    task.input_json
                        .get("request_id")
                        .and_then(|v| v.as_str())
                        .unwrap_or(""),
                    task.input_json
                        .get("source")
                        .and_then(|v| v.as_str())
                        .unwrap_or("interactive"),
                    task.input_json
                        .get("approval")
                        .and_then(|v| v.as_str())
                        .unwrap_or("full"),
                )?;
                store.insert_turn_event(
                    task_id.as_str(),
                    TurnEventKind::Aborted,
                    serde_json::json!({
                        "reason": "stale_resource_reservation_at_boot",
                        "generation": current_generation,
                    }),
                )?;
                recovered.push(task_id);
            }
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

        // The prior process can no longer append to this run. Preserve its exact event prefix and
        // close only the stale task's in-flight journal before requeueing a fresh broker attempt.
        store.abort_running_agent_runs_for_turn(
            task.task_id.as_str(),
            user_id.as_str(),
            workspace_id.as_str(),
            "gateway_restart",
        )?;

        // release resources, clear lease, re-queue
        store.release_resources(&task)?;
        task.status = TaskStatus::Queued;
        task.clear_lease();
        task.blocked_reason = Some("recovered at boot (stale lease)".into());
        task.updated_at = OffsetDateTime::now_utc();
        let task_id = task.task_id.clone();
        store.insert_chat_turn(
            &task,
            task.input_json
                .get("thread_id")
                .and_then(|v| v.as_str())
                .unwrap_or(""),
            task.input_json
                .get("request_id")
                .and_then(|v| v.as_str())
                .unwrap_or(""),
            task.input_json
                .get("source")
                .and_then(|v| v.as_str())
                .unwrap_or("interactive"),
            task.input_json
                .get("approval")
                .and_then(|v| v.as_str())
                .unwrap_or("full"),
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

/// Outcome of [`cancel_chat_turn`].
#[derive(Debug, Clone)]
pub struct CancelChatTurnOutcome {
    /// True when the task transitioned to `Cancelled` (it was not already terminal).
    pub cancelled: bool,
    /// The canonical `cancelled` terminal event, ONLY when this call inserted it
    /// (`TerminalWrite::Inserted`). `None` on a no-op cancel or when a terminal
    /// event already existed — in both cases the caller must NOT broadcast it:
    /// the original writer owns the live fan-out.
    pub terminal_event: Option<TurnEvent>,
}

/// Marks a chat_turn as Cancelled (durable source of truth) and notifies the in-process
/// executor via hook. Idempotent: no-op if already terminal (Completed/Failed/Cancelled).
/// Writes a `cancelled` event in turn_events for subscribers.
///
/// Returns the persisted terminal event in [`CancelChatTurnOutcome::terminal_event`]
/// when THIS call inserted it: the caller owns broadcasting it live (the executor's
/// later `Cancelled` emit is silenced by the terminal-once guard).
pub fn cancel_chat_turn(
    store: &TaskStore,
    user_id: &UserId,
    workspace_id: &WorkspaceId,
    task_id: &TaskId,
    notify: &dyn CancelNotify,
) -> TaskRuntimeResult<CancelChatTurnOutcome> {
    let no_cancel = CancelChatTurnOutcome {
        cancelled: false,
        terminal_event: None,
    };
    let Some(mut task) = store.get_task(task_id, user_id, workspace_id)? else {
        return Ok(no_cancel);
    };
    if matches!(
        task.status,
        TaskStatus::Completed | TaskStatus::Failed | TaskStatus::Cancelled
    ) {
        return Ok(no_cancel); // idempotent
    }
    let was_running = task.status == TaskStatus::Running;
    let now = OffsetDateTime::now_utc();
    task.status = TaskStatus::Cancelled;
    task.blocked_reason = Some("cancelled by user/server".into());
    task.updated_at = now;
    store.release_resources(&task)?;
    if !was_running {
        task.clear_lease();
    }
    let thread_id = task
        .input_json
        .get("thread_id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let request_id = task
        .input_json
        .get("request_id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let source = task
        .input_json
        .get("source")
        .and_then(|v| v.as_str())
        .unwrap_or("interactive");
    let approval = task
        .input_json
        .get("approval")
        .and_then(|v| v.as_str())
        .unwrap_or("full");
    store.hold_pending_turn_steering(user_id.as_str(), workspace_id.as_str(), task_id.as_str())?;
    store.insert_chat_turn(&task, &thread_id, &request_id, source, approval)?;
    let terminal_event = match store.insert_terminal_event_once(
        task_id.as_str(),
        TurnEventKind::Cancelled,
        serde_json::json!({ "reason": "user_cancel", "at": now.unix_timestamp() }),
    )? {
        TerminalWrite::Inserted(event) => Some(event),
        // A racing writer already persisted the canonical terminal event and owns
        // its live broadcast — stay silent to keep the terminal-once contract.
        TerminalWrite::Existing(_) => None,
    };
    // A suspended turn keeps a pending wake in `execution_wakes`: delivering it
    // later would flip this cancelled task back to `queued`
    // (`project_legacy_task_ready_on`) and resurrect the same execution on the
    // next matching message. Discard the pending wakes, and commit the
    // `Cancelled` outcome on the execution's current revision when that revision
    // still has no outcome (wake already delivered but no attempt committed,
    // or created-but-never-run). A revision that already committed a
    // `Suspended` outcome is journal-sealed: with the wake gone it can never
    // be delivered again, and the task status + terminal turn event above are
    // the canonical cancel record.
    store.discard_pending_execution_wakes(task_id.as_str())?;
    if let Some(record) = store
        .execution(task_id.as_str())?
        .filter(|record| record.outcome.is_none())
    {
        let validated = ValidatedExecutionOutcome::new(
            ExecutionOutcome::Cancelled {
                reason: CancelReason::User,
            },
            &record.contract,
        )
        .map_err(|error| {
            TaskRuntimeError::Store(format!("cancelled execution outcome is invalid: {error}"))
        })?;
        store.commit_execution_outcome(&validated)?;
    }
    // notify the in-process executor (instant); no-op if not active
    notify.notify_cancel(task_id.as_str());
    Ok(CancelChatTurnOutcome {
        cancelled: true,
        terminal_event,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{TaskStatus, TaskStore, UserId, WorkspaceId};

    fn store() -> TaskStore {
        TaskStore::open_in_memory().unwrap()
    }
    fn input(request_id: &str, thread_id: &str) -> ChatTurnInput {
        ChatTurnInput {
            thread_id: thread_id.to_string(),
            request_id: request_id.to_string(),
            assistant_message_id: format!("local_assistant_{request_id}"),
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
        let r = enqueue_chat_turn(
            &s,
            &UserId::new("u"),
            &WorkspaceId::new("w"),
            &input("r1", "t1"),
        )
        .unwrap();
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
        enqueue_chat_turn(
            &s,
            &UserId::new("u"),
            &WorkspaceId::new("w"),
            &input("r1", "t1"),
        )
        .unwrap();
        let err = enqueue_chat_turn(
            &s,
            &UserId::new("u"),
            &WorkspaceId::new("w"),
            &input("r2", "t1"),
        )
        .unwrap_err();
        match err {
            EnqueueError::ThreadBusy {
                thread_id,
                active_turn_id,
            } => {
                assert_eq!(thread_id, "t1");
                assert_eq!(active_turn_id, "turn_r1");
            }
            other => panic!("expected ThreadBusy, got {other:?}"),
        }
    }

    #[test]
    fn enqueue_again_after_completion_succeeds() {
        let s = store();
        let r = enqueue_chat_turn(
            &s,
            &UserId::new("u"),
            &WorkspaceId::new("w"),
            &input("r1", "t1"),
        )
        .unwrap();
        s.update_task_status(
            &r.task_id,
            &UserId::new("u"),
            &WorkspaceId::new("w"),
            TaskStatus::Completed,
            None,
        )
        .unwrap();
        // now a new enqueue on the same thread must pass
        enqueue_chat_turn(
            &s,
            &UserId::new("u"),
            &WorkspaceId::new("w"),
            &input("r2", "t1"),
        )
        .expect("enqueue succeeds after previous turn completed");
    }

    #[test]
    fn enqueue_again_after_finalizing_succeeds() {
        let s = store();
        let user = UserId::new("u");
        let workspace = WorkspaceId::new("w");
        let r = enqueue_chat_turn(&s, &user, &workspace, &input("r1", "t1")).unwrap();
        s.update_task_status(&r.task_id, &user, &workspace, TaskStatus::Running, None)
            .unwrap();
        assert!(
            s.fence_chat_turn_finalization(user.as_str(), workspace.as_str(), r.task_id.as_str())
                .unwrap()
        );

        enqueue_chat_turn(&s, &user, &workspace, &input("r2", "t1"))
            .expect("finalizing is an internal free-thread state for enqueue");
    }

    #[test]
    fn different_threads_do_not_collide() {
        let s = store();
        enqueue_chat_turn(
            &s,
            &UserId::new("u"),
            &WorkspaceId::new("w"),
            &input("r1", "t1"),
        )
        .unwrap();
        enqueue_chat_turn(
            &s,
            &UserId::new("u"),
            &WorkspaceId::new("w"),
            &input("r2", "t2"),
        )
        .expect("different threads are independent");
    }
}

#[cfg(test)]
mod recovery_tests {
    use super::*;
    use crate::{
        AgentRunStatus, EffectReceiptClaim, NewAgentRun, NewExecutionEffectReceipt, TaskRecord,
        TaskStatus, TaskStore, UserId, WorkspaceId,
    };
    use local_first_execution_protocol::{EffectClass, EffectReceiptRef};
    use serde_json::json;
    use time::Duration;

    fn store() -> TaskStore {
        TaskStore::open_in_memory().unwrap()
    }

    fn seed_running_with_generation(store: &TaskStore, gen_val: u64) -> TaskId {
        // inserts a chat_turn Running with a lease_owner of the given generation
        let mut t = TaskRecord::new(
            "turn_stale",
            UserId::new("u"),
            WorkspaceId::new("w"),
            "chat_turn",
            "prompt",
            json!({
                "thread_id":"t1",
                "request_id":"r1",
                "assistant_message_id":"local_assistant_r1",
                "source":"interactive",
                "approval":"full"
            }),
        );
        t.status = TaskStatus::Running;
        t.lease_owner = Some(format!("{gen_val}:worker_0"));
        t.lease_expires_at = Some(time::OffsetDateTime::now_utc() + Duration::minutes(5));
        store
            .insert_chat_turn(&t, "t1", "r1", "interactive", "full")
            .unwrap();
        TaskId::new("turn_stale")
    }

    #[test]
    fn recover_requeues_stale_running_from_previous_generation() {
        let s = store();
        seed_running_with_generation(&s, 1);
        s.create_agent_run(&NewAgentRun {
            run_id: "run-stale".into(),
            turn_id: "turn_stale".into(),
            thread_id: "t1".into(),
            user_id: "u".into(),
            workspace_id: "w".into(),
            role: None,
            model: None,
            provider: None,
            prompt_fingerprint: None,
        })
        .unwrap();
        let receipt = NewExecutionEffectReceipt {
            receipt_ref: EffectReceiptRef::from_store_id("22222222222222222222222222222222")
                .unwrap(),
            execution_id: "turn_stale".into(),
            revision: 1,
            idempotency_key: "write_file:abc".into(),
            run_id: Some("run-stale".into()),
            thread_id: Some("t1".into()),
            user_id: "u".into(),
            workspace_id: "w".into(),
            effect_class: EffectClass::FilesystemWrite,
            operation: "write_file".into(),
            arguments_hash: "abc".into(),
            compensation: None,
        };
        s.prepare_effect_receipt(&receipt).unwrap();
        assert!(matches!(
            s.claim_effect_receipt(&receipt.receipt_ref).unwrap(),
            EffectReceiptClaim::Execute(_)
        ));
        // bump twice to simulate "we are generation 2, the lease is from generation 1"
        s.bump_process_generation().unwrap();
        let gen_now = s.bump_process_generation().unwrap();
        assert_eq!(gen_now, 2);
        let recovered =
            recover_chat_turns_at_boot(&s, &UserId::new("u"), &WorkspaceId::new("w"), gen_now)
                .unwrap();
        assert_eq!(recovered.len(), 1);
        // now it's Queued
        let t = s
            .get_task(
                &TaskId::new("turn_stale"),
                &UserId::new("u"),
                &WorkspaceId::new("w"),
            )
            .unwrap()
            .unwrap();
        assert_eq!(t.status, TaskStatus::Queued);
        assert!(t.lease_owner.is_none());
        assert_eq!(t.task_id.as_str(), "turn_stale");
        assert_eq!(t.input_json["assistant_message_id"], "local_assistant_r1");
        // and the aborted event was written
        let events = s.read_turn_events("turn_stale", 0).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, TurnEventKind::Aborted);
        assert!(events.iter().all(|event| !matches!(
            event.kind,
            TurnEventKind::Done | TurnEventKind::Error | TurnEventKind::Cancelled
        )));
        assert!(matches!(
            s.claim_effect_receipt(&receipt.receipt_ref).unwrap(),
            EffectReceiptClaim::Resolve(_)
        ));
        let runs = s.list_agent_runs_for_turn("turn_stale", "u", "w").unwrap();
        assert_eq!(runs[0].status, AgentRunStatus::Aborted);
        assert_eq!(runs[0].terminal_reason.as_deref(), Some("gateway_restart"));
        assert_eq!(
            s.list_agent_run_events("run-stale", "u", "w", None)
                .unwrap()
                .len(),
            1,
            "recovery preserves the exact durable event prefix"
        );
    }

    #[test]
    fn recover_does_not_touch_current_generation_running() {
        let s = store();
        let gen_now = s.bump_process_generation().unwrap(); // 1
        seed_running_with_generation(&s, gen_now); // lease of the current generation
        let recovered =
            recover_chat_turns_at_boot(&s, &UserId::new("u"), &WorkspaceId::new("w"), gen_now)
                .unwrap();
        assert!(
            recovered.is_empty(),
            "current-generation leases are left alone"
        );
    }

    #[test]
    fn recover_ignores_completed_chat_turns() {
        let s = store();
        let mut t = TaskRecord::new(
            "turn_done",
            UserId::new("u"),
            WorkspaceId::new("w"),
            "chat_turn",
            "prompt",
            json!({"thread_id":"t1","request_id":"r2","source":"interactive","approval":"full"}),
        );
        t.status = TaskStatus::Completed;
        s.insert_chat_turn(&t, "t1", "r2", "interactive", "full")
            .unwrap();
        let generation = s.bump_process_generation().unwrap();
        let recovered =
            recover_chat_turns_at_boot(&s, &UserId::new("u"), &WorkspaceId::new("w"), generation)
                .unwrap();
        assert!(recovered.is_empty());
    }

    #[test]
    fn recover_requeues_waiting_resource_turn_that_owns_stale_reservation() {
        let s = store();
        let user = UserId::new("u");
        let workspace = WorkspaceId::new("w");
        let mut task = TaskRecord::new(
            "turn_waiting_stale",
            user.clone(),
            workspace.clone(),
            "chat_turn",
            "prompt",
            json!({
                "thread_id": "t1",
                "request_id": "r_wait",
                "source": "interactive",
                "approval": "full"
            }),
        )
        .with_resource(ResourceRequirement::new(ResourceClass::BrowserSession, 1));
        task.status = TaskStatus::WaitingResource;
        task.blocked_reason =
            Some("resource browser_session requires 1 units but only 0 available".into());
        task.lease_owner = Some("dead-worker".into());
        task.lease_expires_at = Some(time::OffsetDateTime::now_utc() - Duration::minutes(1));
        s.insert_chat_turn(&task, "t1", "r_wait", "interactive", "full")
            .unwrap();
        s.reserve_resources(&task, "dead-worker").unwrap();

        let recovered = recover_chat_turns_at_boot(&s, &user, &workspace, 7).unwrap();

        assert_eq!(recovered, vec![TaskId::new("turn_waiting_stale")]);
        assert_eq!(
            s.resource_usage(&user, &workspace, ResourceClass::BrowserSession)
                .unwrap(),
            0
        );
        let stored = s
            .get_task(&TaskId::new("turn_waiting_stale"), &user, &workspace)
            .unwrap()
            .unwrap();
        assert_eq!(stored.status, TaskStatus::Queued);
        assert!(stored.lease_owner.is_none());
        assert!(stored.lease_expires_at.is_none());
        assert_eq!(
            stored.blocked_reason.as_deref(),
            Some("recovered at boot (stale resource reservation)")
        );
        let events = s.read_turn_events("turn_waiting_stale", 0).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, TurnEventKind::Aborted);
        assert_eq!(
            events[0].payload["reason"],
            "stale_resource_reservation_at_boot"
        );
    }

    #[test]
    fn recover_ignores_non_chat_turn_running() {
        let s = store();
        let mut other = TaskRecord::new(
            "bg1",
            UserId::new("u"),
            WorkspaceId::new("w"),
            "background_job",
            "thing",
            json!({}),
        );
        other.status = TaskStatus::Running;
        s.insert_task(&other).unwrap();
        let generation = s.bump_process_generation().unwrap();
        let recovered =
            recover_chat_turns_at_boot(&s, &UserId::new("u"), &WorkspaceId::new("w"), generation)
                .unwrap();
        assert!(
            recovered.is_empty(),
            "non-chat_turn tasks are not the broker's business"
        );
    }
}

#[cfg(test)]
mod cancel_tests {
    use super::*;
    use crate::{ResourceClass, TaskStatus, TaskStore, UserId, WorkspaceId};
    use std::sync::{Arc, Mutex};

    struct RecordingNotify {
        turns: Arc<Mutex<Vec<String>>>,
    }
    impl CancelNotify for RecordingNotify {
        fn notify_cancel(&self, turn_id: &str) {
            self.turns.lock().unwrap().push(turn_id.into());
        }
    }

    fn make_input(request_id: &str, thread_id: &str) -> ChatTurnInput {
        ChatTurnInput {
            thread_id: thread_id.to_string(),
            request_id: request_id.to_string(),
            assistant_message_id: format!("local_assistant_{request_id}"),
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
        let r = enqueue_chat_turn(
            &s,
            &UserId::new("u"),
            &WorkspaceId::new("w"),
            &make_input("r1", "t1"),
        )
        .unwrap();
        let turns = Arc::new(Mutex::new(Vec::new()));
        let notify = RecordingNotify {
            turns: turns.clone(),
        };
        let outcome = cancel_chat_turn(
            &s,
            &UserId::new("u"),
            &WorkspaceId::new("w"),
            &r.task_id,
            &notify,
        )
        .unwrap();
        assert!(outcome.cancelled);
        // The caller receives the persisted terminal event so it can broadcast it
        // live (the executor's own Cancelled emit is silenced by terminal-once).
        let event = outcome.terminal_event.expect("inserted terminal event");
        assert_eq!(event.kind, TurnEventKind::Cancelled);
        assert_eq!(event.turn_id, r.task_id.as_str());
        assert_eq!(
            event.payload.get("reason").and_then(Value::as_str),
            Some("user_cancel")
        );
        let t = s
            .get_task(&r.task_id, &UserId::new("u"), &WorkspaceId::new("w"))
            .unwrap()
            .unwrap();
        assert_eq!(t.status, TaskStatus::Cancelled);
        let events = s.read_turn_events(r.task_id.as_str(), 0).unwrap();
        assert!(events.iter().any(|e| e.kind == TurnEventKind::Cancelled));
        assert_eq!(
            events
                .iter()
                .find(|e| e.kind == TurnEventKind::Cancelled)
                .unwrap()
                .seq,
            event.seq,
            "the surfaced event is the persisted one"
        );
        assert_eq!(
            turns.lock().unwrap().clone(),
            vec![r.task_id.as_str().to_string()]
        );
    }

    #[test]
    fn cancel_is_idempotent_on_terminal() {
        let s = TaskStore::open_in_memory().unwrap();
        let r = enqueue_chat_turn(
            &s,
            &UserId::new("u"),
            &WorkspaceId::new("w"),
            &make_input("r1", "t1"),
        )
        .unwrap();
        s.update_task_status(
            &r.task_id,
            &UserId::new("u"),
            &WorkspaceId::new("w"),
            TaskStatus::Completed,
            None,
        )
        .unwrap();
        let notify = NoopCancelNotify;
        let outcome = cancel_chat_turn(
            &s,
            &UserId::new("u"),
            &WorkspaceId::new("w"),
            &r.task_id,
            &notify,
        )
        .unwrap();
        assert!(!outcome.cancelled, "no-op on already-terminal turn");
        assert!(
            outcome.terminal_event.is_none(),
            "no terminal event to broadcast on a no-op cancel"
        );
    }

    #[test]
    fn cancel_releases_resources_when_turn_is_not_running() {
        let s = TaskStore::open_in_memory().unwrap();
        let user = UserId::new("u");
        let workspace = WorkspaceId::new("w");
        let r = enqueue_chat_turn(&s, &user, &workspace, &make_input("r1", "t1")).unwrap();
        let task = s.get_task(&r.task_id, &user, &workspace).unwrap().unwrap();
        s.reserve_resources(&task, "stale-worker").unwrap();
        assert_eq!(
            s.resource_usage(&user, &workspace, ResourceClass::BrowserSession)
                .unwrap(),
            1
        );

        assert!(
            cancel_chat_turn(&s, &user, &workspace, &r.task_id, &NoopCancelNotify)
                .unwrap()
                .cancelled
        );

        assert_eq!(
            s.resource_usage(&user, &workspace, ResourceClass::BrowserSession)
                .unwrap(),
            0
        );
    }

    #[test]
    fn cancel_releases_resources_when_turn_is_running_but_preserves_lease() {
        let s = TaskStore::open_in_memory().unwrap();
        let user = UserId::new("u");
        let workspace = WorkspaceId::new("w");
        let r = enqueue_chat_turn(&s, &user, &workspace, &make_input("r1", "t1")).unwrap();
        let mut task = s.get_task(&r.task_id, &user, &workspace).unwrap().unwrap();
        task.status = TaskStatus::Running;
        task.lease_owner = Some("1:worker-a".into());
        s.insert_chat_turn(&task, "t1", "r1", "interactive", "full")
            .unwrap();
        s.reserve_resources(&task, "worker-a").unwrap();
        assert_eq!(
            s.resource_usage(&user, &workspace, ResourceClass::BrowserSession)
                .unwrap(),
            1
        );

        assert!(
            cancel_chat_turn(&s, &user, &workspace, &r.task_id, &NoopCancelNotify)
                .unwrap()
                .cancelled
        );

        let cancelled = s.get_task(&r.task_id, &user, &workspace).unwrap().unwrap();
        assert_eq!(cancelled.status, TaskStatus::Cancelled);
        assert_eq!(cancelled.lease_owner.as_deref(), Some("1:worker-a"));
        assert_eq!(
            s.resource_usage(&user, &workspace, ResourceClass::BrowserSession)
                .unwrap(),
            0
        );
    }

    #[test]
    fn cancel_of_a_parked_turn_ends_cancelled_with_exactly_one_terminal_event() {
        // Steering park+resume (Build 2): a Parked turn is active (not in the
        // idempotent guard's completed|failed|cancelled exclusion set) and has NO
        // live executor (already unregistered/aborted at park time — see
        // `park_chat_turn`). This exercises the store-level half of "cancel-of-parked"
        // (task-runtime has no notion of the chat bubble; that finalize lives in the
        // gateway and is covered there): the task must still end up genuinely
        // `Cancelled`, with exactly one durable `Cancelled` terminal event.
        let s = TaskStore::open_in_memory().unwrap();
        let user = UserId::new("u");
        let workspace = WorkspaceId::new("w");
        let r = enqueue_chat_turn(&s, &user, &workspace, &make_input("r1", "t1")).unwrap();
        let mut task = s.get_task(&r.task_id, &user, &workspace).unwrap().unwrap();
        task.status = TaskStatus::Running;
        s.insert_chat_turn(&task, "t1", "r1", "interactive", "full")
            .unwrap();
        s.reserve_resources(&task, "worker-a").unwrap();

        s.park_chat_turn(r.task_id.as_str(), "u", "w").unwrap();
        let parked = s.get_task(&r.task_id, &user, &workspace).unwrap().unwrap();
        assert_eq!(
            parked.status,
            TaskStatus::Parked,
            "precondition: turn is parked"
        );
        assert_eq!(
            s.resource_usage(&user, &workspace, ResourceClass::BrowserSession)
                .unwrap(),
            0,
            "park already released the browser_session slot"
        );

        let parked_cancel =
            cancel_chat_turn(&s, &user, &workspace, &r.task_id, &NoopCancelNotify).unwrap();
        assert!(
            parked_cancel.cancelled,
            "a parked turn is still cancellable"
        );
        assert!(
            parked_cancel.terminal_event.is_some(),
            "the cancel that inserted the terminal event surfaces it for broadcast"
        );

        let cancelled = s.get_task(&r.task_id, &user, &workspace).unwrap().unwrap();
        assert_eq!(cancelled.status, TaskStatus::Cancelled);

        let events = s.read_turn_events(r.task_id.as_str(), 0).unwrap();
        assert_eq!(
            events
                .iter()
                .filter(|e| e.kind == TurnEventKind::Cancelled)
                .count(),
            1,
            "exactly one Cancelled terminal event"
        );

        // Idempotent: cancelling the now-Cancelled turn again is a no-op and does
        // not mint a second terminal event (nor surface one to broadcast).
        let recancel =
            cancel_chat_turn(&s, &user, &workspace, &r.task_id, &NoopCancelNotify).unwrap();
        assert!(!recancel.cancelled);
        assert!(recancel.terminal_event.is_none());
        let events_after = s.read_turn_events(r.task_id.as_str(), 0).unwrap();
        assert_eq!(
            events_after
                .iter()
                .filter(|e| e.kind == TurnEventKind::Cancelled)
                .count(),
            1
        );
    }

    #[test]
    fn boot_recovery_releases_terminal_turn_resources_and_lease() {
        let s = TaskStore::open_in_memory().unwrap();
        let user = UserId::new("u");
        let workspace = WorkspaceId::new("w");
        let r = enqueue_chat_turn(&s, &user, &workspace, &make_input("r1", "t1")).unwrap();
        let mut task = s.get_task(&r.task_id, &user, &workspace).unwrap().unwrap();
        s.reserve_resources(&task, "dead-worker").unwrap();
        task.status = TaskStatus::Cancelled;
        task.lease_owner = Some("old-generation:dead-worker".into());
        task.lease_expires_at = Some(OffsetDateTime::now_utc());
        task.last_heartbeat_at = Some(OffsetDateTime::now_utc());
        s.insert_chat_turn(&task, "t1", "r1", "interactive", "full")
            .unwrap();

        let recovered = recover_chat_turns_at_boot(&s, &user, &workspace, 7).unwrap();

        assert!(recovered.is_empty());
        assert_eq!(
            s.resource_usage(&user, &workspace, ResourceClass::BrowserSession)
                .unwrap(),
            0
        );
        let stored = s.get_task(&r.task_id, &user, &workspace).unwrap().unwrap();
        assert!(stored.lease_owner.is_none());
        assert!(stored.lease_expires_at.is_none());
        assert!(stored.last_heartbeat_at.is_none());
    }

    /// Builds the execution-protocol fixtures a suspended chat turn needs:
    /// validated contract + `Suspended` outcome carrying a `User` wake.
    fn suspend_execution_with_user_wake(
        s: &TaskStore,
        task: &TaskRecord,
        thread_id: &str,
    ) -> local_first_execution_protocol::WakeCondition {
        use local_first_execution_protocol::{
            CheckpointDataRef, CheckpointEnvelope, DurableDataRef, ExecutionContract,
            ExecutionScope, ValidatedExecutionContract,
        };
        let contract = ValidatedExecutionContract::try_from(ExecutionContract::new(
            task.task_id.as_str(),
            "chat_turn",
            ExecutionScope {
                user_id: task.user_id.as_str().into(),
                workspace_id: task.workspace_id.as_str().into(),
                thread_id: Some(thread_id.into()),
            },
            serde_json::to_value(task).unwrap(),
        ))
        .unwrap();
        let wake = local_first_execution_protocol::WakeCondition::User {
            wait_ref: format!("{}:1:user", task.task_id.as_str()),
        };
        let suspended = ValidatedExecutionOutcome::new(
            ExecutionOutcome::Suspended {
                wake: wake.clone(),
                checkpoint: CheckpointEnvelope::new(
                    task.task_id.as_str(),
                    1,
                    "chat_turn",
                    1,
                    CheckpointDataRef::Public {
                        record_ref: DurableDataRef::from_store_id(
                            "0123456789abcdef0123456789abcdef",
                        )
                        .unwrap(),
                    },
                ),
            },
            &contract,
        )
        .unwrap();
        s.create_execution(&contract).unwrap();
        s.commit_execution_outcome(&suspended).unwrap();
        wake
    }

    #[test]
    fn cancel_of_a_suspended_turn_discards_pending_wakes() {
        // The Stop-flow resurrection bug: a suspended turn keeps a pending wake
        // in `execution_wakes`; if a cancel leaves it behind, delivering it
        // later flips the cancelled task back to `queued`. Cancel must discard
        // every pending wake of the execution.
        let s = TaskStore::open_in_memory().unwrap();
        let user = UserId::new("u");
        let workspace = WorkspaceId::new("w");
        let r = enqueue_chat_turn(&s, &user, &workspace, &make_input("r1", "t1")).unwrap();
        let task = s.get_task(&r.task_id, &user, &workspace).unwrap().unwrap();
        suspend_execution_with_user_wake(&s, &task, "t1");
        assert_eq!(
            s.pending_execution_wakes(user.as_str(), workspace.as_str(), Some("t1"))
                .unwrap()
                .len(),
            1,
            "precondition: the suspended revision registered a pending user wake"
        );

        let outcome =
            cancel_chat_turn(&s, &user, &workspace, &r.task_id, &NoopCancelNotify).unwrap();
        assert!(outcome.cancelled);
        assert!(
            s.pending_execution_wakes(user.as_str(), workspace.as_str(), Some("t1"))
                .unwrap()
                .is_empty(),
            "cancel must discard the pending wake or the cancelled turn resurrects"
        );
        // The suspended revision is journal-sealed (it already committed its
        // `Suspended` outcome): cancel must not force a second outcome onto it,
        // and the stored outcome stays Suspended.
        let record = s.execution(r.task_id.as_str()).unwrap().unwrap();
        let sealed_outcome = record
            .outcome
            .clone()
            .expect("suspended revision has an outcome")
            .into_inner();
        assert!(
            matches!(sealed_outcome, ExecutionOutcome::Suspended { .. }),
            "the sealed revision keeps its Suspended outcome"
        );
    }

    #[test]
    fn cancel_commits_cancelled_outcome_on_an_outcomeless_execution() {
        // Created-but-never-finished execution (no outcome on the current
        // revision): cancel seals it with a `Cancelled` outcome instead of
        // leaving the execution projection dangling.
        let s = TaskStore::open_in_memory().unwrap();
        let user = UserId::new("u");
        let workspace = WorkspaceId::new("w");
        let r = enqueue_chat_turn(&s, &user, &workspace, &make_input("r1", "t1")).unwrap();
        let task = s.get_task(&r.task_id, &user, &workspace).unwrap().unwrap();
        let contract = local_first_execution_protocol::ValidatedExecutionContract::try_from(
            local_first_execution_protocol::ExecutionContract::new(
                task.task_id.as_str(),
                "chat_turn",
                local_first_execution_protocol::ExecutionScope {
                    user_id: user.as_str().into(),
                    workspace_id: workspace.as_str().into(),
                    thread_id: Some("t1".into()),
                },
                serde_json::to_value(&task).unwrap(),
            ),
        )
        .unwrap();
        s.create_execution(&contract).unwrap();

        let outcome =
            cancel_chat_turn(&s, &user, &workspace, &r.task_id, &NoopCancelNotify).unwrap();
        assert!(outcome.cancelled);
        let record = s.execution(r.task_id.as_str()).unwrap().unwrap();
        let committed = record
            .outcome
            .clone()
            .expect("cancel commits an outcome on the execution")
            .into_inner();
        assert!(
            matches!(
                committed,
                ExecutionOutcome::Cancelled {
                    reason: CancelReason::User
                }
            ),
            "the outcomeless revision is sealed with a user Cancelled outcome"
        );
    }
}

#[cfg(test)]
mod atomic_tests {
    use super::*;
    use crate::{TaskStore, UserId, WorkspaceId};

    fn make_input(request_id: &str, thread_id: &str) -> ChatTurnInput {
        ChatTurnInput {
            thread_id: thread_id.to_string(),
            request_id: request_id.to_string(),
            assistant_message_id: format!("local_assistant_{request_id}"),
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
    fn transient_enqueue_contention_retries_with_a_fresh_attempt() {
        let mut attempts = 0;
        let result = retry_transient_enqueue(|| {
            attempts += 1;
            if attempts < 3 {
                Err(EnqueueError::Store(TaskRuntimeError::Store(
                    "database is locked".into(),
                )))
            } else {
                Ok("enqueued")
            }
        });

        assert_eq!(result.unwrap(), "enqueued");
        assert_eq!(attempts, 3);
    }

    #[test]
    fn permanent_enqueue_errors_are_not_retried() {
        let mut attempts = 0;
        let result: Result<(), EnqueueError> = retry_transient_enqueue(|| {
            attempts += 1;
            Err(EnqueueError::Store(TaskRuntimeError::Store(
                "no such table: tasks".into(),
            )))
        });

        assert!(matches!(result, Err(EnqueueError::Store(_))));
        assert_eq!(attempts, 1);
    }

    #[test]
    fn retryable_turn_keeps_one_assistant_message_id() {
        let store = TaskStore::open_in_memory().unwrap();
        let mut input = make_input("r1", "t1");
        input.assistant_message_id = "local_assistant_r1".into();
        let user = UserId::new("u");
        let workspace = WorkspaceId::new("w");
        store
            .with_transaction(|tx| {
                tx.execute_batch(
                    "create table test_turn_messages (
                        id text primary key,
                        role text not null
                    )",
                )?;
                Ok(())
            })
            .unwrap();
        let user_message_id = "local_user_r1";
        let assistant_message_id = input.assistant_message_id.clone();
        let enqueued = enqueue_chat_turn_atomic(&store, &user, &workspace, &input, |tx| {
            tx.execute(
                "insert into test_turn_messages (id, role) values (?1, 'user')",
                rusqlite::params![user_message_id],
            )?;
            tx.execute(
                "insert into test_turn_messages (id, role) values (?1, 'assistant')",
                rusqlite::params![assistant_message_id],
            )?;
            Ok(())
        })
        .unwrap();
        let turn_messages: Vec<(String, String)> = store
            .with_transaction(|tx| {
                let mut statement =
                    tx.prepare("select id, role from test_turn_messages order by role")?;
                statement
                    .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                    .collect::<rusqlite::Result<_>>()
                    .map_err(Into::into)
            })
            .unwrap();
        assert_eq!(
            turn_messages,
            vec![
                (assistant_message_id, "assistant".to_string()),
                (user_message_id.to_string(), "user".to_string()),
            ]
        );
        let task = store
            .get_task(&enqueued.task_id, &user, &workspace)
            .unwrap()
            .unwrap();
        assert_eq!(
            task.input_json["assistant_message_id"],
            "local_assistant_r1"
        );
    }

    #[test]
    fn same_logical_turn_retry_preserves_terminal_task_state() {
        let store = TaskStore::open_in_memory().unwrap();
        let user = UserId::new("u");
        let workspace = WorkspaceId::new("w");
        let input = make_input("r1", "t1");
        let first =
            enqueue_chat_turn_atomic(&store, &user, &workspace, &input, |_tx| Ok(())).unwrap();
        store
            .update_task_status(
                &first.task_id,
                &user,
                &workspace,
                TaskStatus::Completed,
                None,
            )
            .unwrap();

        let retried =
            enqueue_chat_turn_atomic(&store, &user, &workspace, &input, |_tx| Ok(())).unwrap();

        assert_eq!(retried.task_id, first.task_id);
        let task = store
            .get_task(&first.task_id, &user, &workspace)
            .unwrap()
            .unwrap();
        assert_eq!(task.status, TaskStatus::Completed);
        assert_eq!(task.input_json["thread_id"], "t1");
        assert_eq!(task.input_json["request_id"], "r1");
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
            "turn_messages closure should NOT be called when pre-check fails"
        );
    }

    #[test]
    fn busy_interactive_turn_is_atomically_queued_as_steering() {
        let s = TaskStore::open_in_memory().unwrap();
        let active = enqueue_chat_turn(
            &s,
            &UserId::new("u"),
            &WorkspaceId::new("w"),
            &make_input("r1", "t1"),
        )
        .unwrap();
        let called = std::sync::Arc::new(std::sync::Mutex::new(false));
        let called_clone = called.clone();

        let outcome = enqueue_or_steer_chat_turn_atomic(
            &s,
            &UserId::new("u"),
            &WorkspaceId::new("w"),
            &make_input("r2", "t1"),
            |_tx| Ok(()),
            |_tx| {
                *called_clone.lock().unwrap() = true;
                Ok(())
            },
        )
        .unwrap();

        assert!(matches!(
            outcome,
            EnqueueTurnOutcome::SteeringQueued {
                active_turn_id,
                ..
            } if active_turn_id == active.task_id.as_str()
        ));
        assert!(
            !*called.lock().unwrap(),
            "pending steering must stay out of the transcript until claim"
        );
        let steering = s
            .consume_pending_turn_steering("u", "w", "t1", active.task_id.as_str())
            .unwrap();
        assert_eq!(steering.len(), 1);
        assert_eq!(steering[0].source_message_id, "local_user_r2");
        assert_eq!(steering[0].content, "p");
        assert_eq!(
            s.active_chat_turn_for_thread("t1").unwrap(),
            Some("turn_r1".into())
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
        assert!(
            result.is_ok(),
            "atomic enqueue should succeed: {:?}",
            result.err()
        );
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
