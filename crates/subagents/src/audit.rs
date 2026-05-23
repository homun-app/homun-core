use crate::{AgentId, RiskLevel, SubagentResult, SubagentReview, SubagentStatus};

pub struct AuditStore {
    conn: rusqlite::Connection,
}

impl AuditStore {
    pub fn open_in_memory() -> Result<Self, String> {
        let conn = rusqlite::Connection::open_in_memory().map_err(|error| error.to_string())?;
        let store = Self { conn };
        store.init()?;
        Ok(store)
    }

    pub fn open(path: impl AsRef<std::path::Path>) -> Result<Self, String> {
        let conn = rusqlite::Connection::open(path).map_err(|error| error.to_string())?;
        let store = Self { conn };
        store.init()?;
        Ok(store)
    }

    pub fn record_result(&self, result: &SubagentResult) -> Result<(), String> {
        let output_json =
            serde_json::to_string(&result.output).map_err(|error| error.to_string())?;
        let errors_json =
            serde_json::to_string(&result.errors).map_err(|error| error.to_string())?;
        let metrics_json =
            serde_json::to_string(&result.metrics).map_err(|error| error.to_string())?;
        let audit_json = serde_json::to_string(&result.audit).map_err(|error| error.to_string())?;

        self.conn
            .execute(
                "insert into subagent_results (
                    task_id,
                    agent_id,
                    status,
                    output_json,
                    errors_json,
                    metrics_json,
                    audit_json
                ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                (
                    &result.task_id,
                    agent_id_name(&result.agent_id),
                    status_name(&result.status),
                    output_json,
                    errors_json,
                    metrics_json,
                    audit_json,
                ),
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn record_review(&self, review: &SubagentReview) -> Result<(), String> {
        let findings_json =
            serde_json::to_string(&review.findings).map_err(|error| error.to_string())?;

        self.conn
            .execute(
                "insert into subagent_reviews (
                    task_id,
                    reviewer_agent_id,
                    approved,
                    risk_level,
                    requires_user_approval,
                    findings_json
                ) values (?1, ?2, ?3, ?4, ?5, ?6)",
                (
                    &review.task_id,
                    agent_id_name(&review.reviewer_agent_id),
                    review.approved,
                    risk_level_name(&review.risk_level),
                    review.requires_user_approval,
                    findings_json,
                ),
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn result_count(&self) -> Result<u64, String> {
        self.conn
            .query_row("select count(*) from subagent_results", [], |row| {
                row.get(0)
            })
            .map_err(|error| error.to_string())
    }

    pub fn review_count(&self) -> Result<u64, String> {
        self.conn
            .query_row("select count(*) from subagent_reviews", [], |row| {
                row.get(0)
            })
            .map_err(|error| error.to_string())
    }

    pub fn result_status(&self, task_id: &str) -> Result<Option<String>, String> {
        let mut statement = self
            .conn
            .prepare(
                "select status from subagent_results where task_id = ?1 order by id desc limit 1",
            )
            .map_err(|error| error.to_string())?;
        let mut rows = statement
            .query([task_id])
            .map_err(|error| error.to_string())?;
        match rows.next().map_err(|error| error.to_string())? {
            Some(row) => row.get(0).map(Some).map_err(|error| error.to_string()),
            None => Ok(None),
        }
    }

    pub fn latest_result(&self, task_id: &str) -> Result<Option<SubagentResult>, String> {
        let mut statement = self
            .conn
            .prepare(
                "select task_id, agent_id, status, output_json, errors_json, metrics_json, audit_json
                 from subagent_results
                 where task_id = ?1
                 order by id desc
                 limit 1",
            )
            .map_err(|error| error.to_string())?;
        let mut rows = statement
            .query([task_id])
            .map_err(|error| error.to_string())?;

        match rows.next().map_err(|error| error.to_string())? {
            Some(row) => result_from_audit_row(row).map(Some),
            None => Ok(None),
        }
    }

    pub fn recent_results_by_status(
        &self,
        status: SubagentStatus,
        limit: u32,
    ) -> Result<Vec<SubagentResult>, String> {
        let mut statement = self
            .conn
            .prepare(
                "select task_id, agent_id, status, output_json, errors_json, metrics_json, audit_json
                 from subagent_results
                 where status = ?1
                 order by id desc
                 limit ?2",
            )
            .map_err(|error| error.to_string())?;
        let mut rows = statement
            .query((status_name(&status), i64::from(limit)))
            .map_err(|error| error.to_string())?;
        let mut results = Vec::new();

        while let Some(row) = rows.next().map_err(|error| error.to_string())? {
            results.push(result_from_audit_row(row)?);
        }

        Ok(results)
    }

    pub fn latest_review(&self, task_id: &str) -> Result<Option<SubagentReview>, String> {
        let mut statement = self
            .conn
            .prepare(
                "select task_id, reviewer_agent_id, approved, risk_level, requires_user_approval, findings_json
                 from subagent_reviews
                 where task_id = ?1
                 order by id desc
                 limit 1",
            )
            .map_err(|error| error.to_string())?;
        let mut rows = statement
            .query([task_id])
            .map_err(|error| error.to_string())?;

        match rows.next().map_err(|error| error.to_string())? {
            Some(row) => review_from_audit_row(row).map(Some),
            None => Ok(None),
        }
    }

    fn init(&self) -> Result<(), String> {
        self.conn
            .execute_batch(
                "create table if not exists subagent_results (
                    id integer primary key autoincrement,
                    task_id text not null,
                    agent_id text not null,
                    status text not null,
                    output_json text not null,
                    errors_json text not null,
                    metrics_json text not null,
                    audit_json text not null,
                    created_at text not null default current_timestamp
                );
                create index if not exists idx_subagent_results_task_id
                    on subagent_results(task_id);

                create table if not exists subagent_reviews (
                    id integer primary key autoincrement,
                    task_id text not null,
                    reviewer_agent_id text not null,
                    approved integer not null,
                    risk_level text not null,
                    requires_user_approval integer not null,
                    findings_json text not null,
                    created_at text not null default current_timestamp
                );
                create index if not exists idx_subagent_reviews_task_id
                    on subagent_reviews(task_id);",
            )
            .map_err(|error| error.to_string())
    }
}

fn agent_id_name(agent_id: &AgentId) -> &'static str {
    match agent_id {
        AgentId::Planner => "PlannerAgent",
        AgentId::Memory => "MemoryAgent",
        AgentId::Tool => "ToolAgent",
        AgentId::Vision => "VisionAgent",
        AgentId::Risk => "RiskAgent",
        AgentId::Automation => "AutomationAgent",
        AgentId::Review => "ReviewAgent",
    }
}

fn status_name(status: &SubagentStatus) -> &'static str {
    match status {
        SubagentStatus::Succeeded => "succeeded",
        SubagentStatus::Failed => "failed",
        SubagentStatus::Cancelled => "cancelled",
        SubagentStatus::TimedOut => "timed_out",
    }
}

