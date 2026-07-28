use crate::{TaskRuntimeError, TaskRuntimeResult, TaskStore};
use local_first_execution_protocol::{
    ExecutionContract, ExecutionOutcome, ExecutionState, ValidatedExecutionContract,
    ValidatedExecutionOutcome,
};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

const JOURNAL_EVENT_VERSION: u32 = 1;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExecutionRecord {
    pub contract: ValidatedExecutionContract,
    pub state: ExecutionState,
    pub outcome: Option<ValidatedExecutionOutcome>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ExecutionJournalEvent {
    Created {
        version: u32,
        contract: ExecutionContract,
    },
    FenceAdvanced {
        version: u32,
        previous_fencing_token: u64,
        contract: ExecutionContract,
    },
    OutcomeCommitted {
        version: u32,
        outcome: ExecutionOutcome,
        state: ExecutionState,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExecutionEvent {
    pub event_id: i64,
    pub execution_id: String,
    pub revision: u64,
    pub seq: u64,
    pub event: ExecutionJournalEvent,
    pub created_at: i64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CreateExecution {
    Inserted(ExecutionRecord),
    Existing(ExecutionRecord),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum OutcomeCommit {
    Inserted(ExecutionRecord),
    Existing(ExecutionRecord),
}

struct FoldedExecution {
    record: ExecutionRecord,
    outcome_committed_at: Option<i64>,
}

impl TaskStore {
    pub fn create_execution(
        &self,
        contract: &ValidatedExecutionContract,
    ) -> TaskRuntimeResult<CreateExecution> {
        let raw = contract.as_ref();
        let execution_id = validated_text(&raw.execution_id, "execution id")?;
        let revision = sqlite_integer(raw.revision, "execution revision")?;
        sqlite_integer(raw.fencing_token, "execution fencing token")?;
        let tx = Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;

        if authoritative_journal_revision_on(&tx, execution_id)?
            .is_some_and(|stored| stored != revision)
        {
            return Err(TaskRuntimeError::Conflict(format!(
                "execution journal already exists at another revision: {execution_id}"
            )));
        }

        if let Some((events, folded)) = load_validated_journal_on(&tx, execution_id, revision)? {
            let created_contract = match events.first().map(|event| &event.event) {
                Some(ExecutionJournalEvent::Created { contract, .. }) => contract,
                _ => {
                    return Err(TaskRuntimeError::Store(
                        "execution journal has no leading creation event".into(),
                    ));
                }
            };
            if created_contract != raw {
                return Err(TaskRuntimeError::Conflict(format!(
                    "execution journal already exists with a different contract: {execution_id}"
                )));
            }
            write_projection_on(&tx, &folded)?;
            let record = folded.record;
            tx.commit()?;
            return Ok(CreateExecution::Existing(record));
        }

        if projection_exists_on(&tx, execution_id)? {
            return Err(TaskRuntimeError::Conflict(format!(
                "execution projection exists without an authoritative journal: {execution_id}"
            )));
        }

        let now = OffsetDateTime::now_utc().unix_timestamp();
        append_journal_event_on(
            &tx,
            execution_id,
            revision,
            &ExecutionJournalEvent::Created {
                version: JOURNAL_EVENT_VERSION,
                contract: raw.clone(),
            },
            now,
        )?;
        let (_, folded) = load_validated_journal_on(&tx, execution_id, revision)?
            .ok_or_else(|| TaskRuntimeError::Store("created journal disappeared".into()))?;
        write_projection_on(&tx, &folded)?;
        let record = folded.record;
        tx.commit()?;
        Ok(CreateExecution::Inserted(record))
    }

    pub fn execution(&self, execution_id: &str) -> TaskRuntimeResult<Option<ExecutionRecord>> {
        let execution_id = validated_text(execution_id, "execution id")?;
        load_projection_on(&self.connection, execution_id)
    }

    pub fn execution_events(
        &self,
        execution_id: &str,
        revision: u64,
    ) -> TaskRuntimeResult<Vec<ExecutionEvent>> {
        let execution_id = validated_text(execution_id, "execution id")?;
        let revision = sqlite_integer(revision, "execution event revision")?;
        load_validated_journal_on(&self.connection, execution_id, revision)?
            .map(|(events, _)| events)
            .ok_or_else(|| TaskRuntimeError::NotFound(format!("execution journal {execution_id}")))
    }

    pub fn rebuild_execution_projection(
        &self,
        execution_id: &str,
        revision: u64,
    ) -> TaskRuntimeResult<ExecutionRecord> {
        let execution_id = validated_text(execution_id, "execution id")?;
        let revision = sqlite_integer(revision, "execution revision")?;
        let tx = Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        let (_, folded) =
            load_validated_journal_on(&tx, execution_id, revision)?.ok_or_else(|| {
                TaskRuntimeError::NotFound(format!("execution journal {execution_id}"))
            })?;
        write_projection_on(&tx, &folded)?;
        let record = folded.record;
        tx.commit()?;
        Ok(record)
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
        sqlite_integer(expected, "expected execution fence")?;
        sqlite_integer(next, "next execution fence")?;
        let tx = Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        match authoritative_journal_revision_on(&tx, execution_id)? {
            Some(stored) if stored != revision => {
                return Err(TaskRuntimeError::InvalidTransition(
                    "execution revision is stale".into(),
                ));
            }
            None => {
                return Err(TaskRuntimeError::NotFound(format!(
                    "execution {execution_id}"
                )));
            }
            Some(_) => {}
        }
        let (_, current) = load_validated_journal_on(&tx, execution_id, revision)?
            .ok_or_else(|| TaskRuntimeError::NotFound(format!("execution {execution_id}")))?;
        let raw = current.record.contract.as_ref();
        if raw.revision != stored_u64(revision, "execution revision")?
            || raw.fencing_token != expected
        {
            return Err(TaskRuntimeError::InvalidTransition(
                "execution revision or fencing token is stale".into(),
            ));
        }
        if current.record.outcome.is_some() {
            return Err(TaskRuntimeError::InvalidTransition(
                "cannot advance the fence after an outcome is committed".into(),
            ));
        }

        let mut updated_contract = raw.clone();
        updated_contract.fencing_token = next;
        let updated_contract =
            ValidatedExecutionContract::try_from(updated_contract).map_err(|error| {
                TaskRuntimeError::Store(format!("advanced execution contract is invalid: {error}"))
            })?;
        let now = OffsetDateTime::now_utc().unix_timestamp();
        append_journal_event_on(
            &tx,
            execution_id,
            revision,
            &ExecutionJournalEvent::FenceAdvanced {
                version: JOURNAL_EVENT_VERSION,
                previous_fencing_token: expected,
                contract: updated_contract.as_ref().clone(),
            },
            now,
        )?;
        let (_, folded) = load_validated_journal_on(&tx, execution_id, revision)?
            .ok_or_else(|| TaskRuntimeError::Store("advanced journal disappeared".into()))?;
        write_projection_on(&tx, &folded)?;
        let record = folded.record;
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
        sqlite_integer(binding.fencing_token(), "execution outcome fencing token")?;
        let tx = Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        match authoritative_journal_revision_on(&tx, execution_id)? {
            Some(stored) if stored != revision => {
                return Err(TaskRuntimeError::InvalidTransition(
                    "execution outcome revision is stale".into(),
                ));
            }
            None => {
                return Err(TaskRuntimeError::InvalidTransition(format!(
                    "execution outcome binding references unknown execution {execution_id}"
                )));
            }
            Some(_) => {}
        }
        let (_, current) =
            load_validated_journal_on(&tx, execution_id, revision)?.ok_or_else(|| {
                TaskRuntimeError::InvalidTransition(format!(
                    "execution outcome binding references unknown execution {execution_id}"
                ))
            })?;
        let contract = current.record.contract.as_ref();
        if binding.execution_id() != contract.execution_id
            || binding.revision() != contract.revision
            || binding.kind() != contract.kind
            || binding.fencing_token() != contract.fencing_token
        {
            return Err(TaskRuntimeError::InvalidTransition(
                "execution outcome binding does not match the authoritative journal".into(),
            ));
        }

        let canonical_outcome = serde_json::to_string(outcome.as_ref())?;
        if let Some(existing) = current.record.outcome.as_ref() {
            if serde_json::to_string(existing.as_ref())? == canonical_outcome {
                write_projection_on(&tx, &current)?;
                let record = current.record;
                tx.commit()?;
                return Ok(OutcomeCommit::Existing(record));
            }
            return Err(TaskRuntimeError::InvalidTransition(
                "a conflicting execution outcome is already committed".into(),
            ));
        }

        let state = state_for_outcome(outcome.as_ref());
        let now = OffsetDateTime::now_utc().unix_timestamp();
        append_journal_event_on(
            &tx,
            execution_id,
            revision,
            &ExecutionJournalEvent::OutcomeCommitted {
                version: JOURNAL_EVENT_VERSION,
                outcome: outcome.as_ref().clone(),
                state,
            },
            now,
        )?;
        let (_, folded) = load_validated_journal_on(&tx, execution_id, revision)?
            .ok_or_else(|| TaskRuntimeError::Store("committed journal disappeared".into()))?;
        write_projection_on(&tx, &folded)?;
        let record = folded.record;
        tx.commit()?;
        Ok(OutcomeCommit::Inserted(record))
    }
}

fn load_validated_journal_on(
    connection: &Connection,
    execution_id: &str,
    revision: i64,
) -> TaskRuntimeResult<Option<(Vec<ExecutionEvent>, FoldedExecution)>> {
    let events = read_journal_events_on(connection, execution_id, revision)?;
    if events.is_empty() {
        return Ok(None);
    }
    let folded = fold_journal(&events, execution_id, revision)?;
    Ok(Some((events, folded)))
}

fn authoritative_journal_revision_on(
    connection: &Connection,
    execution_id: &str,
) -> TaskRuntimeResult<Option<i64>> {
    let mut statement = connection.prepare(
        "SELECT DISTINCT revision FROM execution_events
         WHERE execution_id = ?1 ORDER BY revision ASC",
    )?;
    let mut rows = statement.query_map([execution_id], |row| row.get::<_, i64>(0))?;
    let first = rows.next().transpose()?;
    if rows.next().transpose()?.is_some() {
        return Err(TaskRuntimeError::Store(
            "execution journal contains multiple revisions for one execution".into(),
        ));
    }
    Ok(first)
}

fn read_journal_events_on(
    connection: &Connection,
    execution_id: &str,
    expected_revision: i64,
) -> TaskRuntimeResult<Vec<ExecutionEvent>> {
    let mut statement = connection.prepare(
        "SELECT event_id, execution_id, revision, seq, kind, payload_json, created_at
         FROM execution_events
         WHERE execution_id = ?1
         ORDER BY seq ASC, event_id ASC",
    )?;
    let rows = statement.query_map([execution_id], |row| {
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

    let mut events = Vec::new();
    for (index, row) in rows.enumerate() {
        let (event_id, row_execution_id, revision, seq, kind, payload_json, created_at) = row?;
        let expected_seq = i64::try_from(index)
            .ok()
            .and_then(|index| index.checked_add(1))
            .ok_or_else(|| TaskRuntimeError::Store("execution event sequence exhausted".into()))?;
        if row_execution_id != execution_id || revision != expected_revision || seq != expected_seq
        {
            return Err(TaskRuntimeError::Store(
                "execution journal ownership or sequence is invalid".into(),
            ));
        }
        let event: ExecutionJournalEvent =
            serde_json::from_str(&payload_json).map_err(|error| {
                TaskRuntimeError::Store(format!(
                    "stored execution journal event is invalid: {error}"
                ))
            })?;
        if kind != journal_event_kind(&event) {
            return Err(TaskRuntimeError::Store(
                "execution journal kind does not match its typed payload".into(),
            ));
        }
        events.push(ExecutionEvent {
            event_id,
            execution_id: row_execution_id,
            revision: stored_u64(revision, "execution event revision")?,
            seq: stored_u64(seq, "execution event sequence")?,
            event,
            created_at,
        });
    }
    Ok(events)
}

fn fold_journal(
    events: &[ExecutionEvent],
    execution_id: &str,
    revision: i64,
) -> TaskRuntimeResult<FoldedExecution> {
    let mut folded: Option<FoldedExecution> = None;
    for event in events {
        match &event.event {
            ExecutionJournalEvent::Created { version, contract } => {
                require_event_version(*version)?;
                if folded.is_some() || event.seq != 1 {
                    return Err(TaskRuntimeError::Store(
                        "execution journal must contain exactly one leading creation".into(),
                    ));
                }
                let contract = validate_journal_contract(contract.clone())?;
                let raw = contract.as_ref();
                if raw.execution_id != execution_id
                    || sqlite_integer_from_store(raw.revision, "contract revision")? != revision
                {
                    return Err(TaskRuntimeError::Store(
                        "created contract does not match journal ownership".into(),
                    ));
                }
                folded = Some(FoldedExecution {
                    record: ExecutionRecord {
                        contract,
                        state: ExecutionState::Ready,
                        outcome: None,
                        created_at: event.created_at,
                        updated_at: event.created_at,
                    },
                    outcome_committed_at: None,
                });
            }
            ExecutionJournalEvent::FenceAdvanced {
                version,
                previous_fencing_token,
                contract,
            } => {
                require_event_version(*version)?;
                let current = folded.as_mut().ok_or_else(|| {
                    TaskRuntimeError::Store("fence event precedes execution creation".into())
                })?;
                require_nonterminal_fold(current, event.created_at)?;
                let updated = validate_journal_contract(contract.clone())?;
                let current_raw = current.record.contract.as_ref();
                if current_raw.fencing_token != *previous_fencing_token
                    || updated.as_ref().fencing_token <= *previous_fencing_token
                {
                    return Err(TaskRuntimeError::Store(
                        "fence event does not advance the folded fencing token".into(),
                    ));
                }
                let mut expected = current_raw.clone();
                expected.fencing_token = updated.as_ref().fencing_token;
                if expected != *updated.as_ref() {
                    return Err(TaskRuntimeError::Store(
                        "fence event changed fields other than the fencing token".into(),
                    ));
                }
                current.record.contract = updated;
                current.record.updated_at = event.created_at;
            }
            ExecutionJournalEvent::OutcomeCommitted {
                version,
                outcome,
                state,
            } => {
                require_event_version(*version)?;
                let current = folded.as_mut().ok_or_else(|| {
                    TaskRuntimeError::Store("outcome event precedes execution creation".into())
                })?;
                require_nonterminal_fold(current, event.created_at)?;
                if state_for_outcome(outcome) != *state {
                    return Err(TaskRuntimeError::Store(
                        "outcome event state is not canonical".into(),
                    ));
                }
                let outcome =
                    ValidatedExecutionOutcome::new(outcome.clone(), &current.record.contract)
                        .map_err(|error| {
                            TaskRuntimeError::Store(format!(
                                "stored execution journal outcome is invalid: {error}"
                            ))
                        })?;
                current.record.state = state.clone();
                current.record.outcome = Some(outcome);
                current.record.updated_at = event.created_at;
                current.outcome_committed_at = Some(event.created_at);
            }
        }
    }
    folded.ok_or_else(|| TaskRuntimeError::Store("execution journal has no creation event".into()))
}

fn require_nonterminal_fold(
    folded: &FoldedExecution,
    event_timestamp: i64,
) -> TaskRuntimeResult<()> {
    if folded.record.outcome.is_some() {
        return Err(TaskRuntimeError::Store(
            "execution journal contains an event after its outcome".into(),
        ));
    }
    if event_timestamp < folded.record.updated_at {
        return Err(TaskRuntimeError::Store(
            "execution journal timestamps are not monotonic".into(),
        ));
    }
    Ok(())
}

fn validate_journal_contract(
    contract: ExecutionContract,
) -> TaskRuntimeResult<ValidatedExecutionContract> {
    ValidatedExecutionContract::try_from(contract).map_err(|error| {
        TaskRuntimeError::Store(format!(
            "stored execution journal contract is invalid: {error}"
        ))
    })
}

fn append_journal_event_on(
    connection: &Connection,
    execution_id: &str,
    revision: i64,
    event: &ExecutionJournalEvent,
    created_at: i64,
) -> TaskRuntimeResult<()> {
    let current: Option<i64> = connection.query_row(
        "SELECT MAX(seq) FROM execution_events WHERE execution_id = ?1 AND revision = ?2",
        params![execution_id, revision],
        |row| row.get(0),
    )?;
    let seq = current
        .unwrap_or(0)
        .checked_add(1)
        .ok_or_else(|| TaskRuntimeError::Store("execution event sequence exhausted".into()))?;
    connection.execute(
        "INSERT INTO execution_events (
            execution_id, revision, seq, kind, payload_json, created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            execution_id,
            revision,
            seq,
            journal_event_kind(event),
            serde_json::to_string(event)?,
            created_at,
        ],
    )?;
    Ok(())
}

fn write_projection_on(connection: &Connection, folded: &FoldedExecution) -> TaskRuntimeResult<()> {
    let record = &folded.record;
    let raw = record.contract.as_ref();
    let outcome_json = record
        .outcome
        .as_ref()
        .map(|outcome| serde_json::to_string(outcome.as_ref()))
        .transpose()?;
    connection.execute(
        "INSERT INTO executions (
            execution_id, parent_execution_id, kind, revision, fencing_token, state,
            user_id, workspace_id, thread_id, contract_json, outcome_json,
            outcome_committed_at, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
         ON CONFLICT(execution_id) DO UPDATE SET
            parent_execution_id = excluded.parent_execution_id,
            kind = excluded.kind,
            revision = excluded.revision,
            fencing_token = excluded.fencing_token,
            state = excluded.state,
            user_id = excluded.user_id,
            workspace_id = excluded.workspace_id,
            thread_id = excluded.thread_id,
            contract_json = excluded.contract_json,
            outcome_json = excluded.outcome_json,
            outcome_committed_at = excluded.outcome_committed_at,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at",
        params![
            raw.execution_id,
            raw.parent_execution_id.as_deref(),
            raw.kind,
            sqlite_integer_from_store(raw.revision, "contract revision")?,
            sqlite_integer_from_store(raw.fencing_token, "contract fencing token")?,
            state_name(&record.state),
            raw.scope.user_id,
            raw.scope.workspace_id,
            raw.scope.thread_id.as_deref(),
            serde_json::to_string(raw)?,
            outcome_json,
            folded.outcome_committed_at,
            record.created_at,
            record.updated_at,
        ],
    )?;
    Ok(())
}

fn load_projection_on(
    connection: &Connection,
    execution_id: &str,
) -> TaskRuntimeResult<Option<ExecutionRecord>> {
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
            row_execution_id,
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
            if raw.execution_id != row_execution_id
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
            match outcome.as_ref() {
                Some(outcome) if state_for_outcome(outcome.as_ref()) != state => {
                    return Err(TaskRuntimeError::Store(
                        "stored execution state does not match its outcome".into(),
                    ));
                }
                None if !matches!(state, ExecutionState::Ready | ExecutionState::Running) => {
                    return Err(TaskRuntimeError::Store(
                        "stored terminal execution state has no outcome".into(),
                    ));
                }
                _ => {}
            }

            Ok(ExecutionRecord {
                contract,
                state,
                outcome,
                created_at,
                updated_at,
            })
        },
    )
    .transpose()
}

fn projection_exists_on(connection: &Connection, execution_id: &str) -> TaskRuntimeResult<bool> {
    Ok(connection
        .query_row(
            "SELECT 1 FROM executions WHERE execution_id = ?1",
            [execution_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

fn journal_event_kind(event: &ExecutionJournalEvent) -> &'static str {
    match event {
        ExecutionJournalEvent::Created { .. } => "execution_created",
        ExecutionJournalEvent::FenceAdvanced { .. } => "fence_advanced",
        ExecutionJournalEvent::OutcomeCommitted { .. } => "outcome_committed",
    }
}

fn require_event_version(version: u32) -> TaskRuntimeResult<()> {
    if version != JOURNAL_EVENT_VERSION {
        return Err(TaskRuntimeError::Store(format!(
            "unsupported execution journal event version: {version}"
        )));
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
