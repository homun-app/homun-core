use crate::{TaskRuntimeError, TaskRuntimeResult, TaskStore};
use local_first_execution_protocol::EffectReceiptRef;
use rusqlite::{Connection, OptionalExtension};

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

pub fn projection_ref(execution_id: &str, revision: u64, projection_kind: &str) -> String {
    format!("{execution_id}:{revision}:{projection_kind}")
}

pub(crate) fn migrate_projection_outbox_v16(
    connection: &Connection,
) -> TaskRuntimeResult<()> {
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

fn value_error(column: usize, error: impl std::error::Error + Send + Sync + 'static) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(column, rusqlite::types::Type::Text, Box::new(error))
}
