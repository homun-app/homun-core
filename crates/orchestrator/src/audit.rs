use crate::{
    DirectAnswer, ExecutionPlan, OrchestratorError, OrchestratorOutcome, OrchestratorRequest,
    OrchestratorResult, ToolCard,
    ui::{
        OrchestratorRunDetail, OrchestratorRunSummary, UiDirectAnswerSummary, UiEnqueuedTask,
        UiExecutionPlan, UiImmediateResult, UiPlanStep, UiSubagentTask, UiToolCard, route_label,
    },
};
use local_first_capabilities::CapabilityCallResult;
use local_first_subagents::TokenMetrics;
use local_first_task_runtime::{UserId, WorkspaceId};
use rusqlite::{Connection, OptionalExtension, params};
use std::path::Path;
use time::OffsetDateTime;

pub struct OrchestratorAuditStore {
    connection: Connection,
}

impl OrchestratorAuditStore {
    pub fn open(path: impl AsRef<Path>) -> OrchestratorResult<Self> {
        let store = Self {
            connection: Connection::open(path)?,
        };
        store.run_migrations()?;
        Ok(store)
    }

    pub fn open_in_memory() -> OrchestratorResult<Self> {
        let store = Self {
            connection: Connection::open_in_memory()?,
        };
        store.run_migrations()?;
        Ok(store)
    }

