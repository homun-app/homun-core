use local_first_inference_usage::{
    AttemptEventKind, AttemptOutcome, UsageAttemptEvent, UsageRecorder,
};
use rusqlite::{Connection, Row, Transaction, named_params, params, types::Type};
use serde::{Serialize, de::DeserializeOwned};
use std::{
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
        mpsc::{SyncSender, TrySendError, sync_channel},
    },
    thread::JoinHandle,
    time::Duration,
};

const EVENT_COLUMNS: &str = "event_id, call_id, attempt_id, event_kind, user_id, workspace_id, \
thread_id, turn_id, run_id, task_id, round, purpose, purpose_detail, provider_id, model_id, \
locality, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens, \
latency_ms, time_to_first_token_ms, outcome, error_class, upstream_status, finish_reason, \
rate_limit_limit, rate_limit_remaining, rate_limit_reset_at, cost_microusd, usage_provenance, \
cost_provenance, pricing_source, pricing_version, started_at, recorded_at, schema_version";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppendOutcome {
    Inserted,
    Duplicate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UsageWindow {
    SevenDays,
    ThirtyDays,
    All,
}

impl UsageWindow {
    pub fn cutoff(self, now: i64) -> Option<i64> {
        match self {
            Self::SevenDays => Some(now.saturating_sub(7 * 86_400)),
            Self::ThirtyDays => Some(now.saturating_sub(30 * 86_400)),
            Self::All => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct UsageBreakdownRow {
    pub key: String,
    pub logical_calls: u64,
    pub attempts: u64,
    pub successful_attempts: u64,
    pub failed_attempts: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub reasoning_tokens: u64,
    pub cost_microusd: u64,
    pub known_usage_attempts: u64,
    pub unknown_usage_attempts: u64,
}

#[derive(Debug, Clone, Copy)]
pub enum UsageBreakdownDimension {
    Model,
    Provider,
    Purpose,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
pub struct UsageSummary {
    pub logical_calls: u64,
    pub attempts: u64,
    pub successful_attempts: u64,
    pub failed_attempts: u64,
    pub aborted_attempts: u64,
    pub known_usage_attempts: u64,
    pub unknown_usage_attempts: u64,
    pub usage_coverage_percent: u8,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub reasoning_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub cost_microusd: u64,
    pub coverage_started_at: Option<i64>,
}

#[cfg(test)]
#[derive(Debug, Clone, PartialEq, Eq)]
struct DailyUsageRow {
    input_tokens: u64,
}

pub struct UsageStore {
    conn: Connection,
}

impl UsageStore {
    pub fn open(path: impl AsRef<Path>) -> rusqlite::Result<Self> {
        let conn = Connection::open(path)?;
        conn.busy_timeout(Duration::from_secs(5))?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
        let store = Self { conn };
        store.migrate()?;
        Ok(store)
    }

    pub fn open_in_memory() -> rusqlite::Result<Self> {
        let conn = Connection::open_in_memory()?;
        conn.busy_timeout(Duration::from_secs(5))?;
        conn.execute_batch("PRAGMA foreign_keys=ON;")?;
        let store = Self { conn };
        store.migrate()?;
        Ok(store)
    }

    fn migrate(&self) -> rusqlite::Result<()> {
        self.conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS inference_usage_events (
                event_id TEXT PRIMARY KEY,
                call_id TEXT NOT NULL,
                attempt_id TEXT NOT NULL,
                event_kind TEXT NOT NULL,
                user_id TEXT NOT NULL,
                workspace_id TEXT,
                thread_id TEXT,
                turn_id TEXT,
                run_id TEXT,
                task_id TEXT,
                round INTEGER,
                purpose TEXT NOT NULL,
                purpose_detail TEXT,
                provider_id TEXT,
                model_id TEXT,
                locality TEXT NOT NULL,
                input_tokens INTEGER,
                output_tokens INTEGER,
                reasoning_tokens INTEGER,
                cache_read_tokens INTEGER,
                cache_write_tokens INTEGER,
                latency_ms INTEGER,
                time_to_first_token_ms INTEGER,
                outcome TEXT,
                error_class TEXT,
                upstream_status INTEGER,
                finish_reason TEXT,
                rate_limit_limit INTEGER,
                rate_limit_remaining INTEGER,
                rate_limit_reset_at INTEGER,
                cost_microusd INTEGER,
                usage_provenance TEXT NOT NULL,
                cost_provenance TEXT NOT NULL,
                pricing_source TEXT,
                pricing_version TEXT,
                started_at INTEGER NOT NULL,
                recorded_at INTEGER NOT NULL,
                schema_version INTEGER NOT NULL,
                UNIQUE(attempt_id, event_kind)
            );
            CREATE INDEX IF NOT EXISTS idx_inference_usage_scope_time
                ON inference_usage_events(user_id, workspace_id, recorded_at);
            CREATE INDEX IF NOT EXISTS idx_inference_usage_attempt
                ON inference_usage_events(attempt_id, recorded_at);
            CREATE INDEX IF NOT EXISTS idx_inference_usage_call
                ON inference_usage_events(call_id, recorded_at);
            CREATE TABLE IF NOT EXISTS inference_usage_daily (
                day_epoch INTEGER NOT NULL,
                user_id TEXT NOT NULL,
                workspace_id TEXT NOT NULL,
                provider_id TEXT NOT NULL,
                model_id TEXT NOT NULL,
                locality TEXT NOT NULL,
                purpose TEXT NOT NULL,
                terminal_attempts INTEGER NOT NULL,
                successful_attempts INTEGER NOT NULL,
                failed_attempts INTEGER NOT NULL,
                aborted_attempts INTEGER NOT NULL,
                known_usage_attempts INTEGER NOT NULL,
                unknown_usage_attempts INTEGER NOT NULL,
                input_tokens INTEGER NOT NULL,
                output_tokens INTEGER NOT NULL,
                reasoning_tokens INTEGER NOT NULL,
                cache_read_tokens INTEGER NOT NULL,
                cache_write_tokens INTEGER NOT NULL,
                cost_microusd INTEGER NOT NULL,
                known_cost_attempts INTEGER NOT NULL,
                unknown_cost_attempts INTEGER NOT NULL,
                PRIMARY KEY(day_epoch, user_id, workspace_id, provider_id, model_id, locality, purpose)
            );",
        )
    }

    pub fn append(&self, event: &UsageAttemptEvent) -> rusqlite::Result<AppendOutcome> {
        let transaction = self.conn.unchecked_transaction()?;
        let inserted = insert_event(&transaction, event)?;
        if inserted == 1 && event.event_kind != AttemptEventKind::AttemptStarted {
            upsert_daily_event(&transaction, event)?;
        }
        transaction.commit()?;
        Ok(if inserted == 1 {
            AppendOutcome::Inserted
        } else {
            AppendOutcome::Duplicate
        })
    }

    pub fn events_for_attempt(&self, attempt_id: &str) -> rusqlite::Result<Vec<UsageAttemptEvent>> {
        let sql = format!(
            "SELECT {EVENT_COLUMNS} FROM inference_usage_events
             WHERE attempt_id = ?1 ORDER BY recorded_at ASC, event_id ASC"
        );
        let mut statement = self.conn.prepare(&sql)?;
        statement
            .query_map(params![attempt_id], event_from_row)?
            .collect()
    }

    pub fn events_for_scope(
        &self,
        user_id: &str,
        workspace_id: Option<&str>,
    ) -> rusqlite::Result<Vec<UsageAttemptEvent>> {
        let (sql, workspace) = match workspace_id {
            Some(workspace) => (
                format!(
                    "SELECT {EVENT_COLUMNS} FROM inference_usage_events
                     WHERE user_id = ?1 AND workspace_id = ?2
                     ORDER BY recorded_at ASC, event_id ASC"
                ),
                Some(workspace),
            ),
            None => (
                format!(
                    "SELECT {EVENT_COLUMNS} FROM inference_usage_events
                     WHERE user_id = ?1 ORDER BY recorded_at ASC, event_id ASC"
                ),
                None,
            ),
        };
        let mut statement = self.conn.prepare(&sql)?;
        if let Some(workspace) = workspace {
            statement
                .query_map(params![user_id, workspace], event_from_row)?
                .collect()
        } else {
            statement
                .query_map(params![user_id], event_from_row)?
                .collect()
        }
    }

    pub fn abort_orphaned_attempts(&self, now: i64) -> rusqlite::Result<usize> {
        let sql = format!(
            "SELECT {EVENT_COLUMNS} FROM inference_usage_events started
             WHERE started.event_kind = 'attempt_started'
               AND NOT EXISTS (
                   SELECT 1 FROM inference_usage_events terminal
                   WHERE terminal.attempt_id = started.attempt_id
                     AND terminal.event_kind != 'attempt_started'
               )
             ORDER BY started.recorded_at ASC"
        );
        let orphaned = {
            let mut statement = self.conn.prepare(&sql)?;
            statement
                .query_map([], event_from_row)?
                .collect::<rusqlite::Result<Vec<_>>>()?
        };
        let mut appended = 0;
        for started in orphaned {
            if self.append(&started.aborted(now, "process_recovery"))? == AppendOutcome::Inserted {
                appended += 1;
            }
        }
        Ok(appended)
    }

    pub fn purge_workspace(&self, user_id: &str, workspace_id: &str) -> rusqlite::Result<usize> {
        let transaction = self.conn.unchecked_transaction()?;
        let deleted = transaction.execute(
            "DELETE FROM inference_usage_events WHERE user_id = ?1 AND workspace_id = ?2",
            params![user_id, workspace_id],
        )?;
        transaction.execute(
            "DELETE FROM inference_usage_daily WHERE user_id = ?1 AND workspace_id = ?2",
            params![user_id, workspace_id],
        )?;
        transaction.commit()?;
        Ok(deleted)
    }

    pub fn summary(
        &self,
        user_id: &str,
        window: UsageWindow,
        now: i64,
    ) -> rusqlite::Result<UsageSummary> {
        let cutoff = window.cutoff(now).unwrap_or(i64::MIN);
        let mut statement = self.conn.prepare(
            "SELECT
                COUNT(DISTINCT call_id),
                COUNT(*),
                COALESCE(SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN outcome = 'failed' THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN outcome = 'aborted' THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN input_tokens IS NOT NULL OR output_tokens IS NOT NULL
                                       OR reasoning_tokens IS NOT NULL OR cache_read_tokens IS NOT NULL
                                       OR cache_write_tokens IS NOT NULL THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN input_tokens IS NULL AND output_tokens IS NULL
                                       AND reasoning_tokens IS NULL AND cache_read_tokens IS NULL
                                       AND cache_write_tokens IS NULL THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(input_tokens), 0),
                COALESCE(SUM(output_tokens), 0),
                COALESCE(SUM(reasoning_tokens), 0),
                COALESCE(SUM(cache_read_tokens), 0),
                COALESCE(SUM(cache_write_tokens), 0),
                COALESCE(SUM(cost_microusd), 0),
                MIN(recorded_at)
             FROM inference_usage_events
             WHERE user_id = ?1 AND event_kind != 'attempt_started' AND recorded_at >= ?2",
        )?;
        let mut summary = statement.query_row(params![user_id, cutoff], |row| {
            Ok(UsageSummary {
                logical_calls: nonnegative_u64(row.get(0)?, 0)?,
                attempts: nonnegative_u64(row.get(1)?, 1)?,
                successful_attempts: nonnegative_u64(row.get(2)?, 2)?,
                failed_attempts: nonnegative_u64(row.get(3)?, 3)?,
                aborted_attempts: nonnegative_u64(row.get(4)?, 4)?,
                known_usage_attempts: nonnegative_u64(row.get(5)?, 5)?,
                unknown_usage_attempts: nonnegative_u64(row.get(6)?, 6)?,
                input_tokens: nonnegative_u64(row.get(7)?, 7)?,
                output_tokens: nonnegative_u64(row.get(8)?, 8)?,
                reasoning_tokens: nonnegative_u64(row.get(9)?, 9)?,
                cache_read_tokens: nonnegative_u64(row.get(10)?, 10)?,
                cache_write_tokens: nonnegative_u64(row.get(11)?, 11)?,
                cost_microusd: nonnegative_u64(row.get(12)?, 12)?,
                coverage_started_at: row.get(13)?,
                usage_coverage_percent: 0,
            })
        })?;
        summary.usage_coverage_percent = percentage(
            summary.known_usage_attempts,
            summary
                .known_usage_attempts
                .saturating_add(summary.unknown_usage_attempts),
        );
        Ok(summary)
    }

    pub fn breakdown(
        &self,
        user_id: &str,
        window: UsageWindow,
        now: i64,
        dimension: UsageBreakdownDimension,
    ) -> rusqlite::Result<Vec<UsageBreakdownRow>> {
        let column = match dimension {
            UsageBreakdownDimension::Model => "model_id",
            UsageBreakdownDimension::Provider => "provider_id",
            UsageBreakdownDimension::Purpose => "purpose",
        };
        let sql = format!(
            "SELECT COALESCE({column}, 'unknown'), COUNT(DISTINCT call_id), COUNT(*),
                    SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END),
                    SUM(CASE WHEN outcome = 'failed' THEN 1 ELSE 0 END),
                    SUM(COALESCE(input_tokens, 0)), SUM(COALESCE(output_tokens, 0)),
                    SUM(COALESCE(reasoning_tokens, 0)), SUM(COALESCE(cost_microusd, 0)),
                    SUM(CASE WHEN input_tokens IS NOT NULL OR output_tokens IS NOT NULL THEN 1 ELSE 0 END),
                    SUM(CASE WHEN input_tokens IS NULL AND output_tokens IS NULL THEN 1 ELSE 0 END)
             FROM inference_usage_events
             WHERE user_id = ?1 AND event_kind != 'attempt_started'
               AND (?2 IS NULL OR recorded_at >= ?2)
             GROUP BY COALESCE({column}, 'unknown')
             ORDER BY SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)) DESC"
        );
        let cutoff = window.cutoff(now);
        let mut statement = self.conn.prepare(&sql)?;
        let rows = statement.query_map(params![user_id, cutoff], |row| {
            Ok(UsageBreakdownRow {
                key: row.get(0)?,
                logical_calls: row.get(1)?,
                attempts: row.get(2)?,
                successful_attempts: row.get(3)?,
                failed_attempts: row.get(4)?,
                input_tokens: row.get(5)?,
                output_tokens: row.get(6)?,
                reasoning_tokens: row.get(7)?,
                cost_microusd: row.get(8)?,
                known_usage_attempts: row.get(9)?,
                unknown_usage_attempts: row.get(10)?,
            })
        })?;
        rows.collect()
    }

    pub fn rebuild_daily_rollups(&self) -> rusqlite::Result<usize> {
        let transaction = self.conn.unchecked_transaction()?;
        transaction.execute("DELETE FROM inference_usage_daily", [])?;
        let inserted = transaction.execute(
            "INSERT INTO inference_usage_daily (
                day_epoch, user_id, workspace_id, provider_id, model_id, locality, purpose,
                terminal_attempts, successful_attempts, failed_attempts, aborted_attempts,
                known_usage_attempts, unknown_usage_attempts, input_tokens, output_tokens,
                reasoning_tokens, cache_read_tokens, cache_write_tokens, cost_microusd,
                known_cost_attempts, unknown_cost_attempts
             )
             SELECT
                (recorded_at / 86400) * 86400,
                user_id,
                COALESCE(workspace_id, ''),
                COALESCE(provider_id, ''),
                COALESCE(model_id, ''),
                locality,
                purpose,
                COUNT(*),
                SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END),
                SUM(CASE WHEN outcome = 'failed' THEN 1 ELSE 0 END),
                SUM(CASE WHEN outcome = 'aborted' THEN 1 ELSE 0 END),
                SUM(CASE WHEN input_tokens IS NOT NULL OR output_tokens IS NOT NULL
                              OR reasoning_tokens IS NOT NULL OR cache_read_tokens IS NOT NULL
                              OR cache_write_tokens IS NOT NULL THEN 1 ELSE 0 END),
                SUM(CASE WHEN input_tokens IS NULL AND output_tokens IS NULL
                              AND reasoning_tokens IS NULL AND cache_read_tokens IS NULL
                              AND cache_write_tokens IS NULL THEN 1 ELSE 0 END),
                COALESCE(SUM(input_tokens), 0),
                COALESCE(SUM(output_tokens), 0),
                COALESCE(SUM(reasoning_tokens), 0),
                COALESCE(SUM(cache_read_tokens), 0),
                COALESCE(SUM(cache_write_tokens), 0),
                COALESCE(SUM(cost_microusd), 0),
                SUM(CASE WHEN cost_microusd IS NOT NULL THEN 1 ELSE 0 END),
                SUM(CASE WHEN cost_microusd IS NULL THEN 1 ELSE 0 END)
             FROM inference_usage_events
             WHERE event_kind != 'attempt_started'
             GROUP BY (recorded_at / 86400) * 86400, user_id, COALESCE(workspace_id, ''),
                      COALESCE(provider_id, ''), COALESCE(model_id, ''), locality, purpose",
            [],
        )?;
        transaction.commit()?;
        Ok(inserted)
    }

    pub fn vacuum(&self) -> rusqlite::Result<()> {
        self.conn.execute_batch("VACUUM")
    }

    #[cfg(test)]
    fn clear_daily_rollups_for_test(&self) -> rusqlite::Result<()> {
        self.conn.execute("DELETE FROM inference_usage_daily", [])?;
        Ok(())
    }

    #[cfg(test)]
    fn daily_rows(&self) -> rusqlite::Result<Vec<DailyUsageRow>> {
        let mut statement = self.conn.prepare(
            "SELECT input_tokens FROM inference_usage_daily
             ORDER BY day_epoch, user_id, workspace_id, provider_id, model_id, locality, purpose",
        )?;
        statement
            .query_map([], |row| {
                Ok(DailyUsageRow {
                    input_tokens: nonnegative_u64(row.get(0)?, 0)?,
                })
            })?
            .collect()
    }
}

