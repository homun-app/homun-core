use crate::{TaskRecord, TaskRuntimeError, TaskRuntimeResult, TaskStatus, TaskStore};
use local_first_execution_protocol::{
    CheckpointRef, ExecutionContract, ExecutionOutcome, ExecutionState, ValidatedExecutionContract,
    ValidatedExecutionOutcome, WakeCondition, WakeDelivery,
};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;
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
    RevisionStarted {
        version: u32,
        previous_revision: u64,
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
    WakeDelivered {
        version: u32,
        delivery: WakeDelivery,
        next_revision: u64,
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
pub enum StartExecutionRevision {
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
    wake_transition: Option<WakeTransitionEvidence>,
}

struct FoldedJournal {
    revisions: Vec<FoldedExecution>,
}

#[derive(Clone)]
struct MigrationProjection {
    record: ExecutionRecord,
    outcome_committed_at: Option<i64>,
}

struct RawMigrationEvent {
    event_id: i64,
    execution_id: String,
    revision: i64,
    seq: i64,
    kind: String,
    payload_json: String,
    created_at: i64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct WakeTransitionEvidence {
    delivery: WakeDelivery,
    next_revision: u64,
    created_at: i64,
}

#[derive(Clone)]
struct PendingWakeReceipt {
    execution_id: String,
    revision: u64,
    dedup_key: String,
    condition: WakeCondition,
    created_at: i64,
}

#[derive(Deserialize)]
struct LegacyFenceAdvanced {
    expected: u64,
    next: u64,
}

#[derive(Deserialize)]
struct LegacyStatePayload {
    state: String,
}

impl FoldedJournal {
    fn latest(&self) -> TaskRuntimeResult<&FoldedExecution> {
        self.revisions
            .last()
            .ok_or_else(|| TaskRuntimeError::Store("execution journal has no revisions".into()))
    }

    fn revision(&self, revision: u64) -> Option<&FoldedExecution> {
        let index = usize::try_from(revision.checked_sub(1)?).ok()?;
        self.revisions.get(index)
    }
}

impl TaskStore {
    pub fn create_execution(
        &self,
        contract: &ValidatedExecutionContract,
    ) -> TaskRuntimeResult<CreateExecution> {
        let raw = contract.as_ref();
        let execution_id = validated_text(&raw.execution_id, "execution id")?;
        if raw.revision != 1 {
            return Err(TaskRuntimeError::InvalidTransition(
                "initial execution creation must use revision one".into(),
            ));
        }
        let revision = sqlite_integer(raw.revision, "execution revision")?;
        sqlite_integer(raw.fencing_token, "execution fencing token")?;
        let tx = Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;

        if let Some((events, journal)) = load_validated_journal_on(&tx, execution_id)? {
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
            let latest = journal.latest()?;
            write_projection_on(&tx, latest)?;
            let record = latest.record.clone();
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
        let (_, journal) = load_validated_journal_on(&tx, execution_id)?
            .ok_or_else(|| TaskRuntimeError::Store("created journal disappeared".into()))?;
        let latest = journal.latest()?;
        write_projection_on(&tx, latest)?;
        let record = latest.record.clone();
        tx.commit()?;
        Ok(CreateExecution::Inserted(record))
    }

    pub fn start_execution_revision(
        &self,
        contract: &ValidatedExecutionContract,
    ) -> TaskRuntimeResult<StartExecutionRevision> {
        let tx = Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        let result = start_execution_revision_on(&tx, contract)?;
        tx.commit()?;
        Ok(result)
    }

    pub fn execution(&self, execution_id: &str) -> TaskRuntimeResult<Option<ExecutionRecord>> {
        let execution_id = validated_text(execution_id, "execution id")?;
        let tx = Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        let projection = load_projection_on(&tx, execution_id)?;
        let Some((_, journal)) = load_validated_journal_on(&tx, execution_id)? else {
            if projection.is_some() {
                return Err(TaskRuntimeError::Store(
                    "execution projection exists without an authoritative journal".into(),
                ));
            }
            tx.commit()?;
            return Ok(None);
        };
        let Some(projection) = projection else {
            tx.commit()?;
            return Ok(None);
        };
        let latest = journal.latest()?;
        let record = if projection_matches_folded_on(&tx, execution_id, &projection, latest)? {
            projection
        } else {
            write_projection_on(&tx, latest)?;
            latest.record.clone()
        };
        tx.commit()?;
        Ok(Some(record))
    }

    pub fn committed_executions(&self, limit: usize) -> TaskRuntimeResult<Vec<ExecutionRecord>> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        let limit = i64::try_from(limit).unwrap_or(i64::MAX);
        let execution_ids = {
            let mut statement = self.connection.prepare(
                "SELECT event.execution_id
                 FROM execution_events AS event
                 WHERE event.kind = 'outcome_committed'
                   AND event.revision = (
                       SELECT MAX(latest.revision)
                       FROM execution_events AS latest
                       WHERE latest.execution_id = event.execution_id
                   )
                 ORDER BY event.created_at, event.execution_id
                 LIMIT ?1",
            )?;
            let rows = statement.query_map(params![limit], |row| row.get::<_, String>(0))?;
            rows.collect::<Result<Vec<_>, _>>()?
        };
        let mut records = Vec::with_capacity(execution_ids.len());
        for execution_id in execution_ids {
            let record = match self.execution(&execution_id)? {
                Some(record) => record,
                None => self.rebuild_execution_projection(&execution_id)?,
            };
            if record.outcome.is_none() {
                return Err(TaskRuntimeError::Store(format!(
                    "committed execution scan loaded no outcome: {execution_id}"
                )));
            }
            records.push(record);
        }
        Ok(records)
    }

    pub fn execution_events(
        &self,
        execution_id: &str,
        revision: u64,
    ) -> TaskRuntimeResult<Vec<ExecutionEvent>> {
        let execution_id = validated_text(execution_id, "execution id")?;
        sqlite_integer(revision, "execution event revision")?;
        let (events, journal) = load_validated_journal_on(&self.connection, execution_id)?
            .ok_or_else(|| {
                TaskRuntimeError::NotFound(format!("execution journal {execution_id}"))
            })?;
        if journal.revision(revision).is_none() {
            return Err(TaskRuntimeError::NotFound(format!(
                "execution journal {execution_id} revision {revision}"
            )));
        }
        Ok(events
            .into_iter()
            .filter(|event| event.revision == revision)
            .collect())
    }

    pub fn rebuild_execution_projection(
        &self,
        execution_id: &str,
    ) -> TaskRuntimeResult<ExecutionRecord> {
        let execution_id = validated_text(execution_id, "execution id")?;
        let tx = Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        let (_, journal) = load_validated_journal_on(&tx, execution_id)?.ok_or_else(|| {
            TaskRuntimeError::NotFound(format!("execution journal {execution_id}"))
        })?;
        let latest = journal.latest()?;
        write_projection_on(&tx, latest)?;
        let record = latest.record.clone();
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
        let (_, journal) = load_validated_journal_on(&tx, execution_id)?
            .ok_or_else(|| TaskRuntimeError::NotFound(format!("execution {execution_id}")))?;
        let current = journal.latest()?;
        if current.record.contract.as_ref().revision != stored_u64(revision, "execution revision")?
        {
            return Err(TaskRuntimeError::InvalidTransition(
                "execution revision is stale".into(),
            ));
        }
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
        let (_, journal) = load_validated_journal_on(&tx, execution_id)?
            .ok_or_else(|| TaskRuntimeError::Store("advanced journal disappeared".into()))?;
        let latest = journal.latest()?;
        write_projection_on(&tx, latest)?;
        let record = latest.record.clone();
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
        let (_, journal) = load_validated_journal_on(&tx, execution_id)?.ok_or_else(|| {
            TaskRuntimeError::InvalidTransition(format!(
                "execution outcome binding references unknown execution {execution_id}"
            ))
        })?;
        let current = journal.revision(binding.revision()).ok_or_else(|| {
            TaskRuntimeError::InvalidTransition("execution outcome revision is unknown".into())
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
                verify_registered_wake_on(
                    &tx,
                    execution_id,
                    revision,
                    existing.as_ref(),
                    current.outcome_committed_at,
                    current.wake_transition.as_ref(),
                )?;
                let record = current.record.clone();
                tx.commit()?;
                return Ok(OutcomeCommit::Existing(record));
            }
            return Err(TaskRuntimeError::InvalidTransition(
                "a conflicting execution outcome is already committed".into(),
            ));
        }

        if journal.latest()?.record.contract.as_ref().revision != binding.revision() {
            return Err(TaskRuntimeError::InvalidTransition(
                "cannot commit an outcome to a stale execution revision".into(),
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
        register_suspended_wake_on(&tx, execution_id, revision, outcome.as_ref(), now)?;
        let (_, journal) = load_validated_journal_on(&tx, execution_id)?
            .ok_or_else(|| TaskRuntimeError::Store("committed journal disappeared".into()))?;
        let latest = journal.latest()?;
        write_projection_on(&tx, latest)?;
        let record = latest.record.clone();
        tx.commit()?;
        Ok(OutcomeCommit::Inserted(record))
    }

    pub fn wake_due_executions(
        &self,
        now: OffsetDateTime,
        limit: usize,
    ) -> TaskRuntimeResult<usize> {
        let tx = Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        let mut pending = load_pending_wake_receipts_on(&tx)?
            .into_iter()
            .filter_map(|receipt| match receipt.condition {
                WakeCondition::At { unix_seconds } if unix_seconds <= now.unix_timestamp() => {
                    Some((unix_seconds, receipt))
                }
                _ => None,
            })
            .collect::<Vec<_>>();
        pending.sort_by(|left, right| {
            left.0
                .cmp(&right.0)
                .then_with(|| left.1.execution_id.cmp(&right.1.execution_id))
                .then_with(|| left.1.revision.cmp(&right.1.revision))
                .then_with(|| left.1.dedup_key.cmp(&right.1.dedup_key))
        });

        let mut delivered = 0usize;
        for (scheduled_unix_seconds, receipt) in pending.into_iter().take(limit) {
            let payload = json!({
                "scheduled_unix_seconds": scheduled_unix_seconds,
                "type": "timer",
            });
            deliver_pending_wake_on(&tx, &receipt, payload, now.unix_timestamp())?;
            delivered = delivered
                .checked_add(1)
                .ok_or_else(|| TaskRuntimeError::Store("delivered wake count exhausted".into()))?;
        }
        tx.commit()?;
        Ok(delivered)
    }

    pub fn deliver_execution_signal(
        &self,
        kind: &str,
        correlation_id: &str,
        payload: &Value,
    ) -> TaskRuntimeResult<usize> {
        validated_text(kind, "signal kind")?;
        validated_text(correlation_id, "signal correlation id")?;
        let tx = Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        let pending = load_pending_wake_receipts_on(&tx)?;
        let delivered_at = OffsetDateTime::now_utc().unix_timestamp();
        let mut delivered = 0usize;
        for receipt in pending {
            let matches = matches!(
                &receipt.condition,
                WakeCondition::Signal {
                    kind: expected_kind,
                    correlation_id: expected_correlation_id,
                } if expected_kind == kind && expected_correlation_id == correlation_id
            );
            if !matches {
                continue;
            }
            deliver_pending_wake_on(&tx, &receipt, payload.clone(), delivered_at)?;
            delivered = delivered
                .checked_add(1)
                .ok_or_else(|| TaskRuntimeError::Store("delivered wake count exhausted".into()))?;
        }
        if delivered == 0 {
            verify_delivered_signal_dedup_on(&tx, kind, correlation_id)?;
        }
        tx.commit()?;
        Ok(delivered)
    }
}

fn load_pending_wake_receipts_on(
    connection: &Connection,
) -> TaskRuntimeResult<Vec<PendingWakeReceipt>> {
    let mut statement = connection.prepare(
        "SELECT execution_id, revision, dedup_key, condition_json,
                delivery_json, created_at, delivered_at
         FROM execution_wakes
         WHERE status = 'pending'
         ORDER BY execution_id, revision, dedup_key",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, Option<String>>(4)?,
            row.get::<_, i64>(5)?,
            row.get::<_, Option<i64>>(6)?,
        ))
    })?;
    let mut pending = Vec::new();
    for row in rows {
        let (
            execution_id,
            revision,
            dedup_key,
            condition_json,
            delivery_json,
            created_at,
            delivered_at,
        ) = row?;
        let condition: WakeCondition = serde_json::from_str(&condition_json).map_err(|error| {
            TaskRuntimeError::Store(format!("stored wake condition is invalid: {error}"))
        })?;
        if condition_json != serde_json::to_string(&condition)?
            || dedup_key != condition.dedup_key()
        {
            return Err(TaskRuntimeError::Store(
                "stored wake receipt condition or dedup key is not canonical".into(),
            ));
        }
        if delivery_json.is_some() || delivered_at.is_some() {
            return Err(TaskRuntimeError::Store(
                "stored pending wake receipt has delivery state".into(),
            ));
        }
        pending.push(PendingWakeReceipt {
            execution_id,
            revision: stored_u64(revision, "wake revision")?,
            dedup_key,
            condition,
            created_at,
        });
    }
    Ok(pending)
}

fn verify_delivered_signal_dedup_on(
    connection: &Connection,
    kind: &str,
    correlation_id: &str,
) -> TaskRuntimeResult<()> {
    let condition = WakeCondition::Signal {
        kind: kind.into(),
        correlation_id: correlation_id.into(),
    };
    let canonical_condition = serde_json::to_string(&condition)?;
    let mut statement = connection.prepare(
        "SELECT execution_id, revision, dedup_key, delivery_json, created_at, delivered_at
         FROM execution_wakes
         WHERE status = 'delivered' AND condition_json = ?1
         ORDER BY execution_id, revision, dedup_key",
    )?;
    let rows = statement.query_map([&canonical_condition], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, Option<String>>(3)?,
            row.get::<_, i64>(4)?,
            row.get::<_, Option<i64>>(5)?,
        ))
    })?;
    for row in rows {
        let (execution_id, revision, dedup_key, delivery_json, created_at, delivered_at) = row?;
        let delivery_json = delivery_json.ok_or_else(|| {
            TaskRuntimeError::Store("delivered signal has no delivery JSON".into())
        })?;
        let delivered_at = delivered_at.ok_or_else(|| {
            TaskRuntimeError::Store("delivered signal has no delivery timestamp".into())
        })?;
        let delivery: WakeDelivery = serde_json::from_str(&delivery_json)?;
        if dedup_key != condition.dedup_key()
            || delivery_json != serde_json::to_string(&delivery)?
            || delivery.condition != condition
            || delivery.dedup_key != dedup_key
            || delivery.delivered_at_unix_seconds != delivered_at
            || delivered_at < created_at
        {
            return Err(TaskRuntimeError::Store(
                "stored delivered signal receipt is not canonical".into(),
            ));
        }
        verify_delivered_receipt_journal_on(
            connection,
            &execution_id,
            stored_u64(revision, "wake revision")?,
            &condition,
            &delivery,
            created_at,
            delivered_at,
        )?;
    }
    Ok(())
}

