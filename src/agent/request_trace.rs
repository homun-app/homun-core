//! Request trace — captures the full execution trace of a single agent request.
//!
//! Each completed request writes a JSON file to `~/.homun/traces/`.
//! Files are trimmed to `traces_max_files` (default 50) after each write.

use std::fs;
use std::path::PathBuf;
use std::time::Instant;

use serde::{Deserialize, Serialize};

use crate::agent::cognition::CognitionResult;
use crate::utils::text::truncate_str;

const DEFAULT_MAX_FILES: usize = 50;
const ARGS_SUMMARY_MAX: usize = 400;
const RESULT_SUMMARY_MAX: usize = 500;
const RESPONSE_SUMMARY_MAX: usize = 500;

/// Full execution trace for a single agent request.
#[derive(Debug, Serialize, Deserialize)]
pub struct RequestTrace {
    /// Unique short trace ID.
    pub id: String,
    /// RFC 3339 timestamp when the request started.
    pub started_at: String,
    /// Channel that originated the request (web, telegram, cli, etc.).
    pub channel: String,
    /// Session key for this request.
    pub session_key: String,
    /// Original user message.
    pub request: String,
    /// LLM model used for the cognition phase (if run).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cognition_model: Option<String>,
    /// LLM model used for the main execution loop.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution_model: Option<String>,
    /// Cognition phase output — None if cognition was skipped or failed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cognition: Option<TraceCognition>,
    /// Each tool call made during execution.
    pub steps: Vec<TraceStep>,
    /// First 500 chars of the final response.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub final_response: Option<String>,
    /// Total agent loop iterations executed.
    pub total_iterations: u32,
    /// Total LLM tokens used across all calls.
    pub total_tokens: u32,
    /// Wall-clock duration in milliseconds.
    pub duration_ms: u64,
    /// How the request ended.
    pub status: TraceStatus,
    /// Why the execution stopped (budget exhausted, model finished, user cancelled, etc.).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<String>,
    /// Final iteration budget (may differ from max_iterations if contracted).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub final_budget: Option<u32>,
}

/// Summary of the cognition phase output.
#[derive(Debug, Serialize, Deserialize)]
pub struct TraceCognition {
    pub intent_type: Option<String>,
    pub success_criteria: Option<String>,
    pub understanding: String,
    pub plan: Vec<String>,
    pub constraints: Vec<String>,
    /// Tool names discovered during cognition.
    pub discovered_tools: Vec<String>,
    /// True if cognition decided to answer directly without running the execution loop.
    pub answer_directly: bool,
    /// True when cognition failed and the full tool set fallback was used.
    #[serde(default)]
    pub is_fallback: bool,
    /// Why the cognition fell back (e.g. "provider error: ...", "timeout after 15s").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fallback_reason: Option<String>,
    /// Discovery tool calls made during the cognition mini-loop.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub discovery_steps: Vec<CognitionStep>,
}

/// A single tool call within the cognition mini-loop.
#[derive(Debug, Serialize, Deserialize)]
pub struct CognitionStep {
    pub iteration: u32,
    pub tool: String,
    /// Short summary of args (query text, etc.)
    pub args_summary: String,
    /// Short summary of result.
    pub result_summary: String,
}

/// A single tool call executed within the agent loop.
#[derive(Debug, Serialize, Deserialize)]
pub struct TraceStep {
    /// Agent loop iteration this call happened in.
    pub iteration: u32,
    /// Tool name.
    pub tool: String,
    /// First 400 chars of JSON-serialized arguments.
    pub args_summary: String,
    /// First 300 chars of the tool result.
    pub result_summary: String,
    /// True if the tool returned an error.
    pub is_error: bool,
    /// Guard decision for browser actions (allow/blocked/give_up).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub guard_decision: Option<String>,
    /// Browser stuck level at time of execution (0=ok, 1-3=escalating).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browser_stuck_level: Option<u8>,
    /// Visual check description (from auto-screenshot after action).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visual_check: Option<String>,
    /// Active iteration budget at this point.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub iteration_budget: Option<u32>,
}

/// How the request ended.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TraceStatus {
    Completed,
    Cancelled,
}

/// Accumulates trace data during a single request execution, then writes to disk.
pub struct RequestTracer {
    trace: RequestTrace,
    started_at: Instant,
}