fn risk_level_name(risk_level: &RiskLevel) -> &'static str {
    match risk_level {
        RiskLevel::Low => "low",
        RiskLevel::Medium => "medium",
        RiskLevel::High => "high",
        RiskLevel::Critical => "critical",
    }
}

fn result_from_audit_row(row: &rusqlite::Row<'_>) -> Result<SubagentResult, String> {
    let task_id: String = row.get(0).map_err(|error| error.to_string())?;
    let agent_id: String = row.get(1).map_err(|error| error.to_string())?;
    let status: String = row.get(2).map_err(|error| error.to_string())?;
    let output_json: String = row.get(3).map_err(|error| error.to_string())?;
    let errors_json: String = row.get(4).map_err(|error| error.to_string())?;
    let metrics_json: String = row.get(5).map_err(|error| error.to_string())?;
    let audit_json: String = row.get(6).map_err(|error| error.to_string())?;

    Ok(SubagentResult {
        task_id,
        agent_id: agent_id_from_name(&agent_id)?,
        status: status_from_name(&status)?,
        output: serde_json::from_str(&output_json).map_err(|error| error.to_string())?,
        errors: serde_json::from_str(&errors_json).map_err(|error| error.to_string())?,
        metrics: serde_json::from_str(&metrics_json).map_err(|error| error.to_string())?,
        audit: serde_json::from_str(&audit_json).map_err(|error| error.to_string())?,
    })
}

fn review_from_audit_row(row: &rusqlite::Row<'_>) -> Result<SubagentReview, String> {
    let task_id: String = row.get(0).map_err(|error| error.to_string())?;
    let reviewer_agent_id: String = row.get(1).map_err(|error| error.to_string())?;
    let approved: bool = row.get(2).map_err(|error| error.to_string())?;
    let risk_level: String = row.get(3).map_err(|error| error.to_string())?;
    let requires_user_approval: bool = row.get(4).map_err(|error| error.to_string())?;
    let findings_json: String = row.get(5).map_err(|error| error.to_string())?;

    Ok(SubagentReview {
        task_id,
        reviewer_agent_id: agent_id_from_name(&reviewer_agent_id)?,
        approved,
        risk_level: risk_level_from_name(&risk_level)?,
        requires_user_approval,
        findings: serde_json::from_str(&findings_json).map_err(|error| error.to_string())?,
    })
}

fn agent_id_from_name(agent_id: &str) -> Result<AgentId, String> {
    match agent_id {
        "PlannerAgent" => Ok(AgentId::Planner),
        "MemoryAgent" => Ok(AgentId::Memory),
        "ToolAgent" => Ok(AgentId::Tool),
        "VisionAgent" => Ok(AgentId::Vision),
        "RiskAgent" => Ok(AgentId::Risk),
        "AutomationAgent" => Ok(AgentId::Automation),
        "ReviewAgent" => Ok(AgentId::Review),
        _ => Err(format!("unknown agent id {agent_id}")),
    }
}

fn status_from_name(status: &str) -> Result<SubagentStatus, String> {
    match status {
        "succeeded" => Ok(SubagentStatus::Succeeded),
        "failed" => Ok(SubagentStatus::Failed),
        "cancelled" => Ok(SubagentStatus::Cancelled),
        "timed_out" => Ok(SubagentStatus::TimedOut),
        _ => Err(format!("unknown subagent status {status}")),
    }
}

fn risk_level_from_name(risk_level: &str) -> Result<RiskLevel, String> {
    match risk_level {
        "low" => Ok(RiskLevel::Low),
        "medium" => Ok(RiskLevel::Medium),
        "high" => Ok(RiskLevel::High),
        "critical" => Ok(RiskLevel::Critical),
        _ => Err(format!("unknown risk level {risk_level}")),
    }
}
