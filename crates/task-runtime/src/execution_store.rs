use crate::{TaskRuntimeError, TaskRuntimeResult, TaskStore};
use local_first_execution_protocol::{
    ExecutionContract, ExecutionOutcome, ExecutionState, ValidatedExecutionContract,
    ValidatedExecutionOutcome,
};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde_json::{Value, json};
use time::OffsetDateTime;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExecutionRecord {
    pub contract: ValidatedExecutionContract,
    pub state: ExecutionState,
    pub outcome: Option<ValidatedExecutionOutcome>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExecutionEvent {
    pub event_id: i64,
    pub execution_id: String,
    pub revision: u64,
    pub seq: u64,
    pub kind: String,
    pub payload: Value,
    pub created_at: i64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum OutcomeCommit {
    Inserted(ExecutionRecord),
    Existing(ExecutionRecord),
}

struct StoredExecution {
    record: ExecutionRecord,
    execution_id: String,
    kind: String,
    revision: i64,
    fencing_token: i64,
    outcome_json: Option<String>,
}

impl TaskStore {
    pub fn create_execution(
        &self,
        contract: &ValidatedExecutionContract,
    ) -> TaskRuntimeResult<ExecutionRecord> {
        let raw = contract.as_ref();
        let execution_id = validated_text(&raw.execution_id, "execution id")?;
        let revision = sqlite_integer(raw.revision, "execution revision")?;
        let fencing_token = sqlite_integer(raw.fencing_token, "execution fencing token")?;
        let contract_json = serde_json::to_string(raw)?;
        let now = OffsetDateTime::now_utc().unix_timestamp();
        let tx = Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;

        if tx
            .query_row(
                "SELECT 1 FROM executions WHERE execution_id = ?1",
                [execution_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some()
        {
            return Err(TaskRuntimeError::Conflict(format!(
                "execution already exists: {execution_id}"
            )));
        }

        tx.execute(
            "INSERT INTO executions (
                execution_id, parent_execution_id, kind, revision, fencing_token, state,
                user_id, workspace_id, thread_id, contract_json, outcome_json,
                outcome_committed_at, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, 'ready', ?6, ?7, ?8, ?9, NULL, NULL, ?10, ?10)",
            params![
                execution_id,
                raw.parent_execution_id.as_deref(),
                raw.kind,
                revision,
                fencing_token,
                raw.scope.user_id,
                raw.scope.workspace_id,
                raw.scope.thread_id.as_deref(),
                contract_json,
                now,
            ],
        )?;
        append_execution_event_on(
            &tx,
            execution_id,
            revision,
            "execution_created",
            &json!({"state": "ready"}),
        )?;
        let record = load_execution_on(&tx, execution_id)?
            .ok_or_else(|| TaskRuntimeError::Store("created execution disappeared".into()))?
            .record;
        tx.commit()?;
        Ok(record)
    }

    pub fn execution(&self, execution_id: &str) -> TaskRuntimeResult<Option<ExecutionRecord>> {
        let execution_id = validated_text(execution_id, "execution id")?;
        Ok(load_execution_on(&self.connection, execution_id)?.map(|stored| stored.record))
    }

    pub fn append_execution_event(
        &self,
        execution_id: &str,
        revision: u64,
        kind: &str,
        payload: &Value,
    ) -> TaskRuntimeResult<ExecutionEvent> {
        let execution_id = validated_text(execution_id, "execution id")?;
        let kind = validated_text(kind, "execution event kind")?;
        let revision = sqlite_integer(revision, "execution event revision")?;
        let tx = Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        require_execution_revision(&tx, execution_id, revision)?;
        let event = append_execution_event_on(&tx, execution_id, revision, kind, payload)?;
        tx.commit()?;
        Ok(event)
    }

    pub fn execution_events(
        &self,
        execution_id: &str,
        revision: u64,
    ) -> TaskRuntimeResult<Vec<ExecutionEvent>> {
        let execution_id = validated_text(execution_id, "execution id")?;
        let revision = sqlite_integer(revision, "execution event revision")?;
        require_execution_revision(&self.connection, execution_id, revision)?;
        let mut statement = self.connection.prepare(
            "SELECT event_id, execution_id, revision, seq, kind, payload_json, created_at
             FROM execution_events
             WHERE execution_id = ?1 AND revision = ?2
             ORDER BY seq ASC, event_id ASC",
        )?;
        let rows = statement.query_map(params![execution_id, revision], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, i64>(6)?,
            ))
        })?;

        rows.map(|row| {
            let (event_id, execution_id, revision, seq, kind, payload_json, created_at) = row?;
            if kind.trim().is_empty() {
                return Err(TaskRuntimeError::Store(
                    "stored execution event kind is blank".into(),
                ));
            }
            Ok(ExecutionEvent {
                event_id,
                execution_id,
                revision: stored_u64(revision, "execution event revision")?,
                seq: stored_u64(seq, "execution event sequence")?,
                kind,
                payload: serde_json::from_str(&payload_json).map_err(|error| {
                    TaskRuntimeError::Store(format!(
                        "stored execution event payload is invalid: {error}"
                    ))
                })?,
                created_at,
            })
        })
        .collect()
    }

    pub fn advance_execution_fence(
        &self,
        execution_id: &str,
        revision: u64,
        expected: u64,
        next: u64,
    ) -> TaskRuntimeResult<ExecutionRecord> {
        let execution_id = validated_text(execution_id, "execution id")?;
        if next <= expected {
            return Err(TaskRuntimeError::InvalidTransition(
                "next execution fence must be greater than expected fence".into(),
            ));
        }
        let revision = sqlite_integer(revision, "execution revision")?;
        let expected = sqlite_integer(expected, "expected execution fence")?;
        let next = sqlite_integer(next, "next execution fence")?;
        let tx = Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        let stored = load_execution_on(&tx, execution_id)?
            .ok_or_else(|| TaskRuntimeError::NotFound(format!("execution {execution_id}")))?;
        if stored.revision != revision || stored.fencing_token != expected {
            return Err(TaskRuntimeError::InvalidTransition(
                "execution revision or fencing token is stale".into(),
            ));
        }
        if stored.outcome_json.is_some() {
            return Err(TaskRuntimeError::InvalidTransition(
                "cannot advance the fence after an outcome is committed".into(),
            ));
        }

        let mut raw = stored.record.contract.into_inner();
        raw.fencing_token = stored_u64(next, "next execution fence")?;
        let updated_contract = ValidatedExecutionContract::try_from(raw).map_err(|error| {
            TaskRuntimeError::Store(format!("advanced execution contract is invalid: {error}"))
        })?;
        let contract_json = serde_json::to_string(updated_contract.as_ref())?;
        let now = OffsetDateTime::now_utc().unix_timestamp();
        let updated = tx.execute(
            "UPDATE executions
             SET fencing_token = ?1, contract_json = ?2, updated_at = ?3
             WHERE execution_id = ?4 AND revision = ?5 AND fencing_token = ?6",
            params![next, contract_json, now, execution_id, revision, expected],
        )?;
        if updated != 1 {
            return Err(TaskRuntimeError::InvalidTransition(
                "execution fence changed before it could be advanced".into(),
            ));
        }
        append_execution_event_on(
            &tx,
            execution_id,
            revision,
            "fence_advanced",
            &json!({"expected": expected, "next": next}),
        )?;
        let record = load_execution_on(&tx, execution_id)?
            .ok_or_else(|| TaskRuntimeError::Store("advanced execution disappeared".into()))?
            .record;
        tx.commit()?;
        Ok(record)
    }

    pub fn commit_execution_outcome(
        &self,
        outcome: &ValidatedExecutionOutcome,
    ) -> TaskRuntimeResult<OutcomeCommit> {
        let binding = outcome.binding();
        let execution_id = validated_text(binding.execution_id(), "execution id")?;
        let revision = sqlite_integer(binding.revision(), "execution outcome revision")?;
        let fencing_token =
            sqlite_integer(binding.fencing_token(), "execution outcome fencing token")?;
        let tx = Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        let stored = load_execution_on(&tx, execution_id)?.ok_or_else(|| {
            TaskRuntimeError::InvalidTransition(format!(
                "execution outcome binding references unknown execution {execution_id}"
            ))
        })?;

        if !binding.matches_persisted(
            &stored.execution_id,
            stored.revision,
            &stored.kind,
            stored.fencing_token,
        ) {
            return Err(TaskRuntimeError::InvalidTransition(
                "execution outcome binding does not match the persisted execution".into(),
            ));
        }

        let outcome_json = serde_json::to_string(outcome.as_ref())?;
        if let Some(existing_json) = stored.outcome_json.as_deref() {
            if existing_json == outcome_json {
                tx.commit()?;
                return Ok(OutcomeCommit::Existing(stored.record));
            }
            return Err(TaskRuntimeError::InvalidTransition(
                "a conflicting execution outcome is already committed".into(),
            ));
        }

        let state = state_for_outcome(outcome.as_ref());
        let now = OffsetDateTime::now_utc().unix_timestamp();
        let updated = tx.execute(
            "UPDATE executions
             SET state = ?1, outcome_json = ?2, outcome_committed_at = ?3, updated_at = ?3
             WHERE execution_id = ?4 AND revision = ?5 AND kind = ?6
               AND fencing_token = ?7 AND outcome_json IS NULL",
            params![
                state_name(&state),
                outcome_json,
                now,
                execution_id,
                revision,
                binding.kind(),
                fencing_token,
            ],
        )?;
        if updated != 1 {
            return Err(TaskRuntimeError::InvalidTransition(
                "execution outcome lost its transactional fence".into(),
            ));
        }
        append_execution_event_on(
            &tx,
            execution_id,
            revision,
            "outcome_committed",
            &json!({"state": state_name(&state)}),
        )?;
        let record = load_execution_on(&tx, execution_id)?
            .ok_or_else(|| TaskRuntimeError::Store("committed execution disappeared".into()))?
            .record;
        tx.commit()?;
        Ok(OutcomeCommit::Inserted(record))
    }
}