impl RequestTracer {
    /// Create a new tracer at request start.
    ///
    /// OBS-2: if a trace ID has already been set on the task-local by the
    /// HTTP middleware or a non-HTTP channel dispatcher, reuse it so that
    /// `RequestTrace.id` == `X-Request-ID` response header == `trace_id`
    /// in all log records — one identifier from request entry to trace file.
    /// Falls back to a fresh ID when called outside a scoped context (e.g.
    /// background cron, autonomous subagent, gateway boot).
    pub fn new(channel: &str, session_key: &str, request: &str) -> Self {
        let id = crate::logs::current_trace_id().unwrap_or_else(crate::logs::new_trace_id);
        let trace = RequestTrace {
            id,
            started_at: chrono::Utc::now().to_rfc3339(),
            channel: channel.to_string(),
            session_key: session_key.to_string(),
            request: request.to_string(),
            cognition_model: None,
            execution_model: None,
            cognition: None,
            steps: Vec::new(),
            final_response: None,
            total_iterations: 0,
            total_tokens: 0,
            duration_ms: 0,
            status: TraceStatus::Completed,
            stop_reason: None,
            final_budget: None,
        };
        Self {
            trace,
            started_at: Instant::now(),
        }
    }

    /// Record the LLM models used for cognition and execution phases.
    pub fn record_models(&mut self, cognition_model: &str, execution_model: &str) {
        self.trace.cognition_model = Some(cognition_model.to_string());
        self.trace.execution_model = Some(execution_model.to_string());
    }

    /// Mark the cognition phase as a fallback (all tools loaded).
    pub fn record_cognition_fallback(&mut self, reason: &str) {
        if let Some(ref mut c) = self.trace.cognition {
            c.is_fallback = true;
            c.fallback_reason = Some(reason.to_string());
        }
    }

    /// Record a cognition discovery step (tool call within the mini-loop).
    pub fn record_cognition_step(
        &mut self,
        iteration: u32,
        tool: &str,
        args_summary: &str,
        result_summary: &str,
    ) {
        // Ensure cognition struct exists (create a stub if needed)
        if self.trace.cognition.is_none() {
            self.trace.cognition = Some(TraceCognition {
                intent_type: None,
                success_criteria: None,
                understanding: String::new(),
                plan: Vec::new(),
                constraints: Vec::new(),
                discovered_tools: Vec::new(),
                answer_directly: false,
                is_fallback: false,
                fallback_reason: None,
                discovery_steps: Vec::new(),
            });
        }
        if let Some(ref mut c) = self.trace.cognition {
            c.discovery_steps.push(CognitionStep {
                iteration,
                tool: tool.to_string(),
                args_summary: truncate_str(args_summary, 200, "…"),
                result_summary: truncate_str(result_summary, 200, "…"),
            });
        }
    }

    /// Record the cognition phase final result (overwrites fields but keeps discovery_steps).
    pub fn record_cognition(&mut self, result: &CognitionResult) {
        let discovered_tools = result.tools.iter().map(|t| t.name.clone()).collect();
        // Preserve discovery_steps from earlier record_cognition_step calls
        let existing_steps = self
            .trace
            .cognition
            .as_mut()
            .map(|c| std::mem::take(&mut c.discovery_steps))
            .unwrap_or_default();
        self.trace.cognition = Some(TraceCognition {
            intent_type: result.intent_type.as_ref().map(|i| i.as_str().to_string()),
            success_criteria: result.success_criteria.clone(),
            understanding: result.understanding.clone(),
            plan: result.plan.clone(),
            constraints: result.constraints.clone(),
            discovered_tools,
            answer_directly: result.answer_directly,
            is_fallback: false,
            fallback_reason: None,
            discovery_steps: existing_steps,
        });
    }

    /// Record a tool call execution.
    pub fn record_step(
        &mut self,
        iteration: u32,
        tool: &str,
        args: &serde_json::Value,
        result: &str,
        is_error: bool,
    ) {
        let args_str = serde_json::to_string(args).unwrap_or_default();
        let args_summary = truncate_str(&args_str, ARGS_SUMMARY_MAX, "…");
        let result_summary = truncate_str(result, RESULT_SUMMARY_MAX, "…");
        self.trace.steps.push(TraceStep {
            iteration,
            tool: tool.to_string(),
            args_summary,
            result_summary,
            is_error,
            guard_decision: None,
            browser_stuck_level: None,
            visual_check: None,
            iteration_budget: None,
        });
    }

    /// Annotate the last step with browser guard info.
    pub fn annotate_last_step_browser(
        &mut self,
        guard_decision: &str,
        stuck_level: u8,
        budget: u32,
    ) {
        if let Some(step) = self.trace.steps.last_mut() {
            step.guard_decision = Some(guard_decision.to_string());
            step.browser_stuck_level = Some(stuck_level);
            step.iteration_budget = Some(budget);
        }
    }