fn insert_event(
    transaction: &Transaction<'_>,
    event: &UsageAttemptEvent,
) -> rusqlite::Result<usize> {
    transaction.execute(
        "INSERT OR IGNORE INTO inference_usage_events (
            event_id, call_id, attempt_id, event_kind, user_id, workspace_id, thread_id, turn_id,
            run_id, task_id, round, purpose, purpose_detail, provider_id, model_id, locality,
            input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens,
            latency_ms, time_to_first_token_ms, outcome, error_class, upstream_status,
            finish_reason, rate_limit_limit, rate_limit_remaining, rate_limit_reset_at,
            cost_microusd, usage_provenance, cost_provenance, pricing_source, pricing_version,
            started_at, recorded_at, schema_version
         ) VALUES (
            :event_id, :call_id, :attempt_id, :event_kind, :user_id, :workspace_id, :thread_id,
            :turn_id, :run_id, :task_id, :round, :purpose, :purpose_detail, :provider_id,
            :model_id, :locality, :input_tokens, :output_tokens, :reasoning_tokens,
            :cache_read_tokens, :cache_write_tokens, :latency_ms, :time_to_first_token_ms,
            :outcome, :error_class, :upstream_status, :finish_reason, :rate_limit_limit,
            :rate_limit_remaining, :rate_limit_reset_at, :cost_microusd, :usage_provenance,
            :cost_provenance, :pricing_source, :pricing_version, :started_at, :recorded_at,
            :schema_version
         )",
        named_params! {
            ":event_id": event.event_id,
            ":call_id": event.call_id,
            ":attempt_id": event.attempt_id,
            ":event_kind": enum_to_sql(event.event_kind)?,
            ":user_id": event.user_id,
            ":workspace_id": event.workspace_id,
            ":thread_id": event.thread_id,
            ":turn_id": event.turn_id,
            ":run_id": event.run_id,
            ":task_id": event.task_id,
            ":round": optional_u64_to_i64(event.round.map(u64::from))?,
            ":purpose": enum_to_sql(event.purpose)?,
            ":purpose_detail": event.purpose_detail,
            ":provider_id": event.provider_id,
            ":model_id": event.model_id,
            ":locality": enum_to_sql(event.locality)?,
            ":input_tokens": optional_u64_to_i64(event.input_tokens)?,
            ":output_tokens": optional_u64_to_i64(event.output_tokens)?,
            ":reasoning_tokens": optional_u64_to_i64(event.reasoning_tokens)?,
            ":cache_read_tokens": optional_u64_to_i64(event.cache_read_tokens)?,
            ":cache_write_tokens": optional_u64_to_i64(event.cache_write_tokens)?,
            ":latency_ms": optional_u64_to_i64(event.latency_ms)?,
            ":time_to_first_token_ms": optional_u64_to_i64(event.time_to_first_token_ms)?,
            ":outcome": event.outcome.map(enum_to_sql).transpose()?,
            ":error_class": event.error_class,
            ":upstream_status": event.upstream_status.map(i64::from),
            ":finish_reason": event.finish_reason,
            ":rate_limit_limit": optional_u64_to_i64(event.rate_limit_limit)?,
            ":rate_limit_remaining": optional_u64_to_i64(event.rate_limit_remaining)?,
            ":rate_limit_reset_at": event.rate_limit_reset_at,
            ":cost_microusd": optional_u64_to_i64(event.cost_microusd)?,
            ":usage_provenance": enum_to_sql(event.usage_provenance)?,
            ":cost_provenance": enum_to_sql(event.cost_provenance)?,
            ":pricing_source": event.pricing_source,
            ":pricing_version": event.pricing_version,
            ":started_at": event.started_at,
            ":recorded_at": event.recorded_at,
            ":schema_version": i64::from(event.schema_version),
        },
    )
}