fn load_execution_on(
    connection: &Connection,
    execution_id: &str,
) -> TaskRuntimeResult<Option<StoredExecution>> {
    let row = connection
        .query_row(
            "SELECT execution_id, parent_execution_id, kind, revision, fencing_token, state,
                    user_id, workspace_id, thread_id, contract_json, outcome_json,
                    outcome_committed_at, created_at, updated_at
             FROM executions WHERE execution_id = ?1",
            [execution_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, Option<String>>(8)?,
                    row.get::<_, String>(9)?,
                    row.get::<_, Option<String>>(10)?,
                    row.get::<_, Option<i64>>(11)?,
                    row.get::<_, i64>(12)?,
                    row.get::<_, i64>(13)?,
                ))
            },
        )
        .optional()?;

    row.map(
        |(
            execution_id,
            parent_execution_id,
            kind,
            revision,
            fencing_token,
            state,
            user_id,
            workspace_id,
            thread_id,
            contract_json,
            outcome_json,
            outcome_committed_at,
            created_at,
            updated_at,
        )| {
            let raw_contract: ExecutionContract =
                serde_json::from_str(&contract_json).map_err(|error| {
                    TaskRuntimeError::Store(format!(
                        "stored execution contract JSON is invalid: {error}"
                    ))
                })?;
            let contract = ValidatedExecutionContract::try_from(raw_contract).map_err(|error| {
                TaskRuntimeError::Store(format!("stored execution contract is invalid: {error}"))
            })?;
            let raw = contract.as_ref();
            if raw.execution_id != execution_id
                || raw.parent_execution_id != parent_execution_id
                || raw.kind != kind
                || sqlite_integer_from_store(raw.revision, "contract revision")? != revision
                || sqlite_integer_from_store(raw.fencing_token, "contract fencing token")?
                    != fencing_token
                || raw.scope.user_id != user_id
                || raw.scope.workspace_id != workspace_id
                || raw.scope.thread_id != thread_id
            {
                return Err(TaskRuntimeError::Store(
                    "stored execution projection does not match contract JSON".into(),
                ));
            }

            let state = parse_state(&state)?;
            if outcome_json.is_some() != outcome_committed_at.is_some() {
                return Err(TaskRuntimeError::Store(
                    "stored execution outcome timestamp is inconsistent".into(),
                ));
            }
            let outcome = outcome_json
                .as_deref()
                .map(|json| {
                    let raw_outcome: ExecutionOutcome =
                        serde_json::from_str(json).map_err(|error| {
                            TaskRuntimeError::Store(format!(
                                "stored execution outcome JSON is invalid: {error}"
                            ))
                        })?;
                    ValidatedExecutionOutcome::new(raw_outcome, &contract).map_err(|error| {
                        TaskRuntimeError::Store(format!(
                            "stored execution outcome is invalid: {error}"
                        ))
                    })
                })
                .transpose()?;
            if let Some(outcome) = outcome.as_ref()
                && state_for_outcome(outcome.as_ref()) != state
            {
                return Err(TaskRuntimeError::Store(
                    "stored execution state does not match its outcome".into(),
                ));
            }

            Ok(StoredExecution {
                record: ExecutionRecord {
                    contract,
                    state,
                    outcome,
                    created_at,
                    updated_at,
                },
                execution_id,
                kind,
                revision,
                fencing_token,
                outcome_json,
            })
        },
    )
    .transpose()
}