fn verify_delivered_receipt_journal_on(
    connection: &Connection,
    execution_id: &str,
    revision: u64,
    condition: &WakeCondition,
    delivery: &WakeDelivery,
    created_at: i64,
    delivered_at: i64,
) -> TaskRuntimeResult<()> {
    let (_, journal) = load_validated_journal_on(connection, execution_id)?.ok_or_else(|| {
        TaskRuntimeError::Store("delivered wake receipt has no execution journal".into())
    })?;
    let prior = journal.revision(revision).ok_or_else(|| {
        TaskRuntimeError::Store("delivered wake receipt references an unknown revision".into())
    })?;
    let suspended_condition = match prior.record.outcome.as_ref().map(AsRef::as_ref) {
        Some(ExecutionOutcome::Suspended { wake, .. }) => wake,
        _ => {
            return Err(TaskRuntimeError::Store(
                "delivered wake receipt does not reference a suspended outcome".into(),
            ));
        }
    };
    let transition = prior.wake_transition.as_ref().ok_or_else(|| {
        TaskRuntimeError::Store("delivered wake receipt has no journal delivery evidence".into())
    })?;
    if suspended_condition != condition
        || prior.outcome_committed_at != Some(created_at)
        || transition.delivery != *delivery
        || transition.created_at != delivered_at
    {
        return Err(TaskRuntimeError::Store(
            "delivered wake receipt does not match its journal evidence".into(),
        ));
    }
    Ok(())
}