fn upsert_daily_event(
    transaction: &Transaction<'_>,
    event: &UsageAttemptEvent,
) -> rusqlite::Result<()> {
    let known_usage = event.input_tokens.is_some()
        || event.output_tokens.is_some()
        || event.reasoning_tokens.is_some()
        || event.cache_read_tokens.is_some()
        || event.cache_write_tokens.is_some();
    let success = u64::from(event.outcome == Some(AttemptOutcome::Success));
    let failed = u64::from(event.outcome == Some(AttemptOutcome::Failed));
    let aborted = u64::from(event.outcome == Some(AttemptOutcome::Aborted));
    transaction.execute(
        "INSERT INTO inference_usage_daily (
            day_epoch, user_id, workspace_id, provider_id, model_id, locality, purpose,
            terminal_attempts, successful_attempts, failed_attempts, aborted_attempts,
            known_usage_attempts, unknown_usage_attempts, input_tokens, output_tokens,
            reasoning_tokens, cache_read_tokens, cache_write_tokens, cost_microusd,
            known_cost_attempts, unknown_cost_attempts
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
                   ?15, ?16, ?17, ?18, ?19, ?20)
         ON CONFLICT(day_epoch, user_id, workspace_id, provider_id, model_id, locality, purpose)
         DO UPDATE SET
            terminal_attempts = terminal_attempts + 1,
            successful_attempts = successful_attempts + excluded.successful_attempts,
            failed_attempts = failed_attempts + excluded.failed_attempts,
            aborted_attempts = aborted_attempts + excluded.aborted_attempts,
            known_usage_attempts = known_usage_attempts + excluded.known_usage_attempts,
            unknown_usage_attempts = unknown_usage_attempts + excluded.unknown_usage_attempts,
            input_tokens = input_tokens + excluded.input_tokens,
            output_tokens = output_tokens + excluded.output_tokens,
            reasoning_tokens = reasoning_tokens + excluded.reasoning_tokens,
            cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
            cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
            cost_microusd = cost_microusd + excluded.cost_microusd,
            known_cost_attempts = known_cost_attempts + excluded.known_cost_attempts,
            unknown_cost_attempts = unknown_cost_attempts + excluded.unknown_cost_attempts",
        params![
            event.recorded_at.div_euclid(86_400) * 86_400,
            event.user_id,
            event.workspace_id.as_deref().unwrap_or(""),
            event.provider_id.as_deref().unwrap_or(""),
            event.model_id.as_deref().unwrap_or(""),
            enum_to_sql(event.locality)?,
            enum_to_sql(event.purpose)?,
            u64_to_i64(success)?,
            u64_to_i64(failed)?,
            u64_to_i64(aborted)?,
            u64_to_i64(u64::from(known_usage))?,
            u64_to_i64(u64::from(!known_usage))?,
            u64_to_i64(event.input_tokens.unwrap_or(0))?,
            u64_to_i64(event.output_tokens.unwrap_or(0))?,
            u64_to_i64(event.reasoning_tokens.unwrap_or(0))?,
            u64_to_i64(event.cache_read_tokens.unwrap_or(0))?,
            u64_to_i64(event.cache_write_tokens.unwrap_or(0))?,
            u64_to_i64(event.cost_microusd.unwrap_or(0))?,
            u64_to_i64(u64::from(event.cost_microusd.is_some()))?,
            u64_to_i64(u64::from(event.cost_microusd.is_none()))?,
        ],
    )?;
    Ok(())
}

