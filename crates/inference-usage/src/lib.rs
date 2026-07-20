pub const USAGE_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InferencePurpose {
    ChatResponse,
    TitleGeneration,
    IntentRouting,
    Planning,
    MemoryExtraction,
    MemoryRecall,
    MemoryCompaction,
    Embedding,
    Subagent,
    Automation,
    ArtifactGeneration,
    VisionAnalysis,
    Evaluation,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Locality {
    Local,
    Cloud,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct UsageContext {
    pub call_id: String,
    pub purpose: InferencePurpose,
    pub purpose_detail: Option<String>,
    pub user_id: String,
    pub workspace_id: Option<String>,
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
    pub run_id: Option<String>,
    pub task_id: Option<String>,
    pub round: Option<u32>,
}

impl UsageContext {
    pub fn new(
        call_id: impl Into<String>,
        purpose: InferencePurpose,
        user_id: impl Into<String>,
    ) -> Self {
        Self {
            call_id: call_id.into(),
            purpose,
            purpose_detail: None,
            user_id: user_id.into(),
            workspace_id: None,
            thread_id: None,
            turn_id: None,
            run_id: None,
            task_id: None,
            round: None,
        }
    }
}

impl Default for UsageContext {
    fn default() -> Self {
        Self::new("unattributed", InferencePurpose::Other, "local")
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct NormalizedUsage {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub reasoning_tokens: Option<u64>,
    pub cache_read_tokens: Option<u64>,
    pub cache_write_tokens: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttemptEventKind {
    AttemptStarted,
    AttemptCompleted,
    AttemptFailed,
    AttemptAborted,
}

impl AttemptEventKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::AttemptStarted => "attempt_started",
            Self::AttemptCompleted => "attempt_completed",
            Self::AttemptFailed => "attempt_failed",
            Self::AttemptAborted => "attempt_aborted",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UsageProvenance {
    ProviderReported,
    HomunEstimated,
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CostProvenance {
    ProviderReported,
    CatalogEstimated,
    ManualEstimated,
    NotBilled,
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttemptOutcome {
    Success,
    Failed,
    Aborted,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct UsageAttemptEvent {
    pub event_id: String,
    pub call_id: String,
    pub attempt_id: String,
    pub event_kind: AttemptEventKind,
    pub user_id: String,
    pub workspace_id: Option<String>,
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
    pub run_id: Option<String>,
    pub task_id: Option<String>,
    pub round: Option<u32>,
    pub purpose: InferencePurpose,
    pub purpose_detail: Option<String>,
    pub provider_id: Option<String>,
    pub model_id: Option<String>,
    pub locality: Locality,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub reasoning_tokens: Option<u64>,
    pub cache_read_tokens: Option<u64>,
    pub cache_write_tokens: Option<u64>,
    pub latency_ms: Option<u64>,
    pub time_to_first_token_ms: Option<u64>,
    pub outcome: Option<AttemptOutcome>,
    pub error_class: Option<String>,
    pub upstream_status: Option<u16>,
    pub finish_reason: Option<String>,
    pub rate_limit_limit: Option<u64>,
    pub rate_limit_remaining: Option<u64>,
    pub rate_limit_reset_at: Option<i64>,
    pub cost_microusd: Option<u64>,
    pub usage_provenance: UsageProvenance,
    pub cost_provenance: CostProvenance,
    pub pricing_source: Option<String>,
    pub pricing_version: Option<String>,
    pub started_at: i64,
    pub recorded_at: i64,
    pub schema_version: u32,
}

impl UsageAttemptEvent {
    pub fn started(
        context: UsageContext,
        attempt_id: impl Into<String>,
        provider_id: impl Into<String>,
        model_id: impl Into<String>,
        locality: Locality,
        recorded_at: i64,
    ) -> Self {
        let attempt_id = attempt_id.into();
        Self {
            event_id: event_id(&attempt_id, AttemptEventKind::AttemptStarted),
            call_id: context.call_id,
            attempt_id,
            event_kind: AttemptEventKind::AttemptStarted,
            user_id: context.user_id,
            workspace_id: context.workspace_id,
            thread_id: context.thread_id,
            turn_id: context.turn_id,
            run_id: context.run_id,
            task_id: context.task_id,
            round: context.round,
            purpose: context.purpose,
            purpose_detail: context.purpose_detail,
            provider_id: Some(provider_id.into()),
            model_id: Some(model_id.into()),
            locality,
            input_tokens: None,
            output_tokens: None,
            reasoning_tokens: None,
            cache_read_tokens: None,
            cache_write_tokens: None,
            latency_ms: None,
            time_to_first_token_ms: None,
            outcome: None,
            error_class: None,
            upstream_status: None,
            finish_reason: None,
            rate_limit_limit: None,
            rate_limit_remaining: None,
            rate_limit_reset_at: None,
            cost_microusd: None,
            usage_provenance: UsageProvenance::Unavailable,
            cost_provenance: CostProvenance::Unavailable,
            pricing_source: None,
            pricing_version: None,
            started_at: recorded_at,
            recorded_at,
            schema_version: USAGE_SCHEMA_VERSION,
        }
    }

    pub fn completed(&self, recorded_at: i64, usage: NormalizedUsage) -> Self {
        let mut terminal = self.terminal(AttemptEventKind::AttemptCompleted, recorded_at);
        terminal.input_tokens = usage.input_tokens;
        terminal.output_tokens = usage.output_tokens;
        terminal.reasoning_tokens = usage.reasoning_tokens;
        terminal.cache_read_tokens = usage.cache_read_tokens;
        terminal.cache_write_tokens = usage.cache_write_tokens;
        terminal.outcome = Some(AttemptOutcome::Success);
        terminal
    }

    pub fn failed(
        &self,
        recorded_at: i64,
        error_class: impl Into<String>,
        upstream_status: Option<u16>,
    ) -> Self {
        let mut terminal = self.terminal(AttemptEventKind::AttemptFailed, recorded_at);
        terminal.outcome = Some(AttemptOutcome::Failed);
        terminal.error_class = Some(error_class.into());
        terminal.upstream_status = upstream_status;
        terminal
    }

    pub fn aborted(&self, recorded_at: i64, error_class: impl Into<String>) -> Self {
        let mut terminal = self.terminal(AttemptEventKind::AttemptAborted, recorded_at);
        terminal.outcome = Some(AttemptOutcome::Aborted);
        terminal.error_class = Some(error_class.into());
        terminal
    }

    fn terminal(&self, event_kind: AttemptEventKind, recorded_at: i64) -> Self {
        let mut terminal = self.clone();
        terminal.event_id = event_id(&self.attempt_id, event_kind);
        terminal.event_kind = event_kind;
        terminal.recorded_at = recorded_at;
        terminal
    }
}

fn event_id(attempt_id: &str, event_kind: AttemptEventKind) -> String {
    format!("{attempt_id}:{}", event_kind.as_str())
}

pub trait UsageRecorder: Send + Sync {
    fn record(&self, event: UsageAttemptEvent);
}

#[derive(Default)]
pub struct NoopUsageRecorder;

impl UsageRecorder for NoopUsageRecorder {
    fn record(&self, _event: UsageAttemptEvent) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn purpose_round_trips_without_prompt_inference() {
        let encoded = serde_json::to_string(&InferencePurpose::MemoryExtraction).unwrap();
        assert_eq!(encoded, "\"memory_extraction\"");
    }

    #[test]
    fn attempt_event_contains_no_content_fields() {
        let event = UsageAttemptEvent::started(
            UsageContext::new("call-1", InferencePurpose::ChatResponse, "local"),
            "attempt-1",
            "openrouter",
            "model-a",
            Locality::Cloud,
            100,
        );
        let value = serde_json::to_value(event).unwrap();
        assert!(value.get("prompt").is_none());
        assert!(value.get("response").is_none());
        assert!(value.get("api_key").is_none());
    }

    #[test]
    fn terminal_events_preserve_identity_and_describe_the_outcome() {
        let started = UsageAttemptEvent::started(
            UsageContext::new("call-1", InferencePurpose::ChatResponse, "local"),
            "attempt-1",
            "openrouter",
            "model-a",
            Locality::Cloud,
            100,
        );
        assert_eq!(started.event_id, "attempt-1:attempt_started");

        let completed = started.completed(
            125,
            NormalizedUsage {
                input_tokens: Some(10),
                output_tokens: Some(4),
                ..NormalizedUsage::default()
            },
        );
        assert_eq!(completed.call_id, started.call_id);
        assert_eq!(completed.event_kind, AttemptEventKind::AttemptCompleted);
        assert_eq!(completed.outcome, Some(AttemptOutcome::Success));
        assert_eq!(completed.input_tokens, Some(10));
        assert_eq!(completed.recorded_at, 125);

        let failed = started.failed(130, "http_status", Some(429));
        assert_eq!(failed.event_kind, AttemptEventKind::AttemptFailed);
        assert_eq!(failed.outcome, Some(AttemptOutcome::Failed));
        assert_eq!(failed.error_class.as_deref(), Some("http_status"));
        assert_eq!(failed.upstream_status, Some(429));

        let aborted = started.aborted(140, "process_recovery");
        assert_eq!(aborted.event_kind, AttemptEventKind::AttemptAborted);
        assert_eq!(aborted.outcome, Some(AttemptOutcome::Aborted));
        assert_eq!(aborted.error_class.as_deref(), Some("process_recovery"));
    }

    #[test]
    fn noop_recorder_accepts_metadata_events() {
        let recorder = NoopUsageRecorder;
        recorder.record(UsageAttemptEvent::started(
            UsageContext::new("call-1", InferencePurpose::Evaluation, "local"),
            "attempt-1",
            "ollama",
            "model-a",
            Locality::Local,
            100,
        ));
    }
}