    /// Annotate the last step with visual check result.
    pub fn annotate_last_step_visual(&mut self, description: &str) {
        if let Some(step) = self.trace.steps.last_mut() {
            step.visual_check = Some(truncate_str(description, 200, "…"));
        }
    }

    /// Record why the execution stopped.
    pub fn record_stop_reason(&mut self, reason: &str, final_budget: u32) {
        self.trace.stop_reason = Some(reason.to_string());
        self.trace.final_budget = Some(final_budget);
    }

    /// Finalize the trace with the request outcome.
    pub fn finalize(&mut self, response: &str, iterations: u32, tokens: u32, cancelled: bool) {
        self.trace.final_response = Some(truncate_str(response, RESPONSE_SUMMARY_MAX, "…"));
        self.trace.total_iterations = iterations;
        self.trace.total_tokens = tokens;
        self.trace.duration_ms = self.started_at.elapsed().as_millis() as u64;
        self.trace.status = if cancelled {
            TraceStatus::Cancelled
        } else {
            TraceStatus::Completed
        };
    }

    /// Write the trace to disk. Trims oldest files when count exceeds `max`.
    pub fn write_to_disk(self, max_files: usize) {
        let max = if max_files == 0 {
            DEFAULT_MAX_FILES
        } else {
            max_files
        };
        let dir = traces_dir();
        if let Err(e) = fs::create_dir_all(&dir) {
            tracing::debug!(error = %e, "Failed to create traces dir");
            return;
        }
        // Filename: {timestamp_ms}_{id}.json — sorts chronologically
        let filename = format!(
            "{}_{}.json",
            chrono::Utc::now().timestamp_millis(),
            self.trace.id
        );
        match serde_json::to_string_pretty(&self.trace) {
            Ok(json) => {
                if let Err(e) = fs::write(dir.join(&filename), json) {
                    tracing::debug!(error = %e, path = %filename, "Failed to write trace file");
                    return;
                }
                trim_old_traces(&dir, max);
                tracing::debug!(
                    id = %self.trace.id,
                    steps = self.trace.steps.len(),
                    duration_ms = self.trace.duration_ms,
                    "Request trace written"
                );
            }
            Err(e) => tracing::debug!(error = %e, "Failed to serialize trace"),
        }
    }
}

/// Returns the traces directory path (`~/.homun/traces/`).
pub fn traces_dir() -> PathBuf {
    crate::config::Config::data_dir().join("traces")
}

/// Lists trace files sorted by filename (newest first — filenames start with timestamp).
/// Returns `(filename_stem, path)` pairs.
pub fn list_traces() -> Vec<(String, PathBuf)> {
    let dir = traces_dir();
    let mut entries: Vec<(String, PathBuf)> = match fs::read_dir(&dir) {
        Ok(iter) => iter
            .filter_map(|e| {
                let e = e.ok()?;
                let path = e.path();
                let name = path.file_name()?.to_str()?.to_string();
                if !name.ends_with(".json") {
                    return None;
                }
                Some((name, path))
            })
            .collect(),
        Err(_) => return Vec::new(),
    };
    // Newest first: filenames start with epoch ms so lexicographic sort works
    entries.sort_by(|a, b| b.0.cmp(&a.0));
    entries
}

/// Reads a full trace by ID (matches against the `_<id>.json` suffix).
pub fn read_trace(id: &str) -> Option<RequestTrace> {
    let dir = traces_dir();
    let entries = match fs::read_dir(&dir) {
        Ok(iter) => iter,
        Err(_) => return None,
    };
    for entry in entries.filter_map(|e| e.ok()) {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.contains(id) && name.ends_with(".json") {
            if let Ok(content) = fs::read_to_string(entry.path()) {
                return serde_json::from_str(&content).ok();
            }
        }
    }
    None
}