fn event_from_row(row: &Row<'_>) -> rusqlite::Result<UsageAttemptEvent> {
    Ok(UsageAttemptEvent {
        event_id: row.get(0)?,
        call_id: row.get(1)?,
        attempt_id: row.get(2)?,
        event_kind: enum_from_sql(&row.get::<_, String>(3)?)?,
        user_id: row.get(4)?,
        workspace_id: row.get(5)?,
        thread_id: row.get(6)?,
        turn_id: row.get(7)?,
        run_id: row.get(8)?,
        task_id: row.get(9)?,
        round: optional_u32_from_row(row, 10)?,
        purpose: enum_from_sql(&row.get::<_, String>(11)?)?,
        purpose_detail: row.get(12)?,
        provider_id: row.get(13)?,
        model_id: row.get(14)?,
        locality: enum_from_sql(&row.get::<_, String>(15)?)?,
        input_tokens: optional_u64_from_row(row, 16)?,
        output_tokens: optional_u64_from_row(row, 17)?,
        reasoning_tokens: optional_u64_from_row(row, 18)?,
        cache_read_tokens: optional_u64_from_row(row, 19)?,
        cache_write_tokens: optional_u64_from_row(row, 20)?,
        latency_ms: optional_u64_from_row(row, 21)?,
        time_to_first_token_ms: optional_u64_from_row(row, 22)?,
        outcome: row
            .get::<_, Option<String>>(23)?
            .map(|value| enum_from_sql(&value))
            .transpose()?,
        error_class: row.get(24)?,
        upstream_status: optional_u16_from_row(row, 25)?,
        finish_reason: row.get(26)?,
        rate_limit_limit: optional_u64_from_row(row, 27)?,
        rate_limit_remaining: optional_u64_from_row(row, 28)?,
        rate_limit_reset_at: row.get(29)?,
        cost_microusd: optional_u64_from_row(row, 30)?,
        usage_provenance: enum_from_sql(&row.get::<_, String>(31)?)?,
        cost_provenance: enum_from_sql(&row.get::<_, String>(32)?)?,
        pricing_source: row.get(33)?,
        pricing_version: row.get(34)?,
        started_at: row.get(35)?,
        recorded_at: row.get(36)?,
        schema_version: u32::try_from(row.get::<_, i64>(37)?).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(37, Type::Integer, Box::new(error))
        })?,
    })
}