fn append_execution_event_on(
    connection: &Connection,
    execution_id: &str,
    revision: i64,
    kind: &str,
    payload: &Value,
) -> TaskRuntimeResult<ExecutionEvent> {
    let current: Option<i64> = connection.query_row(
        "SELECT MAX(seq) FROM execution_events WHERE execution_id = ?1 AND revision = ?2",
        params![execution_id, revision],
        |row| row.get(0),
    )?;
    let seq = current
        .unwrap_or(0)
        .checked_add(1)
        .ok_or_else(|| TaskRuntimeError::Store("execution event sequence exhausted".into()))?;
    let now = OffsetDateTime::now_utc().unix_timestamp();
    connection.execute(
        "INSERT INTO execution_events (
            execution_id, revision, seq, kind, payload_json, created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            execution_id,
            revision,
            seq,
            kind,
            serde_json::to_string(payload)?,
            now,
        ],
    )?;
    Ok(ExecutionEvent {
        event_id: connection.last_insert_rowid(),
        execution_id: execution_id.to_string(),
        revision: stored_u64(revision, "execution event revision")?,
        seq: stored_u64(seq, "execution event sequence")?,
        kind: kind.to_string(),
        payload: payload.clone(),
        created_at: now,
    })
}

fn require_execution_revision(
    connection: &Connection,
    execution_id: &str,
    revision: i64,
) -> TaskRuntimeResult<()> {
    let stored_revision = connection
        .query_row(
            "SELECT revision FROM executions WHERE execution_id = ?1",
            [execution_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .ok_or_else(|| TaskRuntimeError::NotFound(format!("execution {execution_id}")))?;
    if stored_revision != revision {
        return Err(TaskRuntimeError::InvalidTransition(
            "execution event revision does not match persisted execution".into(),
        ));
    }
    Ok(())
}

fn validated_text<'a>(value: &'a str, field: &str) -> TaskRuntimeResult<&'a str> {
    if value.trim().is_empty() {
        return Err(TaskRuntimeError::InvalidTransition(format!(
            "{field} must not be blank"
        )));
    }
    Ok(value)
}