/// Removes the oldest trace files when count exceeds `max`.
fn trim_old_traces(dir: &PathBuf, max: usize) {
    let mut entries: Vec<(PathBuf, String)> = match fs::read_dir(dir) {
        Ok(iter) => iter
            .filter_map(|e| {
                let e = e.ok()?;
                let path = e.path();
                let name = path.file_name()?.to_str()?.to_string();
                if !name.ends_with(".json") {
                    return None;
                }
                Some((path, name))
            })
            .collect(),
        Err(_) => return,
    };
    if entries.len() <= max {
        return;
    }
    // Sort oldest first (lexicographic on filename = chronological)
    entries.sort_by(|a, b| a.1.cmp(&b.1));
    for (path, _) in entries.iter().take(entries.len() - max) {
        let _ = fs::remove_file(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tracer_creates_valid_trace() {
        let mut tracer = RequestTracer::new("web", "session-abc", "trovami un treno");
        assert_eq!(tracer.trace.channel, "web");
        assert_eq!(tracer.trace.request, "trovami un treno");

        tracer.record_step(
            1,
            "browser",
            &serde_json::json!({"action": "navigate", "url": "https://example.com"}),
            "Navigated successfully",
            false,
        );
        assert_eq!(tracer.trace.steps.len(), 1);
        assert_eq!(tracer.trace.steps[0].tool, "browser");

        tracer.finalize("Final response here", 2, 1500, false);
        assert_eq!(tracer.trace.total_iterations, 2);
        assert_eq!(tracer.trace.total_tokens, 1500);
        assert!(matches!(tracer.trace.status, TraceStatus::Completed));
    }

    #[test]
    fn test_args_truncation() {
        let mut tracer = RequestTracer::new("cli", "s", "test");
        let long_args = serde_json::json!({"data": "x".repeat(1000)});
        tracer.record_step(1, "tool", &long_args, "result", false);
        assert!(tracer.trace.steps[0].args_summary.chars().count() <= ARGS_SUMMARY_MAX + 1);
    }

    /// Verify that the JSON format written by RequestTracer round-trips cleanly.
    #[test]
    fn test_round_trip_serialization() {
        let sample = serde_json::json!({
            "id": "abc12345",
            "started_at": "2026-03-27T08:46:04.323134+00:00",
            "channel": "web",
            "session_key": "web:some-uuid",
            "request": "trovami un treno",
            "cognition_model": "claude-sonnet-4-20250514",
            "execution_model": "claude-sonnet-4-20250514",
            "cognition": {
                "intent_type": "informational",
                "success_criteria": "Return train times",
                "understanding": "test",
                "plan": ["search trains"],
                "constraints": [],
                "discovered_tools": ["browser"],
                "answer_directly": false,
                "is_fallback": false,
                "fallback_reason": null
            },
            "steps": [{
                "iteration": 1,
                "tool": "browser",
                "args_summary": "{\"action\":\"navigate\"}",
                "result_summary": "ok",
                "is_error": false
            }],
            "final_response": "Done",
            "total_iterations": 1,
            "total_tokens": 500,
            "duration_ms": 1234,
            "status": "completed"
        });
        let json_str = serde_json::to_string(&sample).unwrap();
        let parsed: RequestTrace =
            serde_json::from_str(&json_str).expect("round-trip deserialization must succeed");
        assert_eq!(parsed.id, "abc12345");
        assert_eq!(parsed.channel, "web");
        assert_eq!(
            parsed.cognition_model.as_deref(),
            Some("claude-sonnet-4-20250514")
        );
        assert_eq!(parsed.steps.len(), 1);
        assert!(matches!(parsed.status, TraceStatus::Completed));
        let cog = parsed.cognition.unwrap();
        assert!(!cog.is_fallback);
        assert_eq!(cog.intent_type.as_deref(), Some("informational"));
    }

    /// Old trace files without the new fields must still deserialize (backward compat).
    #[test]
    fn test_backward_compatible_deserialization() {
        let old_format = serde_json::json!({
            "id": "old12345",
            "started_at": "2026-03-27T08:00:00+00:00",
            "channel": "web",
            "session_key": "web:old-session",
            "request": "hello",
            "cognition": {
                "intent_type": null,
                "success_criteria": null,
                "understanding": "Cognition unavailable",
                "plan": [],
                "constraints": [],
                "discovered_tools": ["browser"],
                "answer_directly": false
            },
            "steps": [],
            "total_iterations": 0,
            "total_tokens": 0,
            "duration_ms": 100,
            "status": "completed"
        });
        let json_str = serde_json::to_string(&old_format).unwrap();
        let parsed: RequestTrace =
            serde_json::from_str(&json_str).expect("old format must deserialize (backward compat)");
        // New fields default to None/false
        assert!(parsed.cognition_model.is_none());
        assert!(parsed.execution_model.is_none());
        let cog = parsed.cognition.unwrap();
        assert!(!cog.is_fallback);
        assert!(cog.fallback_reason.is_none());
    }
}
