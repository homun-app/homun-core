use crate::{
    TaskRuntimeError, TaskRuntimeResult, TaskStore, execution_store::ExecutionJournalEvent,
};
use local_first_execution_protocol::{EffectReceiptRef, ExecutionContract};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};

pub const CHAT_LIFECYCLE_PROJECTION: &str = "chat_lifecycle";

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProjectionStatus {
    Pending,
    Claimed,
    Blocked,
    Completed,
}

impl ProjectionStatus {
    fn parse(value: &str) -> TaskRuntimeResult<Self> {
        match value {
            "pending" => Ok(Self::Pending),
            "claimed" => Ok(Self::Claimed),
            "blocked" => Ok(Self::Blocked),
            "completed" => Ok(Self::Completed),
            other => Err(TaskRuntimeError::Store(format!(
                "unknown projection outbox status: {other}"
            ))),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectionOutboxRecord {
    pub projection_ref: String,
    pub execution_id: String,
    pub revision: u64,
    pub projection_kind: String,
    pub status: ProjectionStatus,
    pub attempt_count: u64,
    pub claim_owner: Option<String>,
    pub claim_generation: Option<u64>,
    pub claim_token: u64,
    pub not_before: Option<i64>,
    pub blocked_on_ref: Option<EffectReceiptRef>,
    pub last_error_code: Option<String>,
    pub last_error_detail: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub completed_at: Option<i64>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectionErrorEvidence {
    pub code: String,
    pub redacted_detail: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectionClaim {
    pub record: ProjectionOutboxRecord,
    pub owner: String,
    pub generation: u64,
    pub token: u64,
}

pub fn projection_ref(execution_id: &str, revision: u64, projection_kind: &str) -> String {
    format!("{execution_id}:{revision}:{projection_kind}")
}

pub(crate) fn migrate_projection_outbox_v16(connection: &Connection) -> TaskRuntimeResult<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS execution_projection_outbox (
            projection_ref TEXT PRIMARY KEY,
            execution_id TEXT NOT NULL CHECK(length(trim(execution_id)) > 0),
            revision INTEGER NOT NULL CHECK(revision > 0),
            projection_kind TEXT NOT NULL CHECK(length(trim(projection_kind)) > 0),
            status TEXT NOT NULL CHECK(status IN ('pending', 'claimed', 'blocked', 'completed')),
            attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
            claim_owner TEXT,
            claim_generation INTEGER CHECK(claim_generation > 0),
            claim_token INTEGER NOT NULL DEFAULT 0 CHECK(claim_token >= 0),
            claimed_at INTEGER,
            not_before INTEGER,
            blocked_on_ref TEXT,
            last_error_code TEXT,
            last_error_detail TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            completed_at INTEGER,
            UNIQUE(execution_id, revision, projection_kind),
            CHECK(
                (status = 'pending'
                    AND claim_owner IS NULL AND claim_generation IS NULL AND claimed_at IS NULL
                    AND blocked_on_ref IS NULL AND completed_at IS NULL)
                OR (status = 'claimed'
                    AND claim_owner IS NOT NULL AND claim_generation IS NOT NULL
                    AND claimed_at IS NOT NULL AND blocked_on_ref IS NULL AND completed_at IS NULL)
                OR (status = 'blocked'
                    AND claim_owner IS NULL AND claim_generation IS NULL AND claimed_at IS NULL
                    AND blocked_on_ref IS NOT NULL AND completed_at IS NULL)
                OR (status = 'completed'
                    AND claim_owner IS NULL AND claim_generation IS NULL AND claimed_at IS NULL
                    AND blocked_on_ref IS NULL AND completed_at IS NOT NULL)
            )
        );

        CREATE INDEX IF NOT EXISTS idx_execution_projection_outbox_due
            ON execution_projection_outbox(projection_kind, status, not_before, created_at);
        CREATE INDEX IF NOT EXISTS idx_execution_projection_outbox_blocked
            ON execution_projection_outbox(blocked_on_ref, status);",
    )?;
    backfill_projection_outbox_v16(connection)?;
    Ok(())
}

pub(crate) fn enqueue_projection_on(
    connection: &Connection,
    contract: &ExecutionContract,
    committed_at: i64,
) -> TaskRuntimeResult<()> {
    let Some(projection_kind) = projector_kind(&contract.kind) else {
        return Ok(());
    };
    let reference = projection_ref(&contract.execution_id, contract.revision, projection_kind);
    connection.execute(
        "INSERT INTO execution_projection_outbox (
            projection_ref, execution_id, revision, projection_kind, status,
            attempt_count, claim_token, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, 'pending', 0, 0, ?5, ?5)
         ON CONFLICT(projection_ref) DO NOTHING",
        params![
            reference,
            contract.execution_id,
            sqlite_u64(contract.revision, "projection revision")?,
            projection_kind,
            committed_at,
        ],
    )?;
    let stored = connection.query_row(
        "SELECT execution_id, revision, projection_kind
         FROM execution_projection_outbox WHERE projection_ref = ?1",
        [&reference],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
            ))
        },
    )?;
    if stored
        != (
            contract.execution_id.clone(),
            sqlite_u64(contract.revision, "projection revision")?,
            projection_kind.to_string(),
        )
    {
        return Err(TaskRuntimeError::Conflict(
            "projection reference is bound to a different execution revision".into(),
        ));
    }
    Ok(())
}