    pub fn run_migrations(&self) -> OrchestratorResult<()> {
        self.connection.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS orchestrator_runs (
                request_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                workspace_id TEXT NOT NULL,
                route TEXT NOT NULL,
                status TEXT NOT NULL,
                planner_rounds INTEGER NOT NULL,
                loaded_tool_count INTEGER NOT NULL,
                immediate_execution_count INTEGER NOT NULL,
                enqueued_task_count INTEGER NOT NULL,
                subagent_task_count INTEGER NOT NULL,
                blocked_reason TEXT,
                plan_json TEXT NOT NULL,
                loaded_tools_json TEXT NOT NULL,
                memory_refs_json TEXT NOT NULL,
                immediate_results_json TEXT NOT NULL,
                enqueued_tasks_json TEXT NOT NULL,
                subagent_tasks_json TEXT NOT NULL,
                metrics_json TEXT NOT NULL,
                error_message TEXT,
                created_at INTEGER NOT NULL,
                finished_at INTEGER,
                PRIMARY KEY (request_id, user_id, workspace_id)
            );

            CREATE INDEX IF NOT EXISTS idx_orchestrator_runs_scope
                ON orchestrator_runs(user_id, workspace_id, created_at);
            ",
        )?;
        Ok(())
    }

    pub fn record_outcome(
        &self,
        request: &OrchestratorRequest,
        outcome: &OrchestratorOutcome,
    ) -> OrchestratorResult<()> {
        let now = OffsetDateTime::now_utc().unix_timestamp();
        let plan = ui_plan(&outcome.plan);
        let loaded_tools = outcome
            .loaded_tools
            .iter()
            .map(ui_tool_card)
            .collect::<Vec<_>>();
        let immediate_results = outcome
            .immediate_results
            .iter()
            .map(ui_immediate_result)
            .collect::<Vec<_>>();
        let enqueued_tasks = outcome
            .enqueued_tasks
            .iter()
            .map(|task| UiEnqueuedTask {
                step_id: task.step_id.clone(),
                task_id: task.task_id.clone(),
                provider_id: task.provider_id.clone(),
                tool_name: task.tool_name.clone(),
            })
            .collect::<Vec<_>>();
        let subagent_tasks = outcome
            .enqueued_subagent_tasks
            .iter()
            .map(|task| UiSubagentTask {
                step_id: task.step_id.clone(),
                task_id: task.task_id.clone(),
                agent_id: task.agent_id.clone(),
                contract: task.contract.clone(),
            })
            .collect::<Vec<_>>();
        self.insert_run(
            request,
            route_label(outcome.plan.route),
            if outcome.blocked_reason.is_some() {
                "blocked"
            } else {
                "succeeded"
            },
            outcome.audit.planner_rounds,
            outcome.audit.loaded_tool_count,
            outcome.audit.immediate_execution_count,
            outcome.audit.enqueued_task_count,
            outcome.audit.subagent_task_count,
            outcome.blocked_reason.as_deref(),
            &plan,
            &loaded_tools,
            &outcome.memory_refs,
            &immediate_results,
            &enqueued_tasks,
            &subagent_tasks,
            &outcome.metrics,
            None,
            now,
            Some(now),
        )
    }

    pub fn record_failure(
        &self,
        request: &OrchestratorRequest,
        error: &OrchestratorError,
    ) -> OrchestratorResult<()> {
        let now = OffsetDateTime::now_utc().unix_timestamp();
        self.insert_run(
            request,
            "failed",
            "failed",
            0,
            0,
            0,
            0,
            0,
            None,
            &UiExecutionPlan {
                route: "failed".to_string(),
                direct_answer: None,
                steps: Vec::new(),
                needs_more_tools_query: None,
            },
            &Vec::<UiToolCard>::new(),
            &Vec::<String>::new(),
            &Vec::<UiImmediateResult>::new(),
            &Vec::<UiEnqueuedTask>::new(),
            &Vec::<UiSubagentTask>::new(),
            &TokenMetrics::zero(),
            Some(&safe_error_message(error, request)),
            now,
            Some(now),
        )
    }

    pub fn run_detail(
        &self,
        request_id: &str,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> OrchestratorResult<Option<OrchestratorRunDetail>> {
        self.connection
            .query_row(
                "
                SELECT
                    request_id,
                    user_id,
                    workspace_id,
                    route,
                    status,
                    planner_rounds,
                    loaded_tool_count,
                    immediate_execution_count,
                    enqueued_task_count,
                    subagent_task_count,
                    blocked_reason,
                    plan_json,
                    loaded_tools_json,
                    memory_refs_json,
                    immediate_results_json,
                    enqueued_tasks_json,
                    subagent_tasks_json,
                    metrics_json,
                    error_message,
                    created_at,
                    finished_at
                FROM orchestrator_runs
                WHERE request_id = ?1 AND user_id = ?2 AND workspace_id = ?3
                ",
                params![request_id, user_id.as_str(), workspace_id.as_str()],
                run_detail_from_row,
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn recent_runs(
        &self,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
        limit: u32,
    ) -> OrchestratorResult<Vec<OrchestratorRunSummary>> {
        let mut statement = self.connection.prepare(
            "
            SELECT
                request_id,
                user_id,
                workspace_id,
                route,
                status,
                planner_rounds,
                loaded_tool_count,
                immediate_execution_count,
                enqueued_task_count,
                subagent_task_count,
                blocked_reason,
                created_at,
                finished_at
            FROM orchestrator_runs
            WHERE user_id = ?1 AND workspace_id = ?2
            ORDER BY created_at DESC, request_id ASC
            LIMIT ?3
            ",
        )?;
        let rows = statement.query_map(
            params![user_id.as_str(), workspace_id.as_str(), i64::from(limit)],
            run_summary_from_row,
        )?;
        let mut summaries = Vec::new();
        for row in rows {
            summaries.push(row?);
        }
        Ok(summaries)
    }

    #[allow(clippy::too_many_arguments)]
    fn insert_run(
        &self,
        request: &OrchestratorRequest,
        route: &str,
        status: &str,
        planner_rounds: usize,
        loaded_tool_count: usize,
        immediate_execution_count: usize,
        enqueued_task_count: usize,
        subagent_task_count: usize,
        blocked_reason: Option<&str>,
        plan: &UiExecutionPlan,
        loaded_tools: &[UiToolCard],
        memory_refs: &[String],
        immediate_results: &[UiImmediateResult],
        enqueued_tasks: &[UiEnqueuedTask],
        subagent_tasks: &[UiSubagentTask],
        metrics: &TokenMetrics,
        error_message: Option<&str>,
        created_at: i64,
        finished_at: Option<i64>,
    ) -> OrchestratorResult<()> {
        self.connection.execute(
            "
            INSERT INTO orchestrator_runs (
                request_id,
                user_id,
                workspace_id,
                route,
                status,
                planner_rounds,
                loaded_tool_count,
                immediate_execution_count,
                enqueued_task_count,
                subagent_task_count,
                blocked_reason,
                plan_json,
                loaded_tools_json,
                memory_refs_json,
                immediate_results_json,
                enqueued_tasks_json,
                subagent_tasks_json,
                metrics_json,
                error_message,
                created_at,
                finished_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)
            ON CONFLICT(request_id, user_id, workspace_id) DO UPDATE SET
                route = excluded.route,
                status = excluded.status,
                planner_rounds = excluded.planner_rounds,
                loaded_tool_count = excluded.loaded_tool_count,
                immediate_execution_count = excluded.immediate_execution_count,
                enqueued_task_count = excluded.enqueued_task_count,
                subagent_task_count = excluded.subagent_task_count,
                blocked_reason = excluded.blocked_reason,
                plan_json = excluded.plan_json,
                loaded_tools_json = excluded.loaded_tools_json,
                memory_refs_json = excluded.memory_refs_json,
                immediate_results_json = excluded.immediate_results_json,
                enqueued_tasks_json = excluded.enqueued_tasks_json,
                subagent_tasks_json = excluded.subagent_tasks_json,
                metrics_json = excluded.metrics_json,
                error_message = excluded.error_message,
                finished_at = excluded.finished_at
            ",
            params![
                request.request_id,
                request.policy_context.user_id.as_str(),
                request.policy_context.workspace_id.as_str(),
                route,
                status,
                planner_rounds,
                loaded_tool_count,
                immediate_execution_count,
                enqueued_task_count,
                subagent_task_count,
                blocked_reason,
                serde_json::to_string(plan)?,
                serde_json::to_string(loaded_tools)?,
                serde_json::to_string(memory_refs)?,
                serde_json::to_string(immediate_results)?,
                serde_json::to_string(enqueued_tasks)?,
                serde_json::to_string(subagent_tasks)?,
                serde_json::to_string(metrics)?,
                error_message,
                created_at,
                finished_at,
            ],
        )?;
        Ok(())
    }
}

fn ui_plan(plan: &ExecutionPlan) -> UiExecutionPlan {
    UiExecutionPlan {
        route: route_label(plan.route).to_string(),
        direct_answer: plan.direct_answer.as_ref().map(ui_direct_answer),
        steps: plan
            .steps
            .iter()
            .map(|step| UiPlanStep {
                step_id: step.step_id.clone(),
                kind: serde_json::to_value(step.kind)
                    .ok()
                    .and_then(|value| value.as_str().map(str::to_string))
                    .unwrap_or_else(|| "unknown".to_string()),
                depends_on: step.depends_on.clone(),
                provider_id: step.provider_id.clone(),
                tool_name: step.tool_name.clone(),
                agent_id: step.agent_id.clone(),
                contract: step.contract.clone(),
                execution_policy: step.execution_policy,
                risk_level: step.risk_level.clone(),
                expected_duration_seconds: step.expected_duration_seconds,
                argument_keys: argument_keys(&step.arguments),
                has_goal: step.goal.is_some(),
            })
            .collect(),
        needs_more_tools_query: plan
            .needs_more_tools
            .as_ref()
            .map(|request| request.query.clone()),
    }
}

fn ui_direct_answer(answer: &DirectAnswer) -> UiDirectAnswerSummary {
    UiDirectAnswerSummary {
        answer_present: !answer.answer.is_empty(),
        confidence: answer.confidence,
    }
}

fn ui_tool_card(card: &ToolCard) -> UiToolCard {
    UiToolCard {
        provider_id: card.provider_id.clone(),
        provider_kind: card.provider_kind,
        tool_name: card.tool_name.clone(),
        action: card.action,
        description: card.description.clone(),
        privacy_domains: card.privacy_domains.clone(),
        sensitivity: card.sensitivity.clone(),
        schema_hash: card.schema_hash.clone(),
    }
}

fn ui_immediate_result(result: &CapabilityCallResult) -> UiImmediateResult {
    UiImmediateResult {
        provider_id: result.provider_id.clone(),
        tool_name: result.tool_name.clone(),
        output_keys: argument_keys(&result.output),
    }
}

fn argument_keys(value: &serde_json::Value) -> Vec<String> {
    let mut keys = value
        .as_object()
        .map(|object| object.keys().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    keys.sort();
    keys
}

fn safe_error_message(error: &OrchestratorError, request: &OrchestratorRequest) -> String {
    let mut message = error
        .to_string()
        .replace(&request.user_message, "[redacted_request]");
    if message.len() > 500 {
        message.truncate(500);
    }
    message
}

fn run_detail_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<OrchestratorRunDetail> {
    let summary = OrchestratorRunSummary {
        request_id: row.get(0)?,
        user_id: row.get(1)?,
        workspace_id: row.get(2)?,
        route: row.get(3)?,
        status: row.get(4)?,
        planner_rounds: row.get(5)?,
        loaded_tool_count: row.get(6)?,
        immediate_execution_count: row.get(7)?,
        enqueued_task_count: row.get(8)?,
        subagent_task_count: row.get(9)?,
        blocked_reason: row.get(10)?,
        created_at_unix: row.get(19)?,
        finished_at_unix: row.get(20)?,
    };
    let plan_json: String = row.get(11)?;
    let loaded_tools_json: String = row.get(12)?;
    let memory_refs_json: String = row.get(13)?;
    let immediate_results_json: String = row.get(14)?;
    let enqueued_tasks_json: String = row.get(15)?;
    let subagent_tasks_json: String = row.get(16)?;
    let metrics_json: String = row.get(17)?;
    Ok(OrchestratorRunDetail {
        summary,
        plan: serde_json::from_str(&plan_json).map_err(json_error)?,
        loaded_tools: serde_json::from_str(&loaded_tools_json).map_err(json_error)?,
        memory_refs: serde_json::from_str(&memory_refs_json).map_err(json_error)?,
        immediate_results: serde_json::from_str(&immediate_results_json).map_err(json_error)?,
        enqueued_tasks: serde_json::from_str(&enqueued_tasks_json).map_err(json_error)?,
        subagent_tasks: serde_json::from_str(&subagent_tasks_json).map_err(json_error)?,
        metrics: serde_json::from_str(&metrics_json).map_err(json_error)?,
        error_message: row.get(18)?,
        exposes_raw_input: false,
    })
}

fn run_summary_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<OrchestratorRunSummary> {
    Ok(OrchestratorRunSummary {
        request_id: row.get(0)?,
        user_id: row.get(1)?,
        workspace_id: row.get(2)?,
        route: row.get(3)?,
        status: row.get(4)?,
        planner_rounds: row.get(5)?,
        loaded_tool_count: row.get(6)?,
        immediate_execution_count: row.get(7)?,
        enqueued_task_count: row.get(8)?,
        subagent_task_count: row.get(9)?,
        blocked_reason: row.get(10)?,
        created_at_unix: row.get(11)?,
        finished_at_unix: row.get(12)?,
    })
}

fn json_error(error: serde_json::Error) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
}