fn deliver_pending_wake_on(
    connection: &Connection,
    receipt: &PendingWakeReceipt,
    payload: Value,
    delivered_at: i64,
) -> TaskRuntimeResult<()> {
    let (_, journal) =
        load_validated_journal_on(connection, &receipt.execution_id)?.ok_or_else(|| {
            TaskRuntimeError::Store("wake receipt has no authoritative execution journal".into())
        })?;
    let prior = journal.revision(receipt.revision).ok_or_else(|| {
        TaskRuntimeError::Store("wake receipt references an unknown execution revision".into())
    })?;
    if journal.latest()?.record.contract.as_ref().revision != receipt.revision {
        return Err(TaskRuntimeError::Store(
            "pending wake receipt does not belong to the latest execution revision".into(),
        ));
    }
    verify_registered_wake_on(
        connection,
        &receipt.execution_id,
        sqlite_integer_from_store(receipt.revision, "wake revision")?,
        prior
            .record
            .outcome
            .as_ref()
            .ok_or_else(|| TaskRuntimeError::Store("wake revision has no outcome".into()))?
            .as_ref(),
        prior.outcome_committed_at,
        prior.wake_transition.as_ref(),
    )?;
    if delivered_at < receipt.created_at {
        return Err(TaskRuntimeError::InvalidTransition(
            "wake delivery predates its suspended outcome".into(),
        ));
    }
    let next_revision = receipt.revision.checked_add(1).ok_or_else(|| {
        TaskRuntimeError::InvalidTransition("execution revision exhausted".into())
    })?;
    let delivery = WakeDelivery {
        condition: receipt.condition.clone(),
        dedup_key: receipt.dedup_key.clone(),
        payload,
        delivered_at_unix_seconds: delivered_at,
    };
    append_journal_event_on(
        connection,
        &receipt.execution_id,
        sqlite_integer_from_store(receipt.revision, "wake revision")?,
        &ExecutionJournalEvent::WakeDelivered {
            version: JOURNAL_EVENT_VERSION,
            delivery: delivery.clone(),
            next_revision,
        },
        delivered_at,
    )?;
    let updated = connection.execute(
        "UPDATE execution_wakes
         SET status = 'delivered', delivery_json = ?1, delivered_at = ?2
         WHERE execution_id = ?3 AND revision = ?4 AND dedup_key = ?5
           AND status = 'pending' AND delivery_json IS NULL AND delivered_at IS NULL",
        params![
            serde_json::to_string(&delivery)?,
            delivered_at,
            receipt.execution_id,
            sqlite_integer_from_store(receipt.revision, "wake revision")?,
            receipt.dedup_key,
        ],
    )?;
    if updated != 1 {
        return Err(TaskRuntimeError::Conflict(
            "wake receipt was delivered concurrently".into(),
        ));
    }

    let (checkpoint, producer_schema_version) =
        match prior.record.outcome.as_ref().map(AsRef::as_ref) {
            Some(ExecutionOutcome::Suspended { checkpoint, .. }) => (
                checkpoint.checkpoint_id(),
                checkpoint.producer_schema_version,
            ),
            _ => {
                return Err(TaskRuntimeError::Store(
                    "wake receipt does not reference a suspended outcome".into(),
                ));
            }
        };
    let prior_contract = prior.record.contract.as_ref();
    let next_fencing_token = prior_contract.fencing_token.checked_add(1).ok_or_else(|| {
        TaskRuntimeError::InvalidTransition("execution fencing token exhausted".into())
    })?;
    let mut next_contract = prior_contract.clone();
    next_contract.revision = next_revision;
    next_contract.fencing_token = next_fencing_token;
    next_contract.checkpoint = Some(CheckpointRef {
        checkpoint_id: checkpoint.into(),
        producer_schema_version,
    });
    next_contract.wake = Some(delivery);
    let next_contract = ValidatedExecutionContract::try_from(next_contract).map_err(|error| {
        TaskRuntimeError::Store(format!(
            "generated wake revision contract is invalid: {error}"
        ))
    })?;
    match start_execution_revision_on(connection, &next_contract)? {
        StartExecutionRevision::Inserted(_) => {}
        StartExecutionRevision::Existing(_) => {
            return Err(TaskRuntimeError::Conflict(
                "pending wake already has a started execution revision".into(),
            ));
        }
    }
    project_legacy_task_ready_on(connection, next_contract.as_ref(), delivered_at)
}

fn project_legacy_task_ready_on(
    connection: &Connection,
    contract: &ExecutionContract,
    updated_at: i64,
) -> TaskRuntimeResult<()> {
    let task_json = connection
        .query_row(
            "SELECT task_json FROM tasks
             WHERE task_id = ?1 AND user_id = ?2 AND workspace_id = ?3",
            params![
                contract.execution_id,
                contract.scope.user_id,
                contract.scope.workspace_id,
            ],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    let Some(task_json) = task_json else {
        return Ok(());
    };
    let mut task: TaskRecord = serde_json::from_str(&task_json)?;
    task.status = TaskStatus::Queued;
    task.blocked_reason = None;
    task.updated_at = OffsetDateTime::from_unix_timestamp(updated_at).map_err(|error| {
        TaskRuntimeError::Store(format!("wake delivery timestamp is invalid: {error}"))
    })?;
    let updated = connection.execute(
        "UPDATE tasks
         SET status = 'queued', blocked_reason = NULL, updated_at = ?1, task_json = ?2
         WHERE task_id = ?3 AND user_id = ?4 AND workspace_id = ?5",
        params![
            updated_at,
            serde_json::to_string(&task)?,
            contract.execution_id,
            contract.scope.user_id,
            contract.scope.workspace_id,
        ],
    )?;
    if updated != 1 {
        return Err(TaskRuntimeError::Store(
            "matching legacy task disappeared during wake projection".into(),
        ));
    }
    Ok(())
}

fn register_suspended_wake_on(
    connection: &Connection,
    execution_id: &str,
    revision: i64,
    outcome: &ExecutionOutcome,
    created_at: i64,
) -> TaskRuntimeResult<()> {
    let ExecutionOutcome::Suspended { wake, .. } = outcome else {
        return Ok(());
    };
    connection.execute(
        "INSERT INTO execution_wakes (
            execution_id, revision, dedup_key, condition_json, status,
            delivery_json, created_at, delivered_at
         ) VALUES (?1, ?2, ?3, ?4, 'pending', NULL, ?5, NULL)",
        params![
            execution_id,
            revision,
            wake.dedup_key(),
            serde_json::to_string(wake)?,
            created_at,
        ],
    )?;
    verify_registered_wake_on(
        connection,
        execution_id,
        revision,
        outcome,
        Some(created_at),
        None,
    )
}

fn verify_registered_wake_on(
    connection: &Connection,
    execution_id: &str,
    revision: i64,
    outcome: &ExecutionOutcome,
    outcome_committed_at: Option<i64>,
    wake_transition: Option<&WakeTransitionEvidence>,
) -> TaskRuntimeResult<()> {
    let ExecutionOutcome::Suspended { wake, .. } = outcome else {
        return Ok(());
    };
    let count = connection.query_row(
        "SELECT COUNT(*) FROM execution_wakes WHERE execution_id = ?1 AND revision = ?2",
        params![execution_id, revision],
        |row| row.get::<_, i64>(0),
    )?;
    if count != 1 {
        return Err(TaskRuntimeError::InvalidTransition(
            "suspended outcome does not have exactly one wake receipt".into(),
        ));
    }
    let row = connection
        .query_row(
            "SELECT dedup_key, condition_json, status, delivery_json, created_at, delivered_at
             FROM execution_wakes
             WHERE execution_id = ?1 AND revision = ?2 AND dedup_key = ?3",
            params![execution_id, revision, wake.dedup_key()],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, Option<i64>>(5)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| {
            TaskRuntimeError::InvalidTransition(
                "suspended outcome wake receipt is missing or conflicting".into(),
            )
        })?;
    let canonical_condition = serde_json::to_string(wake)?;
    let canonical_delivery = wake_transition
        .map(|transition| serde_json::to_string(&transition.delivery))
        .transpose()?;
    let state_matches = match wake_transition {
        None => row.2 == "pending" && row.3.is_none() && row.5.is_none(),
        Some(transition) => {
            row.2 == "delivered"
                && row.3.as_deref() == canonical_delivery.as_deref()
                && row.5 == Some(transition.delivery.delivered_at_unix_seconds)
        }
    };
    if row.0 != wake.dedup_key()
        || row.1 != canonical_condition
        || Some(row.4) != outcome_committed_at
        || !state_matches
    {
        return Err(TaskRuntimeError::InvalidTransition(
            "suspended outcome wake receipt is not canonical journal-matched state".into(),
        ));
    }
    Ok(())
}