fn sqlite_integer(value: u64, field: &str) -> TaskRuntimeResult<i64> {
    i64::try_from(value).map_err(|_| {
        TaskRuntimeError::InvalidTransition(format!("{field} exceeds SQLite integer range"))
    })
}

fn sqlite_integer_from_store(value: u64, field: &str) -> TaskRuntimeResult<i64> {
    i64::try_from(value)
        .map_err(|_| TaskRuntimeError::Store(format!("stored {field} exceeds SQLite range")))
}

fn stored_u64(value: i64, field: &str) -> TaskRuntimeResult<u64> {
    u64::try_from(value).map_err(|_| TaskRuntimeError::Store(format!("stored {field} is negative")))
}

fn state_for_outcome(outcome: &ExecutionOutcome) -> ExecutionState {
    match outcome {
        ExecutionOutcome::Completed { .. } => ExecutionState::Completed,
        ExecutionOutcome::Suspended { .. } => ExecutionState::Suspended,
        ExecutionOutcome::Cancelled { .. } => ExecutionState::Cancelled,
        ExecutionOutcome::Failed { .. } => ExecutionState::Failed,
    }
}

fn state_name(state: &ExecutionState) -> &'static str {
    match state {
        ExecutionState::Ready => "ready",
        ExecutionState::Running => "running",
        ExecutionState::Suspended => "suspended",
        ExecutionState::Completed => "completed",
        ExecutionState::Cancelled => "cancelled",
        ExecutionState::Failed => "failed",
    }
}

fn parse_state(state: &str) -> TaskRuntimeResult<ExecutionState> {
    match state {
        "ready" => Ok(ExecutionState::Ready),
        "running" => Ok(ExecutionState::Running),
        "suspended" => Ok(ExecutionState::Suspended),
        "completed" => Ok(ExecutionState::Completed),
        "cancelled" => Ok(ExecutionState::Cancelled),
        "failed" => Ok(ExecutionState::Failed),
        _ => Err(TaskRuntimeError::Store(format!(
            "unknown stored execution state: {state}"
        ))),
    }
}