fn projector_kind(execution_kind: &str) -> Option<&'static str> {
    (execution_kind == "chat_turn").then_some(CHAT_LIFECYCLE_PROJECTION)
}

fn backfill_projection_outbox_v16(connection: &Connection) -> TaskRuntimeResult<()> {
    let tx = Transaction::new_unchecked(connection, TransactionBehavior::Immediate)?;
    let committed = {
        let mut statement = tx.prepare(
            "SELECT execution_id, revision, created_at
             FROM execution_events
             WHERE kind = 'outcome_committed'
             ORDER BY created_at, execution_id, revision",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    for (execution_id, revision, committed_at) in committed {
        let payload = tx
            .query_row(
                "SELECT payload_json
                 FROM execution_events
                 WHERE execution_id = ?1 AND revision = ?2
                   AND kind IN ('execution_created', 'revision_started')
                 ORDER BY seq
                 LIMIT 1",
                params![execution_id, revision],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .ok_or_else(|| {
                TaskRuntimeError::Store(format!(
                    "committed projection history has no revision contract: {execution_id}:{revision}"
                ))
            })?;
        let event: ExecutionJournalEvent = serde_json::from_str(&payload)?;
        let contract = match event {
            ExecutionJournalEvent::Created { contract, .. }
            | ExecutionJournalEvent::RevisionStarted { contract, .. } => contract,
            _ => {
                return Err(TaskRuntimeError::Store(format!(
                    "projection backfill loaded a non-contract event: {execution_id}:{revision}"
                )));
            }
        };
        enqueue_projection_on(&tx, &contract, committed_at)?;
    }
    tx.commit()?;
    Ok(())
}

impl TaskStore {
    pub fn projection_outbox_record(
        &self,
        reference: &str,
    ) -> TaskRuntimeResult<Option<ProjectionOutboxRecord>> {
        self.connection
            .query_row(
                "SELECT projection_ref, execution_id, revision, projection_kind, status,
                        attempt_count, claim_owner, claim_generation, claim_token, not_before,
                        blocked_on_ref, last_error_code, last_error_detail, created_at, updated_at,
                        completed_at
                 FROM execution_projection_outbox WHERE projection_ref = ?1",
                [reference],
                projection_row,
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn claim_projection(
        &self,
        projection_kind: &str,
        owner: &str,
        generation: u64,
        now: i64,
    ) -> TaskRuntimeResult<Option<ProjectionClaim>> {
        let projection_kind = required_text(projection_kind, "projection kind")?;
        let owner = required_text(owner, "projection owner")?;
        let generation_sql = positive_sqlite_u64(generation, "projection claim generation")?;
        let tx = Transaction::new_unchecked(&self.connection, TransactionBehavior::Immediate)?;
        let reference = tx
            .query_row(
                "SELECT projection_ref
                 FROM execution_projection_outbox
                 WHERE projection_kind = ?1
                   AND (
                       (status = 'pending' AND (not_before IS NULL OR not_before <= ?2))
                       OR (status = 'claimed' AND claim_generation < ?3)
                   )
                 ORDER BY created_at, projection_ref
                 LIMIT 1",
                params![projection_kind, now, generation_sql],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        let Some(reference) = reference else {
            tx.commit()?;
            return Ok(None);
        };
        let changed = tx.execute(
            "UPDATE execution_projection_outbox
             SET status = 'claimed', attempt_count = attempt_count + 1,
                 claim_owner = ?1, claim_generation = ?2, claim_token = claim_token + 1,
                 claimed_at = ?3, not_before = NULL, blocked_on_ref = NULL,
                 completed_at = NULL, updated_at = ?3
             WHERE projection_ref = ?4
               AND (
                   (status = 'pending' AND (not_before IS NULL OR not_before <= ?3))
                   OR (status = 'claimed' AND claim_generation < ?2)
               )",
            params![owner, generation_sql, now, reference],
        )?;
        if changed != 1 {
            return Err(TaskRuntimeError::Conflict(
                "projection claim changed concurrently".into(),
            ));
        }
        let record = tx.query_row(
            "SELECT projection_ref, execution_id, revision, projection_kind, status,
                    attempt_count, claim_owner, claim_generation, claim_token, not_before,
                    blocked_on_ref, last_error_code, last_error_detail, created_at, updated_at,
                    completed_at
             FROM execution_projection_outbox WHERE projection_ref = ?1",
            [&reference],
            projection_row,
        )?;
        let token = record.claim_token;
        tx.commit()?;
        Ok(Some(ProjectionClaim {
            record,
            owner: owner.to_string(),
            generation,
            token,
        }))
    }

    pub fn complete_projection(&self, claim: &ProjectionClaim, now: i64) -> TaskRuntimeResult<()> {
        self.finish_claim(claim, "completed", None, None, None, None, Some(now), now)
    }

    pub fn retry_projection(
        &self,
        claim: &ProjectionClaim,
        error: &ProjectionErrorEvidence,
        not_before: i64,
        now: i64,
    ) -> TaskRuntimeResult<()> {
        let code = required_text(&error.code, "projection error code")?;
        let detail = required_text(&error.redacted_detail, "projection error detail")?;
        if not_before < now {
            return Err(TaskRuntimeError::InvalidTransition(
                "projection retry cannot be scheduled in the past".into(),
            ));
        }
        self.finish_claim(
            claim,
            "pending",
            Some(not_before),
            None,
            Some(code),
            Some(detail),
            None,
            now,
        )
    }

    pub fn block_projection(
        &self,
        claim: &ProjectionClaim,
        receipt_ref: &EffectReceiptRef,
        now: i64,
    ) -> TaskRuntimeResult<()> {
        self.finish_claim(
            claim,
            "blocked",
            None,
            Some(receipt_ref.as_ref()),
            None,
            None,
            None,
            now,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn finish_claim(
        &self,
        claim: &ProjectionClaim,
        status: &str,
        not_before: Option<i64>,
        blocked_on_ref: Option<&str>,
        last_error_code: Option<&str>,
        last_error_detail: Option<&str>,
        completed_at: Option<i64>,
        now: i64,
    ) -> TaskRuntimeResult<()> {
        let generation = positive_sqlite_u64(claim.generation, "projection claim generation")?;
        let token = positive_sqlite_u64(claim.token, "projection claim token")?;
        let changed = self.connection.execute(
            "UPDATE execution_projection_outbox
             SET status = ?1, claim_owner = NULL, claim_generation = NULL, claimed_at = NULL,
                 not_before = ?2, blocked_on_ref = ?3, last_error_code = ?4,
                 last_error_detail = ?5, completed_at = ?6, updated_at = ?7
             WHERE projection_ref = ?8 AND status = 'claimed'
               AND claim_owner = ?9 AND claim_generation = ?10 AND claim_token = ?11",
            params![
                status,
                not_before,
                blocked_on_ref,
                last_error_code,
                last_error_detail,
                completed_at,
                now,
                claim.record.projection_ref,
                claim.owner,
                generation,
                token,
            ],
        )?;
        if changed != 1 {
            return Err(TaskRuntimeError::InvalidTransition(
                "projection claim is stale or no longer active".into(),
            ));
        }
        Ok(())
    }
}

fn projection_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ProjectionOutboxRecord> {
    let status = row.get::<_, String>(4)?;
    let revision = row.get::<_, i64>(2)?;
    let attempt_count = row.get::<_, i64>(5)?;
    let claim_generation = row.get::<_, Option<i64>>(7)?;
    let claim_token = row.get::<_, i64>(8)?;
    let blocked_on_ref = row.get::<_, Option<String>>(10)?;
    Ok(ProjectionOutboxRecord {
        projection_ref: row.get(0)?,
        execution_id: row.get(1)?,
        revision: u64::try_from(revision).map_err(|_| integral_error(2, revision))?,
        projection_kind: row.get(3)?,
        status: ProjectionStatus::parse(&status).map_err(|error| value_error(4, error))?,
        attempt_count: u64::try_from(attempt_count)
            .map_err(|_| integral_error(5, attempt_count))?,
        claim_owner: row.get(6)?,
        claim_generation: claim_generation
            .map(|value| u64::try_from(value).map_err(|_| integral_error(7, value)))
            .transpose()?,
        claim_token: u64::try_from(claim_token).map_err(|_| integral_error(8, claim_token))?,
        not_before: row.get(9)?,
        blocked_on_ref: blocked_on_ref
            .map(|value| EffectReceiptRef::parse(value).map_err(|error| value_error(10, error)))
            .transpose()?,
        last_error_code: row.get(11)?,
        last_error_detail: row.get(12)?,
        created_at: row.get(13)?,
        updated_at: row.get(14)?,
        completed_at: row.get(15)?,
    })
}

fn integral_error(column: usize, value: i64) -> rusqlite::Error {
    rusqlite::Error::IntegralValueOutOfRange(column, value)
}

fn value_error(
    column: usize,
    error: impl std::error::Error + Send + Sync + 'static,
) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(column, rusqlite::types::Type::Text, Box::new(error))
}

fn sqlite_u64(value: u64, field: &str) -> TaskRuntimeResult<i64> {
    i64::try_from(value)
        .map_err(|_| TaskRuntimeError::Store(format!("{field} exceeds SQLite integer range")))
}

fn positive_sqlite_u64(value: u64, field: &str) -> TaskRuntimeResult<i64> {
    if value == 0 {
        return Err(TaskRuntimeError::Store(format!("{field} must be positive")));
    }
    sqlite_u64(value, field)
}

fn required_text<'a>(value: &'a str, field: &str) -> TaskRuntimeResult<&'a str> {
    let value = value.trim();
    if value.is_empty() {
        return Err(TaskRuntimeError::Store(format!("{field} cannot be empty")));
    }
    Ok(value)
}