pub(crate) fn start_execution_revision_on(
    connection: &Connection,
    contract: &ValidatedExecutionContract,
) -> TaskRuntimeResult<StartExecutionRevision> {
    let raw = contract.as_ref();
    let execution_id = validated_text(&raw.execution_id, "execution id")?;
    if raw.revision <= 1 {
        return Err(TaskRuntimeError::InvalidTransition(
            "a subsequent execution revision must be greater than one".into(),
        ));
    }
    let revision = sqlite_integer(raw.revision, "execution revision")?;
    sqlite_integer(raw.fencing_token, "execution fencing token")?;
    let (events, journal) = load_validated_journal_on(connection, execution_id)?
        .ok_or_else(|| TaskRuntimeError::NotFound(format!("execution {execution_id}")))?;
    let latest = journal.latest()?;

    if journal.revision(raw.revision).is_some() {
        let started_contract = events
            .iter()
            .find(|event| event.revision == raw.revision && event.seq == 1)
            .and_then(|event| match &event.event {
                ExecutionJournalEvent::RevisionStarted { contract, .. } => Some(contract),
                _ => None,
            })
            .ok_or_else(|| {
                TaskRuntimeError::Store(
                    "execution revision has no leading revision-start event".into(),
                )
            })?;
        if started_contract != raw {
            return Err(TaskRuntimeError::Conflict(format!(
                "execution revision already exists with a different contract: {execution_id}/{}",
                raw.revision
            )));
        }
        let prior = journal.revision(raw.revision - 1).ok_or_else(|| {
            TaskRuntimeError::Store("execution revision has no prior revision".into())
        })?;
        validate_revision_transition(&prior.record, contract).map_err(|reason| {
            TaskRuntimeError::InvalidTransition(format!("invalid execution revision: {reason}"))
        })?;
        let wake_transition = verify_delivered_wake_on(connection, prior, contract)?;
        let started_at = events
            .iter()
            .find(|event| event.revision == raw.revision && event.seq == 1)
            .map(|event| event.created_at)
            .ok_or_else(|| TaskRuntimeError::Store("revision-start event disappeared".into()))?;
        if started_at != wake_transition.created_at {
            return Err(TaskRuntimeError::Store(
                "revision-start timestamp does not match wake delivery".into(),
            ));
        }
        write_projection_on(connection, latest)?;
        let record = latest.record.clone();
        return Ok(StartExecutionRevision::Existing(record));
    }

    let expected_revision = latest
        .record
        .contract
        .as_ref()
        .revision
        .checked_add(1)
        .ok_or_else(|| {
            TaskRuntimeError::InvalidTransition("execution revision exhausted".into())
        })?;
    if raw.revision != expected_revision {
        return Err(TaskRuntimeError::InvalidTransition(format!(
            "execution revision must advance contiguously to {expected_revision}"
        )));
    }
    validate_revision_transition(&latest.record, contract).map_err(|reason| {
        TaskRuntimeError::InvalidTransition(format!("invalid execution revision: {reason}"))
    })?;
    let wake_transition = verify_delivered_wake_on(connection, latest, contract)?;

    append_journal_event_on(
        connection,
        execution_id,
        revision,
        &ExecutionJournalEvent::RevisionStarted {
            version: JOURNAL_EVENT_VERSION,
            previous_revision: raw.revision - 1,
            contract: raw.clone(),
        },
        wake_transition.created_at,
    )?;
    let (_, journal) = load_validated_journal_on(connection, execution_id)?
        .ok_or_else(|| TaskRuntimeError::Store("started revision disappeared".into()))?;
    let latest = journal.latest()?;
    write_projection_on(connection, latest)?;
    let record = latest.record.clone();
    Ok(StartExecutionRevision::Inserted(record))
}

fn verify_delivered_wake_on<'a>(
    connection: &Connection,
    prior: &'a FoldedExecution,
    next: &ValidatedExecutionContract,
) -> TaskRuntimeResult<&'a WakeTransitionEvidence> {
    let (condition, prior_revision) = match prior.record.outcome.as_ref().map(AsRef::as_ref) {
        Some(ExecutionOutcome::Suspended { wake, .. }) => {
            (wake, prior.record.contract.as_ref().revision)
        }
        _ => {
            return Err(TaskRuntimeError::InvalidTransition(
                "prior revision has no suspended wake to authenticate".into(),
            ));
        }
    };
    let delivery = next.as_ref().wake.as_ref().ok_or_else(|| {
        TaskRuntimeError::InvalidTransition("next revision has no wake delivery".into())
    })?;
    let wake_transition = prior.wake_transition.as_ref().ok_or_else(|| {
        TaskRuntimeError::InvalidTransition(
            "prior revision has no authoritative wake-delivery event".into(),
        )
    })?;
    if wake_transition.delivery != *delivery
        || wake_transition.next_revision != next.as_ref().revision
        || wake_transition.created_at != delivery.delivered_at_unix_seconds
    {
        return Err(TaskRuntimeError::InvalidTransition(
            "journal wake delivery does not authenticate the revision start".into(),
        ));
    }
    let revision = sqlite_integer(prior_revision, "prior execution revision")?;
    let row = connection
        .query_row(
            "SELECT dedup_key, condition_json, status, delivery_json, delivered_at
             FROM execution_wakes
             WHERE execution_id = ?1 AND revision = ?2 AND dedup_key = ?3",
            params![
                prior.record.contract.as_ref().execution_id,
                revision,
                condition.dedup_key(),
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<i64>>(4)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| {
            TaskRuntimeError::InvalidTransition(
                "prior revision has no durable wake delivery".into(),
            )
        })?;
    let canonical_condition = serde_json::to_string(condition)?;
    let canonical_delivery = serde_json::to_string(delivery)?;
    let suspended_at = prior.outcome_committed_at.ok_or_else(|| {
        TaskRuntimeError::Store("suspended journal revision has no outcome timestamp".into())
    })?;
    if row.0 != condition.dedup_key()
        || row.1 != canonical_condition
        || row.2 != "delivered"
        || row.3.as_deref() != Some(canonical_delivery.as_str())
        || row.4 != Some(delivery.delivered_at_unix_seconds)
        || delivery.delivered_at_unix_seconds < suspended_at
    {
        return Err(TaskRuntimeError::InvalidTransition(
            "durable wake delivery does not authenticate the revision start".into(),
        ));
    }
    Ok(wake_transition)
}

pub(crate) fn migrate_execution_schema_v13(connection: &Connection) -> TaskRuntimeResult<()> {
    if !execution_tables_need_v13_rebuild(connection)? {
        return Ok(());
    }

    let tx = Transaction::new_unchecked(connection, TransactionBehavior::Immediate)?;
    let projections = read_migration_projections(&tx)?;
    let raw_events = read_raw_migration_events(&tx)?;
    let events_by_execution = transform_migration_events(&tx, raw_events, &projections)?;
    for execution_id in projections.keys() {
        if !events_by_execution.contains_key(execution_id) {
            return Err(TaskRuntimeError::Store(format!(
                "execution projection has no journal during v13 migration: {execution_id}"
            )));
        }
    }

    tx.execute_batch(
        "ALTER TABLE execution_wakes RENAME TO execution_wakes_v12_legacy;
         ALTER TABLE execution_events RENAME TO execution_events_v12_legacy;
         ALTER TABLE executions RENAME TO executions_v12_legacy;

         CREATE TABLE executions (
            execution_id TEXT PRIMARY KEY,
            parent_execution_id TEXT,
            kind TEXT NOT NULL,
            revision INTEGER NOT NULL CHECK(revision > 0),
            fencing_token INTEGER NOT NULL CHECK(fencing_token > 0),
            state TEXT NOT NULL CHECK(
                state IN ('ready', 'running', 'suspended', 'completed', 'cancelled', 'failed')
            ),
            user_id TEXT NOT NULL,
            workspace_id TEXT NOT NULL,
            thread_id TEXT,
            contract_json TEXT NOT NULL,
            outcome_json TEXT,
            outcome_committed_at INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            UNIQUE(execution_id, revision),
            CHECK(
                (outcome_json IS NULL AND outcome_committed_at IS NULL
                    AND state IN ('ready', 'running'))
                OR
                (outcome_json IS NOT NULL AND outcome_committed_at IS NOT NULL
                    AND state IN ('suspended', 'completed', 'cancelled', 'failed'))
            )
         );

         CREATE TABLE execution_events (
            event_id INTEGER PRIMARY KEY AUTOINCREMENT,
            execution_id TEXT NOT NULL,
            revision INTEGER NOT NULL CHECK(revision > 0),
            seq INTEGER NOT NULL CHECK(seq > 0),
            kind TEXT NOT NULL CHECK(length(trim(kind)) > 0),
            payload_json TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            UNIQUE(execution_id, revision, seq)
         );

         CREATE TABLE execution_wakes (
            execution_id TEXT NOT NULL,
            revision INTEGER NOT NULL CHECK(revision > 0),
            dedup_key TEXT NOT NULL CHECK(length(trim(dedup_key)) > 0),
            condition_json TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('pending', 'delivered')),
            delivery_json TEXT,
            created_at INTEGER NOT NULL,
            delivered_at INTEGER,
            PRIMARY KEY(execution_id, revision, dedup_key),
            CHECK(
                (delivery_json IS NULL AND delivered_at IS NULL)
                OR (delivery_json IS NOT NULL AND delivered_at IS NOT NULL)
            ),
            CHECK(delivered_at IS NULL OR delivered_at >= created_at)
         );",
    )?;

    for events in events_by_execution.values() {
        for event in events {
            tx.execute(
                "INSERT INTO execution_events (
                    event_id, execution_id, revision, seq, kind, payload_json, created_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    event.event_id,
                    event.execution_id,
                    sqlite_integer_from_store(event.revision, "execution event revision")?,
                    sqlite_integer_from_store(event.seq, "execution event sequence")?,
                    journal_event_kind(&event.event),
                    serde_json::to_string(&event.event)?,
                    event.created_at,
                ],
            )?;
        }
        let folded = fold_journal(events, &events[0].execution_id)?;
        write_projection_on(&tx, folded.latest()?)?;
    }
    tx.execute(
        "INSERT INTO execution_wakes (
            execution_id, revision, dedup_key, condition_json, status,
            delivery_json, created_at, delivered_at
         )
         SELECT execution_id, revision, dedup_key, condition_json, status,
                delivery_json, created_at, delivered_at
         FROM execution_wakes_v12_legacy",
        [],
    )?;

    for (execution_id, expected_events) in &events_by_execution {
        let (stored_events, folded) = load_validated_journal_on(&tx, execution_id)?
            .ok_or_else(|| TaskRuntimeError::Store("migrated execution journal vanished".into()))?;
        if &stored_events != expected_events {
            return Err(TaskRuntimeError::Store(format!(
                "migrated execution journal changed during v13 validation: {execution_id}"
            )));
        }
        let stored_projection = load_projection_on(&tx, execution_id)?.ok_or_else(|| {
            TaskRuntimeError::Store("migrated execution projection vanished".into())
        })?;
        if stored_projection != folded.latest()?.record {
            return Err(TaskRuntimeError::Store(format!(
                "migrated execution projection does not match its journal: {execution_id}"
            )));
        }
    }

    tx.execute_batch(
        "DROP TABLE execution_wakes_v12_legacy;
         DROP TABLE execution_events_v12_legacy;
         DROP TABLE executions_v12_legacy;",
    )?;
    tx.commit()?;
    Ok(())
}