fn enum_to_sql<T: Serialize>(value: T) -> rusqlite::Result<String> {
    let value = serde_json::to_value(value).map_err(serialization_error)?;
    value
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| invalid_data("usage enum did not serialize as a string"))
}

fn enum_from_sql<T: DeserializeOwned>(value: &str) -> rusqlite::Result<T> {
    serde_json::from_value(serde_json::Value::String(value.to_string()))
        .map_err(serialization_error)
}

fn optional_u64_to_i64(value: Option<u64>) -> rusqlite::Result<Option<i64>> {
    value.map(u64_to_i64).transpose()
}

fn u64_to_i64(value: u64) -> rusqlite::Result<i64> {
    i64::try_from(value).map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))
}

fn optional_u64_from_row(row: &Row<'_>, index: usize) -> rusqlite::Result<Option<u64>> {
    row.get::<_, Option<i64>>(index)?
        .map(|value| {
            u64::try_from(value).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(index, Type::Integer, Box::new(error))
            })
        })
        .transpose()
}

fn optional_u32_from_row(row: &Row<'_>, index: usize) -> rusqlite::Result<Option<u32>> {
    row.get::<_, Option<i64>>(index)?
        .map(|value| {
            u32::try_from(value).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(index, Type::Integer, Box::new(error))
            })
        })
        .transpose()
}