fn execution_tables_need_v13_rebuild(connection: &Connection) -> TaskRuntimeResult<bool> {
    let required_fragments = [
        (
            "executions",
            [
                "check(revision>0)",
                "check(fencing_token>0)",
                "unique(execution_id,revision)",
            ]
            .as_slice(),
        ),
        (
            "execution_events",
            [
                "check(revision>0)",
                "check(seq>0)",
                "check(length(trim(kind))>0)",
            ]
            .as_slice(),
        ),
        (
            "execution_wakes",
            [
                "check(revision>0)",
                "check(length(trim(dedup_key))>0)",
                "check(statusin('pending','delivered'))",
            ]
            .as_slice(),
        ),
    ];
    for (table, fragments) in required_fragments {
        let sql: String = connection.query_row(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?1",
            [table],
            |row| row.get(0),
        )?;
        let normalized = sql
            .chars()
            .filter(|character| !character.is_ascii_whitespace())
            .flat_map(char::to_lowercase)
            .collect::<String>();
        if fragments
            .iter()
            .any(|fragment| !normalized.contains(fragment))
            || table_references_execution_projection(connection, table)?
        {
            return Ok(true);
        }
    }
    legacy_wake_history_needs_v13_rebuild(connection)
}

fn legacy_wake_history_needs_v13_rebuild(connection: &Connection) -> TaskRuntimeResult<bool> {
    let mut statement = connection.prepare(
        "SELECT execution_id, revision, payload_json
         FROM execution_events
         WHERE kind = 'outcome_committed'
         ORDER BY execution_id, revision, seq, event_id",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    for row in rows {
        let (execution_id, revision, payload_json) = row?;
        let event: ExecutionJournalEvent = serde_json::from_str(&payload_json)?;
        let ExecutionJournalEvent::OutcomeCommitted {
            outcome: ExecutionOutcome::Suspended { wake, .. },
            ..
        } = event
        else {
            continue;
        };
        let delivery_event_count = connection.query_row(
            "SELECT COUNT(*) FROM execution_events
             WHERE execution_id = ?1 AND revision = ?2 AND kind = 'wake_delivered'",
            params![execution_id, revision],
            |row| row.get::<_, i64>(0),
        )?;
        if delivery_event_count != 0 {
            continue;
        }
        let receipt_count = connection.query_row(
            "SELECT COUNT(*) FROM execution_wakes
             WHERE execution_id = ?1 AND revision = ?2",
            params![execution_id, revision],
            |row| row.get::<_, i64>(0),
        )?;
        if receipt_count != 1 {
            return Ok(true);
        }
        let status = connection
            .query_row(
                "SELECT status FROM execution_wakes
                 WHERE execution_id = ?1 AND revision = ?2 AND dedup_key = ?3",
                params![execution_id, revision, wake.dedup_key()],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        if status.as_deref() != Some("pending") {
            return Ok(true);
        }
    }
    Ok(false)
}

fn table_references_execution_projection(
    connection: &Connection,
    table: &str,
) -> TaskRuntimeResult<bool> {
    let mut statement = connection.prepare(&format!("PRAGMA foreign_key_list({table})"))?;
    let referenced_tables = statement.query_map([], |row| row.get::<_, String>(2))?;
    for referenced_table in referenced_tables {
        if referenced_table? == "executions" {
            return Ok(true);
        }
    }
    Ok(false)
}

fn read_migration_projections(
    connection: &Connection,
) -> TaskRuntimeResult<BTreeMap<String, MigrationProjection>> {
    let mut statement =
        connection.prepare("SELECT execution_id FROM executions ORDER BY execution_id")?;
    let ids = statement.query_map([], |row| row.get::<_, String>(0))?;
    let mut projections = BTreeMap::new();
    for execution_id in ids {
        let execution_id = execution_id?;
        let record = load_projection_on(connection, &execution_id)?.ok_or_else(|| {
            TaskRuntimeError::Store("execution projection disappeared during migration".into())
        })?;
        let outcome_committed_at = connection.query_row(
            "SELECT outcome_committed_at FROM executions WHERE execution_id = ?1",
            [&execution_id],
            |row| row.get::<_, Option<i64>>(0),
        )?;
        projections.insert(
            execution_id,
            MigrationProjection {
                record,
                outcome_committed_at,
            },
        );
    }
    Ok(projections)
}

fn read_raw_migration_events(connection: &Connection) -> TaskRuntimeResult<Vec<RawMigrationEvent>> {
    let mut statement = connection.prepare(
        "SELECT event_id, execution_id, revision, seq, kind, payload_json, created_at
         FROM execution_events ORDER BY execution_id, revision, seq, event_id",
    )?;
    let rows = statement.query_map([], |row| {
        Ok(RawMigrationEvent {
            event_id: row.get(0)?,
            execution_id: row.get(1)?,
            revision: row.get(2)?,
            seq: row.get(3)?,
            kind: row.get(4)?,
            payload_json: row.get(5)?,
            created_at: row.get(6)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

fn transform_migration_events(
    connection: &Connection,
    raw_events: Vec<RawMigrationEvent>,
    projections: &BTreeMap<String, MigrationProjection>,
) -> TaskRuntimeResult<BTreeMap<String, Vec<ExecutionEvent>>> {
    let mut next_event_id = raw_events
        .iter()
        .map(|event| event.event_id)
        .max()
        .unwrap_or(0)
        .checked_add(1)
        .ok_or_else(|| TaskRuntimeError::Store("execution event identity exhausted".into()))?;
    let mut raw_by_execution: BTreeMap<String, Vec<RawMigrationEvent>> = BTreeMap::new();
    for event in raw_events {
        raw_by_execution
            .entry(event.execution_id.clone())
            .or_default()
            .push(event);
    }
    let mut transformed = BTreeMap::new();
    for (execution_id, raw) in raw_by_execution {
        let typed_count = raw
            .iter()
            .filter(|event| {
                serde_json::from_str::<ExecutionJournalEvent>(&event.payload_json).is_ok()
            })
            .count();
        let mut events = if typed_count == raw.len() {
            raw.into_iter()
                .map(raw_typed_migration_event)
                .collect::<TaskRuntimeResult<Vec<_>>>()?
        } else if typed_count == 0 {
            let projection = projections.get(&execution_id).ok_or_else(|| {
                TaskRuntimeError::Store(format!(
                    "legacy execution journal has no validated projection: {execution_id}"
                ))
            })?;
            transform_initial_v12_events(raw, projection)?
        } else {
            return Err(TaskRuntimeError::Store(format!(
                "execution journal mixes legacy and typed payloads: {execution_id}"
            )));
        };
        let legacy_projection = upgrade_typed_wake_events_on(
            connection,
            &execution_id,
            &mut events,
            &mut next_event_id,
        )?;
        let folded = fold_journal(&events, &execution_id)?;
        if let Some(projection) = projections.get(&execution_id)
            && (folded.latest()?.record != projection.record
                || folded.latest()?.outcome_committed_at != projection.outcome_committed_at)
            && legacy_projection.as_ref().is_none_or(|legacy| {
                legacy.record != projection.record
                    || legacy.outcome_committed_at != projection.outcome_committed_at
            })
        {
            return Err(TaskRuntimeError::Store(format!(
                "execution journal does not reconstruct its v12 projection: {execution_id}"
            )));
        }
        transformed.insert(execution_id, events);
    }
    Ok(transformed)
}

fn upgrade_typed_wake_events_on(
    connection: &Connection,
    execution_id: &str,
    events: &mut Vec<ExecutionEvent>,
    next_event_id: &mut i64,
) -> TaskRuntimeResult<Option<MigrationProjection>> {
    let mut legacy_projection = None;
    let suspended = events
        .iter()
        .filter_map(|event| match &event.event {
            ExecutionJournalEvent::OutcomeCommitted {
                outcome: ExecutionOutcome::Suspended { wake, .. },
                ..
            } => Some((event.revision, event.created_at, wake.clone())),
            _ => None,
        })
        .collect::<Vec<_>>();
    for (revision, suspended_at, wake) in suspended {
        if events.iter().any(|event| {
            event.revision == revision
                && matches!(event.event, ExecutionJournalEvent::WakeDelivered { .. })
        }) {
            continue;
        }
        let next_revision = revision.checked_add(1).ok_or_else(|| {
            TaskRuntimeError::Store("execution revision sequence exhausted".into())
        })?;
        let later_start = events
            .iter()
            .find(|event| {
                event.revision == next_revision
                    && matches!(event.event, ExecutionJournalEvent::RevisionStarted { .. })
            })
            .cloned();
        let receipt_count = connection.query_row(
            "SELECT COUNT(*) FROM execution_wakes
             WHERE execution_id = ?1 AND revision = ?2",
            params![
                execution_id,
                sqlite_integer_from_store(revision, "wake revision")?,
            ],
            |row| row.get::<_, i64>(0),
        )?;
        let row = connection
            .query_row(
                "SELECT condition_json, status, delivery_json, created_at, delivered_at
                 FROM execution_wakes
                 WHERE execution_id = ?1 AND revision = ?2 AND dedup_key = ?3",
                params![
                    execution_id,
                    sqlite_integer_from_store(revision, "wake revision")?,
                    wake.dedup_key(),
                ],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, Option<i64>>(4)?,
                    ))
                },
            )
            .optional()?;
        let Some((condition_json, status, delivery_json, created_at, delivered_at)) = row else {
            if later_start.is_some() {
                return Err(TaskRuntimeError::Store(
                    "typed revision-start history has no wake receipt to upgrade".into(),
                ));
            }
            if receipt_count != 0 {
                return Err(TaskRuntimeError::Store(
                    "typed suspended revision has a conflicting wake receipt".into(),
                ));
            }
            connection.execute(
                "INSERT INTO execution_wakes (
                    execution_id, revision, dedup_key, condition_json, status,
                    delivery_json, created_at, delivered_at
                 ) VALUES (?1, ?2, ?3, ?4, 'pending', NULL, ?5, NULL)",
                params![
                    execution_id,
                    sqlite_integer_from_store(revision, "wake revision")?,
                    wake.dedup_key(),
                    serde_json::to_string(&wake)?,
                    suspended_at,
                ],
            )?;
            continue;
        };
        if receipt_count != 1 {
            return Err(TaskRuntimeError::Store(
                "typed suspended revision does not have exactly one wake receipt".into(),
            ));
        }
        if condition_json != serde_json::to_string(&wake)? || created_at != suspended_at {
            return Err(TaskRuntimeError::Store(
                "typed wake receipt is not canonical for migration".into(),
            ));
        }
        if status == "pending" && delivery_json.is_none() && delivered_at.is_none() {
            if later_start.is_some() {
                return Err(TaskRuntimeError::Store(
                    "typed revision-start history still has a pending wake".into(),
                ));
            }
            continue;
        }
        if status != "delivered" {
            return Err(TaskRuntimeError::Store(
                "typed wake receipt has an unsupported migration status".into(),
            ));
        }
        let delivery_json = delivery_json
            .ok_or_else(|| TaskRuntimeError::Store("typed delivered wake has no payload".into()))?;
        let delivered_at = delivered_at.ok_or_else(|| {
            TaskRuntimeError::Store("typed delivered wake has no timestamp".into())
        })?;
        let delivery: WakeDelivery = serde_json::from_str(&delivery_json)?;
        if delivery_json != serde_json::to_string(&delivery)?
            || delivery.condition != wake
            || delivery.dedup_key != wake.dedup_key()
            || delivery.delivered_at_unix_seconds != delivered_at
            || delivered_at < suspended_at
        {
            return Err(TaskRuntimeError::Store(
                "typed delivered wake is not canonical for migration".into(),
            ));
        }
        if let Some(ref later_start) = later_start {
            let started_contract = match &later_start.event {
                ExecutionJournalEvent::RevisionStarted { contract, .. } => contract,
                _ => unreachable!(),
            };
            if started_contract.wake.as_ref() != Some(&delivery)
                || later_start.created_at != delivered_at
            {
                return Err(TaskRuntimeError::Store(
                    "typed revision-start does not match its migrated wake delivery".into(),
                ));
            }
        } else {
            let before_upgrade = fold_journal(events, execution_id)?;
            let latest = before_upgrade.latest()?;
            if latest.record.contract.as_ref().revision != revision
                || latest.record.state != ExecutionState::Suspended
            {
                return Err(TaskRuntimeError::Store(
                    "delivered legacy wake does not belong to the latest suspended revision".into(),
                ));
            }
            if legacy_projection.is_some() {
                return Err(TaskRuntimeError::Store(
                    "execution migration requires more than one reconstructed revision".into(),
                ));
            }
            legacy_projection = Some(MigrationProjection {
                record: latest.record.clone(),
                outcome_committed_at: latest.outcome_committed_at,
            });
        }
        let seq = events
            .iter()
            .filter(|event| event.revision == revision)
            .map(|event| event.seq)
            .max()
            .unwrap_or(0)
            .checked_add(1)
            .ok_or_else(|| TaskRuntimeError::Store("execution event sequence exhausted".into()))?;
        events.push(ExecutionEvent {
            event_id: *next_event_id,
            execution_id: execution_id.into(),
            revision,
            seq,
            event: ExecutionJournalEvent::WakeDelivered {
                version: JOURNAL_EVENT_VERSION,
                delivery: delivery.clone(),
                next_revision,
            },
            created_at: delivered_at,
        });
        *next_event_id = next_event_id
            .checked_add(1)
            .ok_or_else(|| TaskRuntimeError::Store("execution event identity exhausted".into()))?;
        if later_start.is_none() {
            let journal = fold_journal(events, execution_id)?;
            let prior = journal.revision(revision).ok_or_else(|| {
                TaskRuntimeError::Store(
                    "delivered legacy wake references an unknown revision".into(),
                )
            })?;
            let (checkpoint_id, producer_schema_version) =
                match prior.record.outcome.as_ref().map(AsRef::as_ref) {
                    Some(ExecutionOutcome::Suspended { checkpoint, .. }) => (
                        checkpoint.checkpoint_id(),
                        checkpoint.producer_schema_version,
                    ),
                    _ => {
                        return Err(TaskRuntimeError::Store(
                            "delivered legacy wake does not follow a suspended outcome".into(),
                        ));
                    }
                };
            let mut next_contract = prior.record.contract.as_ref().clone();
            next_contract.revision = next_revision;
            next_contract.fencing_token =
                next_contract.fencing_token.checked_add(1).ok_or_else(|| {
                    TaskRuntimeError::Store("execution fencing token exhausted".into())
                })?;
            next_contract.checkpoint = Some(CheckpointRef {
                checkpoint_id: checkpoint_id.into(),
                producer_schema_version,
            });
            next_contract.wake = Some(delivery);
            let next_contract =
                ValidatedExecutionContract::try_from(next_contract).map_err(|error| {
                    TaskRuntimeError::Store(format!(
                        "reconstructed wake revision contract is invalid: {error}"
                    ))
                })?;
            events.push(ExecutionEvent {
                event_id: *next_event_id,
                execution_id: execution_id.into(),
                revision: next_revision,
                seq: 1,
                event: ExecutionJournalEvent::RevisionStarted {
                    version: JOURNAL_EVENT_VERSION,
                    previous_revision: revision,
                    contract: next_contract.into_inner(),
                },
                created_at: delivered_at,
            });
            *next_event_id = next_event_id.checked_add(1).ok_or_else(|| {
                TaskRuntimeError::Store("execution event identity exhausted".into())
            })?;
        }
    }
    events.sort_by(|left, right| {
        left.revision
            .cmp(&right.revision)
            .then_with(|| left.seq.cmp(&right.seq))
            .then_with(|| left.event_id.cmp(&right.event_id))
    });
    Ok(legacy_projection)
}

fn raw_typed_migration_event(raw: RawMigrationEvent) -> TaskRuntimeResult<ExecutionEvent> {
    let event: ExecutionJournalEvent = serde_json::from_str(&raw.payload_json)?;
    if raw.kind != journal_event_kind(&event) {
        return Err(TaskRuntimeError::Store(
            "typed v12 execution event kind does not match its payload".into(),
        ));
    }
    Ok(ExecutionEvent {
        event_id: raw.event_id,
        execution_id: raw.execution_id,
        revision: stored_u64(raw.revision, "execution event revision")?,
        seq: stored_u64(raw.seq, "execution event sequence")?,
        event,
        created_at: raw.created_at,
    })
}

fn transform_initial_v12_events(
    raw: Vec<RawMigrationEvent>,
    projection: &MigrationProjection,
) -> TaskRuntimeResult<Vec<ExecutionEvent>> {
    if raw.is_empty()
        || raw.iter().any(|event| {
            event.revision != 1
                || event.execution_id != projection.record.contract.as_ref().execution_id
        })
        || projection.record.contract.as_ref().revision != 1
    {
        return Err(TaskRuntimeError::Store(
            "initial v12 execution journal is not a single revision-one stream".into(),
        ));
    }
    let first_fence = raw
        .iter()
        .find(|event| event.kind == "fence_advanced")
        .map(|event| serde_json::from_str::<LegacyFenceAdvanced>(&event.payload_json))
        .transpose()
        .map_err(|error| {
            TaskRuntimeError::Store(format!("legacy fence event is invalid: {error}"))
        })?;
    let mut contract = projection.record.contract.as_ref().clone();
    if let Some(first_fence) = first_fence {
        contract.fencing_token = first_fence.expected;
    }
    let mut current_contract = ValidatedExecutionContract::try_from(contract).map_err(|error| {
        TaskRuntimeError::Store(format!("legacy creation contract is invalid: {error}"))
    })?;
    let mut outcome_used = false;
    let mut transformed = Vec::with_capacity(raw.len());
    for event in raw {
        let typed = match event.kind.as_str() {
            "execution_created" => {
                let payload: LegacyStatePayload = serde_json::from_str(&event.payload_json)
                    .map_err(|error| {
                        TaskRuntimeError::Store(format!(
                            "legacy creation event is invalid: {error}"
                        ))
                    })?;
                if payload.state != "ready" {
                    return Err(TaskRuntimeError::Store(
                        "legacy creation event is not ready".into(),
                    ));
                }
                ExecutionJournalEvent::Created {
                    version: JOURNAL_EVENT_VERSION,
                    contract: current_contract.as_ref().clone(),
                }
            }
            "fence_advanced" => {
                let payload: LegacyFenceAdvanced = serde_json::from_str(&event.payload_json)
                    .map_err(|error| {
                        TaskRuntimeError::Store(format!("legacy fence event is invalid: {error}"))
                    })?;
                if payload.expected != current_contract.as_ref().fencing_token
                    || payload.next <= payload.expected
                {
                    return Err(TaskRuntimeError::Store(
                        "legacy fence event is not contiguous".into(),
                    ));
                }
                let mut updated = current_contract.as_ref().clone();
                updated.fencing_token = payload.next;
                current_contract =
                    ValidatedExecutionContract::try_from(updated).map_err(|error| {
                        TaskRuntimeError::Store(format!(
                            "legacy fence contract is invalid: {error}"
                        ))
                    })?;
                ExecutionJournalEvent::FenceAdvanced {
                    version: JOURNAL_EVENT_VERSION,
                    previous_fencing_token: payload.expected,
                    contract: current_contract.as_ref().clone(),
                }
            }
            "outcome_committed" => {
                if outcome_used {
                    return Err(TaskRuntimeError::Store(
                        "legacy execution journal contains multiple outcomes".into(),
                    ));
                }
                let payload: LegacyStatePayload = serde_json::from_str(&event.payload_json)
                    .map_err(|error| {
                        TaskRuntimeError::Store(format!("legacy outcome event is invalid: {error}"))
                    })?;
                let outcome = projection.record.outcome.as_ref().ok_or_else(|| {
                    TaskRuntimeError::Store(
                        "legacy outcome event has no durable projected outcome".into(),
                    )
                })?;
                let state = state_for_outcome(outcome.as_ref());
                if payload.state != state_name(&state) || state != projection.record.state {
                    return Err(TaskRuntimeError::Store(
                        "legacy outcome event state does not match its projection".into(),
                    ));
                }
                outcome_used = true;
                ExecutionJournalEvent::OutcomeCommitted {
                    version: JOURNAL_EVENT_VERSION,
                    outcome: outcome.as_ref().clone(),
                    state,
                }
            }
            kind => {
                return Err(TaskRuntimeError::Store(format!(
                    "legacy execution event cannot be transformed safely: {kind}"
                )));
            }
        };
        transformed.push(ExecutionEvent {
            event_id: event.event_id,
            execution_id: event.execution_id,
            revision: stored_u64(event.revision, "execution event revision")?,
            seq: stored_u64(event.seq, "execution event sequence")?,
            event: typed,
            created_at: event.created_at,
        });
    }
    if projection.record.outcome.is_some() != outcome_used {
        return Err(TaskRuntimeError::Store(
            "legacy projected outcome has no matching journal event".into(),
        ));
    }
    Ok(transformed)
}

fn load_validated_journal_on(
    connection: &Connection,
    execution_id: &str,
) -> TaskRuntimeResult<Option<(Vec<ExecutionEvent>, FoldedJournal)>> {
    let events = read_journal_events_on(connection, execution_id)?;
    if events.is_empty() {
        return Ok(None);
    }
    let folded = fold_journal(&events, execution_id)?;
    Ok(Some((events, folded)))
}

fn read_journal_events_on(
    connection: &Connection,
    execution_id: &str,
) -> TaskRuntimeResult<Vec<ExecutionEvent>> {
    let mut statement = connection.prepare(
        "SELECT event_id, execution_id, revision, seq, kind, payload_json, created_at
         FROM execution_events
         WHERE execution_id = ?1
         ORDER BY revision ASC, seq ASC, event_id ASC",
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
    let mut previous_revision = None;
    let mut expected_seq = 1_i64;
    for row in rows {
        let (event_id, row_execution_id, revision, seq, kind, payload_json, created_at) = row?;
        if previous_revision != Some(revision) {
            expected_seq = 1;
            previous_revision = Some(revision);
        }
        if row_execution_id != execution_id || seq != expected_seq {
            return Err(TaskRuntimeError::Store(
                "execution journal ownership or sequence is invalid".into(),
            ));
        }
        expected_seq = expected_seq
            .checked_add(1)
            .ok_or_else(|| TaskRuntimeError::Store("execution event sequence exhausted".into()))?;
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

fn fold_journal(events: &[ExecutionEvent], execution_id: &str) -> TaskRuntimeResult<FoldedJournal> {
    let mut revisions: Vec<FoldedExecution> = Vec::new();
    for event in events {
        match &event.event {
            ExecutionJournalEvent::Created { version, contract } => {
                require_event_version(*version)?;
                if !revisions.is_empty() || event.revision != 1 || event.seq != 1 {
                    return Err(TaskRuntimeError::Store(
                        "execution journal must contain exactly one leading creation".into(),
                    ));
                }
                let contract = validate_journal_contract(contract.clone())?;
                let raw = contract.as_ref();
                if raw.execution_id != execution_id || raw.revision != 1 {
                    return Err(TaskRuntimeError::Store(
                        "created contract does not match journal ownership".into(),
                    ));
                }
                revisions.push(FoldedExecution {
                    record: ExecutionRecord {
                        contract,
                        state: ExecutionState::Ready,
                        outcome: None,
                        created_at: event.created_at,
                        updated_at: event.created_at,
                    },
                    outcome_committed_at: None,
                    wake_transition: None,
                });
            }
            ExecutionJournalEvent::RevisionStarted {
                version,
                previous_revision,
                contract,
            } => {
                require_event_version(*version)?;
                if event.seq != 1 || event.revision <= 1 {
                    return Err(TaskRuntimeError::Store(
                        "later execution revisions must begin with revision-start".into(),
                    ));
                }
                let expected_revision = u64::try_from(revisions.len())
                    .ok()
                    .and_then(|count| count.checked_add(1))
                    .ok_or_else(|| {
                        TaskRuntimeError::Store("execution revision sequence exhausted".into())
                    })?;
                if event.revision != expected_revision
                    || *previous_revision != expected_revision - 1
                {
                    return Err(TaskRuntimeError::Store(
                        "execution revisions are not contiguous".into(),
                    ));
                }
                let prior = revisions.last().ok_or_else(|| {
                    TaskRuntimeError::Store("revision-start precedes execution creation".into())
                })?;
                if event.created_at < prior.record.updated_at {
                    return Err(TaskRuntimeError::Store(
                        "execution journal timestamps are not monotonic".into(),
                    ));
                }
                let contract = validate_journal_contract(contract.clone())?;
                if contract.as_ref().execution_id != execution_id
                    || contract.as_ref().revision != event.revision
                {
                    return Err(TaskRuntimeError::Store(
                        "revision-start contract does not match journal ownership".into(),
                    ));
                }
                validate_revision_transition(&prior.record, &contract).map_err(|reason| {
                    TaskRuntimeError::Store(format!(
                        "stored execution revision transition is invalid: {reason}"
                    ))
                })?;
                let wake_transition = prior.wake_transition.as_ref().ok_or_else(|| {
                    TaskRuntimeError::Store(
                        "revision-start has no authoritative wake-delivery event".into(),
                    )
                })?;
                if wake_transition.next_revision != event.revision
                    || contract.as_ref().wake.as_ref() != Some(&wake_transition.delivery)
                    || event.created_at != wake_transition.created_at
                {
                    return Err(TaskRuntimeError::Store(
                        "revision-start does not match its wake-delivery event".into(),
                    ));
                }
                revisions.push(FoldedExecution {
                    record: ExecutionRecord {
                        contract,
                        state: ExecutionState::Ready,
                        outcome: None,
                        created_at: prior.record.created_at,
                        updated_at: event.created_at,
                    },
                    outcome_committed_at: None,
                    wake_transition: None,
                });
            }
            ExecutionJournalEvent::FenceAdvanced {
                version,
                previous_fencing_token,
                contract,
            } => {
                require_event_version(*version)?;
                let current = revisions.last_mut().ok_or_else(|| {
                    TaskRuntimeError::Store("fence event precedes execution creation".into())
                })?;
                if current.record.contract.as_ref().revision != event.revision {
                    return Err(TaskRuntimeError::Store(
                        "fence event does not belong to the current revision".into(),
                    ));
                }
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
                let current = revisions.last_mut().ok_or_else(|| {
                    TaskRuntimeError::Store("outcome event precedes execution creation".into())
                })?;
                if current.record.contract.as_ref().revision != event.revision {
                    return Err(TaskRuntimeError::Store(
                        "outcome event does not belong to the current revision".into(),
                    ));
                }
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
            ExecutionJournalEvent::WakeDelivered {
                version,
                delivery,
                next_revision,
            } => {
                require_event_version(*version)?;
                let current = revisions.last_mut().ok_or_else(|| {
                    TaskRuntimeError::Store("wake event precedes execution creation".into())
                })?;
                if current.record.contract.as_ref().revision != event.revision {
                    return Err(TaskRuntimeError::Store(
                        "wake event does not belong to the current revision".into(),
                    ));
                }
                if current.wake_transition.is_some() {
                    return Err(TaskRuntimeError::Store(
                        "execution revision contains more than one wake delivery".into(),
                    ));
                }
                let outcome_at = current.outcome_committed_at.ok_or_else(|| {
                    TaskRuntimeError::Store("wake event precedes a suspended outcome".into())
                })?;
                let wake = match current.record.outcome.as_ref().map(AsRef::as_ref) {
                    Some(ExecutionOutcome::Suspended { wake, .. }) => wake,
                    _ => {
                        return Err(TaskRuntimeError::Store(
                            "wake event does not follow a suspended outcome".into(),
                        ));
                    }
                };
                let expected_next_revision = event.revision.checked_add(1).ok_or_else(|| {
                    TaskRuntimeError::Store("execution revision sequence exhausted".into())
                })?;
                if *next_revision != expected_next_revision
                    || delivery.condition != *wake
                    || delivery.dedup_key != wake.dedup_key()
                    || delivery.delivered_at_unix_seconds != event.created_at
                    || event.created_at < outcome_at
                {
                    return Err(TaskRuntimeError::Store(
                        "wake-delivery event is not canonical or causal".into(),
                    ));
                }
                current.wake_transition = Some(WakeTransitionEvidence {
                    delivery: delivery.clone(),
                    next_revision: *next_revision,
                    created_at: event.created_at,
                });
            }
        }
    }
    if revisions.is_empty() {
        return Err(TaskRuntimeError::Store(
            "execution journal has no creation event".into(),
        ));
    }
    Ok(FoldedJournal { revisions })
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

fn validate_revision_transition(
    prior: &ExecutionRecord,
    next: &ValidatedExecutionContract,
) -> Result<(), String> {
    let prior_contract = prior.contract.as_ref();
    let next_contract = next.as_ref();
    let expected_revision = prior_contract
        .revision
        .checked_add(1)
        .ok_or_else(|| "execution revision exhausted".to_string())?;
    if next_contract.revision != expected_revision {
        return Err(format!(
            "revision must advance from {} to {expected_revision}",
            prior_contract.revision
        ));
    }
    if next_contract.execution_id != prior_contract.execution_id
        || next_contract.kind != prior_contract.kind
        || next_contract.parent_execution_id != prior_contract.parent_execution_id
        || next_contract.scope != prior_contract.scope
    {
        return Err("execution identity, kind, parent, and scope must remain stable".into());
    }
    if next_contract.schema_version != prior_contract.schema_version
        || next_contract.objective != prior_contract.objective
        || next_contract.input != prior_contract.input
        || next_contract.policy != prior_contract.policy
        || next_contract.resources != prior_contract.resources
        || next_contract.budget != prior_contract.budget
    {
        return Err(
            "schema, objective, input, policy, resources, and budget must remain stable".into(),
        );
    }
    let expected_fencing_token = prior_contract
        .fencing_token
        .checked_add(1)
        .ok_or_else(|| "execution fencing token exhausted".to_string())?;
    if next_contract.fencing_token != expected_fencing_token {
        return Err(format!(
            "fencing token must advance from {} to {expected_fencing_token}",
            prior_contract.fencing_token
        ));
    }

    let (wake, checkpoint) = match prior.outcome.as_ref().map(AsRef::as_ref) {
        Some(ExecutionOutcome::Suspended { wake, checkpoint }) => (wake, checkpoint),
        _ => return Err("the prior revision must have one suspended outcome".into()),
    };
    let checkpoint_ref = next_contract
        .checkpoint
        .as_ref()
        .ok_or_else(|| "next revision must reference the suspended checkpoint".to_string())?;
    if checkpoint_ref.checkpoint_id != checkpoint.checkpoint_id()
        || checkpoint_ref.producer_schema_version != checkpoint.producer_schema_version
    {
        return Err("next revision checkpoint does not match the suspended checkpoint".into());
    }
    let delivery = next_contract
        .wake
        .as_ref()
        .ok_or_else(|| "next revision must include the delivered wake".to_string())?;
    if delivery.condition != *wake || delivery.dedup_key != wake.dedup_key() {
        return Err("wake delivery does not match the suspended wake condition".into());
    }
    Ok(())
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

fn projection_matches_folded_on(
    connection: &Connection,
    execution_id: &str,
    projection: &ExecutionRecord,
    folded: &FoldedExecution,
) -> TaskRuntimeResult<bool> {
    let outcome_committed_at = connection.query_row(
        "SELECT outcome_committed_at FROM executions WHERE execution_id = ?1",
        [execution_id],
        |row| row.get::<_, Option<i64>>(0),
    )?;
    Ok(projection == &folded.record && outcome_committed_at == folded.outcome_committed_at)
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
        ExecutionJournalEvent::RevisionStarted { .. } => "revision_started",
        ExecutionJournalEvent::FenceAdvanced { .. } => "fence_advanced",
        ExecutionJournalEvent::OutcomeCommitted { .. } => "outcome_committed",
        ExecutionJournalEvent::WakeDelivered { .. } => "wake_delivered",
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