fn optional_u16_from_row(row: &Row<'_>, index: usize) -> rusqlite::Result<Option<u16>> {
    row.get::<_, Option<i64>>(index)?
        .map(|value| {
            u16::try_from(value).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(index, Type::Integer, Box::new(error))
            })
        })
        .transpose()
}

fn nonnegative_u64(value: i64, index: usize) -> rusqlite::Result<u64> {
    u64::try_from(value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(index, Type::Integer, Box::new(error))
    })
}

fn percentage(known: u64, total: u64) -> u8 {
    if total == 0 {
        return 0;
    }
    u8::try_from(known.saturating_mul(100) / total)
        .unwrap_or(100)
        .min(100)
}

fn serialization_error(error: impl std::error::Error + Send + Sync + 'static) -> rusqlite::Error {
    rusqlite::Error::ToSqlConversionFailure(Box::new(error))
}

fn invalid_data(message: &str) -> rusqlite::Error {
    rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(
        std::io::ErrorKind::InvalidData,
        message.to_string(),
    )))
}

struct BufferedUsageSender {
    sender: SyncSender<UsageAttemptEvent>,
    dropped: Arc<AtomicU64>,
}

impl BufferedUsageSender {
    #[cfg(test)]
    fn new(sender: SyncSender<UsageAttemptEvent>) -> Self {
        Self {
            sender,
            dropped: Arc::new(AtomicU64::new(0)),
        }
    }

    fn with_counter(sender: SyncSender<UsageAttemptEvent>, dropped: Arc<AtomicU64>) -> Self {
        Self { sender, dropped }
    }

    fn record(&self, event: UsageAttemptEvent) {
        if matches!(
            self.sender.try_send(event),
            Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_))
        ) {
            self.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }

    #[cfg(test)]
    fn dropped_events(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }
}

pub struct BufferedUsageRecorder {
    sender: Mutex<Option<BufferedUsageSender>>,
    dropped: Arc<AtomicU64>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl BufferedUsageRecorder {
    pub fn start(path: impl AsRef<Path>, capacity: usize) -> rusqlite::Result<Self> {
        let store = UsageStore::open(path)?;
        let (sender, receiver) = sync_channel(capacity.max(1));
        let dropped = Arc::new(AtomicU64::new(0));
        let buffered_sender = BufferedUsageSender::with_counter(sender, Arc::clone(&dropped));
        let worker = std::thread::Builder::new()
            .name("homun-usage-writer".to_string())
            .spawn(move || {
                while let Ok(event) = receiver.recv() {
                    if let Err(error) = store.append(&event) {
                        tracing::warn!(target: "usage::ledger", %error, "usage event append failed");
                    }
                }
            })
            .map_err(|error| rusqlite::Error::ToSqlConversionFailure(Box::new(error)))?;
        Ok(Self {
            sender: Mutex::new(Some(buffered_sender)),
            dropped,
            worker: Mutex::new(Some(worker)),
        })
    }

    pub fn dropped_events(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }

    pub fn shutdown(&self, timeout: Duration) {
        if let Ok(mut sender) = self.sender.lock() {
            sender.take();
        }
        let worker = self.worker.lock().ok().and_then(|mut worker| worker.take());
        let Some(worker) = worker else {
            return;
        };
        let (done_sender, done_receiver) = sync_channel(1);
        std::thread::spawn(move || {
            let _ = worker.join();
            let _ = done_sender.send(());
        });
        let _ = done_receiver.recv_timeout(timeout);
    }
}

impl UsageRecorder for BufferedUsageRecorder {
    fn record(&self, event: UsageAttemptEvent) {
        match self.sender.lock() {
            Ok(sender) => match sender.as_ref() {
                Some(sender) => sender.record(event),
                None => {
                    self.dropped.fetch_add(1, Ordering::Relaxed);
                }
            },
            Err(_) => {
                self.dropped.fetch_add(1, Ordering::Relaxed);
            }
        }
    }
}

impl Drop for BufferedUsageRecorder {
    fn drop(&mut self) {
        if let Ok(sender) = self.sender.get_mut() {
            sender.take();
        }
        if let Ok(worker) = self.worker.get_mut()
            && let Some(worker) = worker.take()
        {
            let _ = worker.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use local_first_inference_usage::{
        AttemptEventKind, InferencePurpose, Locality, NormalizedUsage, UsageAttemptEvent,
        UsageContext, UsageProvenance,
    };
    use std::sync::mpsc::sync_channel;

    fn fixture_start(
        event_id: &str,
        attempt_id: &str,
        user_id: &str,
        workspace_id: &str,
    ) -> UsageAttemptEvent {
        let mut context = UsageContext::new("call-1", InferencePurpose::ChatResponse, user_id);
        context.workspace_id = Some(workspace_id.to_string());
        let mut event = UsageAttemptEvent::started(
            context,
            attempt_id,
            "openrouter",
            "model-a",
            Locality::Cloud,
            100,
        );
        event.event_id = event_id.to_string();
        event
    }

    fn fixture_completed_without_usage() -> UsageAttemptEvent {
        fixture_start("unknown-start", "unknown", "local", "workspace-a")
            .completed(120, NormalizedUsage::default())
    }

    fn completed_fixture(
        attempt_id: &str,
        input_tokens: u64,
        output_tokens: u64,
        recorded_at: i64,
    ) -> UsageAttemptEvent {
        let mut started = fixture_start(
            &format!("{attempt_id}-start"),
            attempt_id,
            "local",
            "workspace-a",
        );
        started.started_at = recorded_at - 10;
        started.recorded_at = recorded_at - 10;
        let mut completed = started.completed(
            recorded_at,
            NormalizedUsage {
                input_tokens: Some(input_tokens),
                output_tokens: Some(output_tokens),
                ..NormalizedUsage::default()
            },
        );
        completed.usage_provenance = UsageProvenance::ProviderReported;
        completed
    }

    #[test]
    fn events_are_append_only_idempotent_and_scope_filtered() {
        let store = UsageStore::open_in_memory().unwrap();
        let start = fixture_start("event-start", "attempt-1", "user-a", "workspace-a");
        assert_eq!(store.append(&start).unwrap(), AppendOutcome::Inserted);
        assert_eq!(store.append(&start).unwrap(), AppendOutcome::Duplicate);
        assert_eq!(
            store
                .events_for_scope("user-a", Some("workspace-a"))
                .unwrap()
                .len(),
            1
        );
        assert!(
            store
                .events_for_scope("user-b", Some("workspace-a"))
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn recovery_appends_abort_without_rewriting_start() {
        let store = UsageStore::open_in_memory().unwrap();
        store
            .append(&fixture_start("start", "orphan", "local", "workspace-a"))
            .unwrap();
        assert_eq!(store.abort_orphaned_attempts(200).unwrap(), 1);
        let events = store.events_for_attempt("orphan").unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].event_kind, AttemptEventKind::AttemptStarted);
        assert_eq!(events[1].event_kind, AttemptEventKind::AttemptAborted);
        assert_eq!(events[1].error_class.as_deref(), Some("process_recovery"));
    }

    #[test]
    fn null_usage_is_not_coerced_to_zero() {
        let store = UsageStore::open_in_memory().unwrap();
        store.append(&fixture_completed_without_usage()).unwrap();
        let summary = store.summary("local", UsageWindow::All, 300).unwrap();
        assert_eq!(summary.known_usage_attempts, 0);
        assert_eq!(summary.unknown_usage_attempts, 1);
    }

    #[test]
    fn empty_summary_is_zero_without_a_fake_coverage_start() {
        let store = UsageStore::open_in_memory().unwrap();
        let summary = store.summary("local", UsageWindow::All, 300).unwrap();
        assert_eq!(summary.logical_calls, 0);
        assert_eq!(summary.attempts, 0);
        assert_eq!(summary.known_usage_attempts, 0);
        assert_eq!(summary.unknown_usage_attempts, 0);
        assert_eq!(summary.usage_coverage_percent, 0);
        assert_eq!(summary.coverage_started_at, None);
    }

    #[test]
    fn daily_rollups_are_rebuildable_from_the_append_only_ledger() {
        let store = UsageStore::open_in_memory().unwrap();
        store
            .append(&completed_fixture("attempt-a", 100, 25, 86_400))
            .unwrap();
        store.rebuild_daily_rollups().unwrap();
        assert_eq!(store.daily_rows().unwrap().len(), 1);
        store.clear_daily_rollups_for_test().unwrap();
        store.rebuild_daily_rollups().unwrap();
        assert_eq!(store.daily_rows().unwrap()[0].input_tokens, 100);
    }

    #[test]
    fn bounded_sender_drops_instead_of_blocking() {
        let (sender, _paused_receiver) = sync_channel(1);
        let sender = BufferedUsageSender::new(sender);
        let event = fixture_start("start", "attempt", "local", "workspace-a");
        sender.record(event.clone());
        sender.record(event);
        assert_eq!(sender.dropped_events(), 1);
    }

    #[test]
    fn buffered_recorder_flushes_before_shutdown_returns() {
        let path = std::env::temp_dir().join(format!(
            "homun-usage-recorder-{}.sqlite",
            uuid::Uuid::new_v4()
        ));
        let recorder = BufferedUsageRecorder::start(&path, 8).unwrap();
        recorder.record(fixture_start(
            "buffered-start",
            "buffered-attempt",
            "local",
            "workspace-a",
        ));
        recorder.shutdown(Duration::from_secs(2));

        let store = UsageStore::open(&path).unwrap();
        assert_eq!(
            store.events_for_attempt("buffered-attempt").unwrap().len(),
            1
        );
        drop(store);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite-shm"));
        let _ = std::fs::remove_file(path.with_extension("sqlite-wal"));
    }
}
