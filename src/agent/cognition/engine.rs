//! Cognition engine — mini ReAct loop with discovery tools.
//!
//! Runs before the main execution loop to understand intent,
//! discover resources, and build a targeted plan.

use std::sync::Arc;

use anyhow::{Context as _, Result};
use tokio::sync::{mpsc, RwLock};

use crate::config::Config;
use crate::provider::{
    ChatMessage, ChatRequest, ChatResponse, Provider, RequestPriority, StreamChunk,
};
use crate::skills::loader::SkillRegistry;
use crate::storage::Database;
use crate::tools::ToolRegistry;

use super::discovery;
use super::types::{validate_cognition_result, CognitionResult, ValidationIssue};

/// Maximum retries when the LLM call fails (network error, timeout, etc.).
/// After this many consecutive failures, the cognition phase gives up and
/// the caller falls back to the full tool set.
const MAX_CALL_RETRIES: u32 = 3;

/// Per-call timeout for a single LLM request (seconds).
const PER_CALL_TIMEOUT_SECS: u64 = 60;

/// Higher per-call timeout for local/slow providers (Ollama, etc.).
const PER_CALL_TIMEOUT_LOCAL_SECS: u64 = 120;

/// How many recent messages to include for conversational context.
const COGNITION_HISTORY_TAIL: usize = 10;

/// Parameters for running the cognition phase.
pub struct CognitionParams<'a> {
    pub user_prompt: &'a str,
    /// Recent conversation history for anaphoric reference resolution
    /// (e.g., "show it" → the codice fiscale from the previous turn).
    pub recent_history: &'a [ChatMessage],
    pub config: &'a Config,
    pub tool_registry: &'a RwLock<ToolRegistry>,
    pub skill_registry: Option<&'a RwLock<SkillRegistry>>,
    #[cfg(feature = "embeddings")]
    pub memory_searcher:
        Option<&'a Arc<tokio::sync::Mutex<crate::agent::memory_search::MemorySearcher>>>,
    #[cfg(feature = "embeddings")]
    pub rag_engine: Option<&'a Arc<tokio::sync::Mutex<crate::rag::RagEngine>>>,
    pub contact_summary: &'a str,
    pub channel: &'a str,
    pub agent_id: Option<&'a str>,
    pub contact_id: Option<i64>,
    /// Visible profile IDs for memory/RAG scoping (active + readable_from).
    pub visible_profile_ids: Vec<i64>,
    /// Active profile slug for skill filtering.
    pub active_profile_slug: Option<String>,
    /// Contact perimeter for tool/knowledge filtering (None = owner, no restrictions).
    pub contact_perimeter: Option<crate::contacts::perimeter::ContactPerimeter>,
    /// Allowed knowledge namespaces from contact perimeter (None = owner, all visible).
    pub allowed_namespaces: Option<Vec<String>>,
    /// Database pool for shared resource lookups during discovery.
    pub db: Option<&'a crate::storage::Database>,
    pub stream_tx: Option<&'a mpsc::Sender<StreamChunk>>,
    pub cognition_model: Option<&'a str>,
    pub max_iterations: u32,
    /// Per-call timeout override (seconds). 0 = use default based on model.
    pub timeout_secs: u64,
    /// Maximum retry attempts for failed LLM calls. 0 = use default.
    pub max_retries: u32,
    /// Optional request tracer to record cognition discovery steps.
    pub tracer: Option<&'a mut crate::agent::request_trace::RequestTracer>,
}

/// Run the cognition phase: understand intent and build a targeted plan.
///
/// **Plan-first approach**: the model receives the list of available tool
/// names in the system prompt and only `plan_execution` as a callable tool.
/// This produces a plan in a single LLM call (~800 tokens) instead of the
/// old multi-iteration discovery loop that many models couldn't complete.
///
/// Returns `Ok(CognitionResult)` on success, or `Err(reason)` for the caller
/// to fall back to the full tool set.
pub async fn run_cognition(mut params: CognitionParams<'_>) -> Result<CognitionResult, String> {
    emit_status(params.stream_tx, "cognition_start", "Analyzing request...").await;

    let config = params.config;
    let model = params
        .cognition_model
        .filter(|m| !m.is_empty())
        .unwrap_or(&config.agent.model);

    let provider = match crate::provider::factory::create_provider_for_model(config, model) {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!(error = %e, model, "Failed to create cognition provider");
            return Err(format!("provider creation failed for model '{model}': {e}"));
        }
    };

    // Collect available tool/skill/MCP names for the system prompt.
    // The model sees these names and references them in its plan —
    // no discovery tools needed.
    let tool_names = collect_known_tool_names(params.tool_registry).await;
    let skill_names = collect_known_skill_names(params.skill_registry).await;
    let mcp_tool_names = collect_mcp_tool_names(params.tool_registry).await;

    let system_prompt = build_cognition_prompt_plan_first(
        params.contact_summary,
        params.channel,
        &tool_names,
        &skill_names,
        &mcp_tool_names,
    );

    // Only plan_execution as a callable tool
    let tool_defs = vec![super::types::plan_execution_tool_definition()];

    let mut messages = vec![ChatMessage::system(&system_prompt)];

    // Inject recent conversation history for anaphoric reference resolution.
    if !params.recent_history.is_empty() {
        let tail_start = params
            .recent_history
            .len()
            .saturating_sub(COGNITION_HISTORY_TAIL);
        messages.extend_from_slice(&params.recent_history[tail_start..]);
    }

    messages.push(ChatMessage::user(params.user_prompt));

    let max_retries = if params.max_retries > 0 {
        params.max_retries
    } else {
        MAX_CALL_RETRIES
    };
    let per_call_timeout = std::time::Duration::from_secs(if params.timeout_secs > 0 {
        params.timeout_secs
    } else if model.starts_with("ollama/") {
        PER_CALL_TIMEOUT_LOCAL_SECS
    } else {
        PER_CALL_TIMEOUT_SECS
    });

    let started = std::time::Instant::now();

    // Single-call with retry: send messages + plan_execution tool,
    // retry on transient failures (network, timeout), up to max_retries.
    let mut cognition_result: Option<CognitionResult> = None;
    let mut failure_reason: Option<String> = None;

    for attempt in 1..=max_retries {
        tracing::debug!(attempt, model = %model, "Cognition plan-first call");

        let request = ChatRequest {
            messages: messages.clone(),
            tools: tool_defs.clone(),
            model: model.to_string(),
            max_tokens: 1500,
            temperature: 0.2,
            think: Some(false),
            priority: RequestPriority::High,
        };

        let response = match tokio::time::timeout(per_call_timeout, provider.chat(request)).await {
            Ok(Ok(r)) => r,
            Ok(Err(e)) => {
                tracing::warn!(
                    error = %e, attempt, max = max_retries, model,
                    "Cognition LLM call failed — retrying"
                );
                failure_reason = Some(format!(
                    "LLM call failed (attempt {attempt}/{max_retries}), model '{model}': {e}"
                ));
                continue;
            }
            Err(_) => {
                tracing::warn!(
                    attempt, max = max_retries, model,
                    timeout_secs = per_call_timeout.as_secs(),
                    "Cognition LLM call timed out — retrying"
                );
                failure_reason = Some(format!(
                    "LLM call timed out (attempt {attempt}/{max_retries}), model '{model}'"
                ));
                continue;
            }
        };

        // Try to extract plan_execution from tool calls
        if response.has_tool_calls() {
            for tool_call in &response.tool_calls {
                if tool_call.name == "plan_execution" {
                    match serde_json::from_value::<CognitionResult>(tool_call.arguments.clone()) {
                        Ok(result) => {
                            tracing::info!(
                                understanding = %result.understanding,
                                complexity = ?result.complexity,
                                tools = result.tools.len(),
                                answer_directly = result.answer_directly,
                                "Cognition plan-first produced result"
                            );
                            if let Some(ref mut t) = params.tracer {
                                let tool_names: Vec<&str> =
                                    result.tools.iter().map(|t| t.name.as_str()).collect();
                                t.record_cognition_step(
                                    1,
                                    "plan_execution",
                                    &result.understanding,
                                    &format!("tools={:?} plan={} steps", tool_names, result.plan.len()),
                                );
                            }
                            cognition_result = Some(result);
                        }
                        Err(e) => {
                            tracing::warn!(error = %e, "Failed to parse plan_execution arguments");
                            failure_reason = Some(format!(
                                "plan_execution parse error: {e}, model '{model}'"
                            ));
                        }
                    }
                }
            }
        } else if let Some(ref text) = response.content {
            // Fallback: model responded with text instead of tool call.
            // Try to parse as JSON (some models emit raw JSON).
            if let Ok(result) = serde_json::from_str::<CognitionResult>(text) {
                cognition_result = Some(result);
                if let Some(ref mut t) = params.tracer {
                    t.record_cognition_step(1, "(text→json)", "", "parsed as CognitionResult");
                }
            } else {
                let preview: String = text.chars().take(200).collect();
                tracing::debug!(preview = %preview, "Cognition responded with text, not tool call");
                if let Some(ref mut t) = params.tracer {
                    t.record_cognition_step(1, "(text, no tool call)", &preview, "could not parse");
                }
                failure_reason = Some(format!(
                    "model responded with text instead of plan_execution, model '{model}'"
                ));
            }
        }

        // If we got a result (from tool call or text parse), stop retrying.
        if cognition_result.is_some() {
            break;
        }
    }

    // Validate and return
    match cognition_result {
        Some(mut result) => {
            let known_tools = &tool_names;
            let known_skills = &skill_names;
            let issues = validate_cognition_result(&result, known_tools, known_skills);

            if !issues.is_empty() {
                tracing::warn!(
                    issues = issues.len(),
                    first_issue = %issues[0].message,
                    "Cognition result has validation issues"
                );
                result
                    .tools
                    .retain(|t| known_tools.iter().any(|kt| kt == &t.name));
                result
                    .skills
                    .retain(|s| known_skills.iter().any(|ks| ks == &s.name));
            }

            let summary = format_result_summary(&result);
            emit_status(params.stream_tx, "cognition_result", &summary).await;

            tracing::info!(
                understanding = %result.understanding,
                intent = ?result.intent_type,
                success_criteria = ?result.success_criteria,
                tools = result.tools.len(),
                plan_steps = result.plan.len(),
                constraints = ?result.constraints,
                plan = ?result.plan,
                elapsed_ms = started.elapsed().as_millis(),
                "Cognition phase complete"
            );

            Ok(result)
        }
        None => {
            let reason = failure_reason.unwrap_or_else(|| {
                format!("no plan_execution produced after {max_retries} attempts, model '{model}'")
            });
            tracing::warn!(
                elapsed_ms = started.elapsed().as_millis(),
                reason = %reason,
                "Cognition phase produced no result — falling back to full tool set"
            );
            emit_status(
                params.stream_tx,
                "cognition_result",
                "Cognition skipped — using full capabilities",
            )
            .await;
            Err(reason)
        }
    }
}

/// Dispatch a discovery tool call to the appropriate handler.
async fn dispatch_discovery_tool(
    name: &str,
    arguments: &serde_json::Value,
    params: &CognitionParams<'_>,
) -> String {
    let query = arguments
        .get("query")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    match name {
        "discover_tools" => discovery::discover_tools(query, params.tool_registry).await,
        "discover_skills" => {
            // For contacts with perimeter, only show shared skills
            let allowed_skills = if params.contact_perimeter.is_some() {
                resolve_allowed_skills(params).await
            } else {
                Vec::new() // owner: all skills visible
            };
            discovery::discover_skills(
                query,
                params.skill_registry,
                params.active_profile_slug.as_deref(),
                &allowed_skills,
            )
            .await
        }
        "discover_mcp" => {
            // For contacts with perimeter, only show shared MCP servers
            let allowed_mcp = if params.contact_perimeter.is_some() {
                resolve_allowed_mcp(params).await
            } else {
                Vec::new() // owner: all MCP visible
            };
            discovery::discover_mcp(query, params.config, params.tool_registry, &allowed_mcp).await
        }
        "search_memory" => {
            #[cfg(feature = "embeddings")]
            if let Some(searcher) = params.memory_searcher {
                return discovery::search_memory(
                    query,
                    searcher,
                    params.contact_id,
                    params.agent_id,
                    &params.visible_profile_ids,
                )
                .await;
            }
            #[cfg(not(feature = "embeddings"))]
            let _ = query;
            "[]".to_string()
        }
        "search_knowledge" => {
            #[cfg(feature = "embeddings")]
            if let Some(rag) = params.rag_engine {
                return discovery::search_knowledge(query, rag, &params.visible_profile_ids, params.allowed_namespaces.as_deref()).await;
            }
            "[]".to_string()
        }
        "plan_execution" => {
            // Handled by the caller — should not reach here
            "OK".to_string()
        }
        _ => format!("Unknown discovery tool: {}", name),
    }
}

/// Resolve allowed skill names for a contact from shared resources.
///
/// Returns empty Vec for owner (no restrictions). For contacts, only
/// skills explicitly shared via `shared_resource_access` are returned.
async fn resolve_allowed_skills(params: &CognitionParams<'_>) -> Vec<String> {
    let contact_id = match params.contact_id {
        Some(id) => id,
        None => return Vec::new(),
    };
    let Some(db) = params.db else {
        return Vec::new();
    };
    match crate::sharing::db::resolve_contact_access(db.pool(), contact_id).await {
        Ok(access) => {
            let names: Vec<String> = access.skills.into_iter().map(|(name, _)| name).collect();
            if !names.is_empty() {
                tracing::debug!(contact_id, skills = ?names, "Contact has shared skill access");
            }
            names
        }
        Err(e) => {
            tracing::warn!(error = %e, contact_id, "Failed to resolve shared skills");
            Vec::new()
        }
    }
}

/// Resolve allowed MCP servers for a contact, including per-tool and per-resource restrictions.
///
/// Returns `(server_name, allowed_tools, allowed_resources)` tuples.
/// Empty vectors mean no restrictions (backward compatible).
async fn resolve_allowed_mcp(
    params: &CognitionParams<'_>,
) -> Vec<(String, Vec<String>, Vec<String>)> {
    let contact_id = match params.contact_id {
        Some(id) => id,
        None => return Vec::new(),
    };
    let Some(db) = params.db else {
        return Vec::new();
    };
    match crate::sharing::db::resolve_contact_access(db.pool(), contact_id).await {
        Ok(access) => {
            let entries: Vec<(String, Vec<String>, Vec<String>)> = access
                .mcp_servers
                .into_iter()
                .map(|(name, _perm, scope)| {
                    let parsed = serde_json::from_str::<serde_json::Value>(&scope).ok();
                    let extract = |key: &str| -> Vec<String> {
                        parsed
                            .as_ref()
                            .and_then(|v| v.get(key)?.as_array().cloned())
                            .map(|arr| {
                                arr.into_iter()
                                    .filter_map(|v| v.as_str().map(String::from))
                                    .collect()
                            })
                            .unwrap_or_default()
                    };
                    let allowed_tools = extract("allowed_tools");
                    let allowed_resources = extract("allowed_resources");
                    (name, allowed_tools, allowed_resources)
                })
                .collect();
            if !entries.is_empty() {
                tracing::debug!(
                    contact_id,
                    mcp = ?entries,
                    "Contact has shared MCP access with tool/resource restrictions"
                );
            }
            entries
        }
        Err(e) => {
            tracing::warn!(error = %e, contact_id, "Failed to resolve shared MCP");
            Vec::new()
        }
    }
}

/// Build the system prompt for plan-first cognition.
///
/// Lists available tool/skill/MCP names directly in the prompt so the model
/// can reference them in its plan without needing discovery tool calls.
fn build_cognition_prompt_plan_first(
    contact_summary: &str,
    channel: &str,
    tool_names: &[String],
    skill_names: &[String],
    mcp_tool_names: &[String],
) -> String {
    let now = chrono::Local::now();
    let mut prompt = String::with_capacity(2000);

    prompt.push_str(
        "You are the planning module of Homun, a personal AI assistant.\n\
         Analyze the user's request and call plan_execution with your analysis.\n\n",
    );

    prompt.push_str(&format!(
        "Current time: {}\nCurrent year: {}\nChannel: {}\n",
        now.format("%Y-%m-%d %H:%M (%A) %Z"),
        now.format("%Y"),
        channel,
    ));

    if !contact_summary.is_empty() {
        prompt.push_str(&format!("Sender: {}\n", contact_summary));
    }

    // List available tools
    prompt.push_str("\n## Available tools\n\n");
    if !tool_names.is_empty() {
        prompt.push_str("Built-in: ");
        prompt.push_str(&tool_names.join(", "));
        prompt.push('\n');
    }
    if !skill_names.is_empty() {
        prompt.push_str("Skills: ");
        prompt.push_str(&skill_names.join(", "));
        prompt.push('\n');
    }
    if !mcp_tool_names.is_empty() {
        prompt.push_str("External (MCP): ");
        prompt.push_str(&mcp_tool_names.join(", "));
        prompt.push('\n');
    }

    prompt.push_str(
        "\nReference these exact names in your plan's `tools` field. \
         Do NOT invent tool names not listed above.\n\n\
         ## Instructions\n\n\
         Extract ALL concrete parameters into `constraints`:\n\
         - Dates/times, quantities, locations, preferences\n\n\
         Write `plan` as specific, actionable steps.\n\
         BAD: \"Search for restaurants\" → GOOD: \"Navigate to thefork.it, set location to Novara, \
         set date to 22 March 2026, set 4 guests, search\"\n\n\
         Classify `intent_type`:\n\
         - **informational**: find/compare/research data → present info\n\
         - **transactional**: complete an action (book, buy, send) → action done\n\
         - **navigational**: go to a specific site or page\n\
         - **creative**: write, generate, or transform content\n\n\
         \"find me a train\" = informational. \"book me a train\" = transactional.\n\n\
         Write `success_criteria` as ONE sentence: what 'done' looks like.\n\n\
         For simple requests (greetings, time, factual questions), set \
         answer_directly=true and provide your answer in direct_answer.\n",
    );

    prompt
}

/// Collect all known tool names from the registry.
async fn collect_known_tool_names(registry: &RwLock<ToolRegistry>) -> Vec<String> {
    registry
        .read()
        .await
        .names()
        .into_iter()
        .map(|s| s.to_string())
        .collect()
}

/// Collect all known skill names from the registry.
async fn collect_known_skill_names(registry: Option<&RwLock<SkillRegistry>>) -> Vec<String> {
    match registry {
        Some(r) => r
            .read()
            .await
            .list_for_model()
            .into_iter()
            .map(|(name, _)| name.to_string())
            .collect(),
        None => Vec::new(),
    }
}

/// Collect MCP tool names from the tool registry.
///
/// MCP tools are prefixed with their server name (e.g. `google-workspace__gmail_send_email`).
/// We extract just these for the system prompt listing.
async fn collect_mcp_tool_names(registry: &RwLock<ToolRegistry>) -> Vec<String> {
    registry
        .read()
        .await
        .names()
        .into_iter()
        .filter(|n| n.contains("__"))
        .map(|s| s.to_string())
        .collect()
}

/// Format a human-readable summary of the cognition result for the stream.
fn format_result_summary(result: &CognitionResult) -> String {
    let mut parts = Vec::new();

    if result.answer_directly {
        return "Direct answer (no tools needed)".to_string();
    }

    if let Some(ref intent) = result.intent_type {
        parts.push(format!("Intent: {}", intent.as_str()));
    }
    if !result.tools.is_empty() {
        let names: Vec<&str> = result.tools.iter().map(|t| t.name.as_str()).collect();
        parts.push(format!("Tools: {}", names.join(", ")));
    }
    if !result.skills.is_empty() {
        let names: Vec<&str> = result.skills.iter().map(|s| s.name.as_str()).collect();
        parts.push(format!("Skills: {}", names.join(", ")));
    }
    if result.memory_context.is_some() {
        parts.push("Memory: loaded".to_string());
    }
    if result.rag_context.is_some() {
        parts.push("Knowledge: loaded".to_string());
    }
    if !result.plan.is_empty() {
        parts.push(format!("Plan: {} steps", result.plan.len()));
    }

    if parts.is_empty() {
        result.understanding.clone()
    } else {
        format!("{} | {}", result.understanding, parts.join(" | "))
    }
}

/// Emit a status event to the frontend stream.
async fn emit_status(tx: Option<&mpsc::Sender<StreamChunk>>, event_type: &str, message: &str) {
    if let Some(tx) = tx {
        let _ = tx
            .send(StreamChunk {
                delta: message.to_string(),
                done: false,
                event_type: Some(event_type.to_string()),
                tool_call_data: None,
            })
            .await;
    }
}

/// Summarize a discovery tool result for the UI cognition step.
fn summarize_discovery_result(tool_name: &str, result_json: &str) -> String {
    let parsed: serde_json::Value = match serde_json::from_str(result_json) {
        Ok(v) => v,
        Err(_) => return "done".to_string(),
    };

    let items = match parsed.as_array() {
        Some(arr) => arr,
        None => return "done".to_string(),
    };

    if items.is_empty() {
        return "0 results".to_string();
    }

    let names: Vec<&str> = items
        .iter()
        .take(4)
        .filter_map(|item| item.get("name").and_then(|n| n.as_str()))
        .collect();

    match tool_name {
        "discover_tools" | "discover_skills" | "discover_mcp" => {
            if names.is_empty() {
                format!("{} found", items.len())
            } else if items.len() > names.len() {
                format!("{} found: {}, …", items.len(), names.join(", "))
            } else {
                format!("{} found: {}", items.len(), names.join(", "))
            }
        }
        "search_memory" => format!("{} memories", items.len()),
        "search_knowledge" => format!("{} documents", items.len()),
        _ => format!("{} results", items.len()),
    }
}

/// Extract and truncate the query from tool arguments for logging.
fn truncate_query(args: &serde_json::Value) -> String {
    args.get("query")
        .and_then(|v| v.as_str())
        .map(|s| {
            if s.len() > 50 {
                format!("{}...", &s[..50])
            } else {
                s.to_string()
            }
        })
        .unwrap_or_else(|| "...".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_cognition_prompt_plan_first() {
        let tools = vec!["browser".to_string(), "web_search".to_string()];
        let skills = vec!["summarize".to_string()];
        let mcp = vec!["google__calendar".to_string()];
        let prompt = build_cognition_prompt_plan_first(
            "Fabio (informal)", "telegram", &tools, &skills, &mcp,
        );
        assert!(prompt.contains("browser, web_search"), "should list tools");
        assert!(prompt.contains("summarize"), "should list skills");
        assert!(prompt.contains("google__calendar"), "should list MCP");
        assert!(prompt.contains("telegram"), "should include channel");
        assert!(prompt.contains("Fabio"), "should include contact");
        assert!(prompt.contains("plan_execution"), "should mention plan_execution");
        assert!(prompt.contains("intent_type"), "should explain intent types");
    }

    #[test]
    fn test_format_result_summary_direct() {
        let result = CognitionResult::direct("test");
        let summary = format_result_summary(&result);
        assert!(summary.contains("Direct answer"));
    }

    #[test]
    fn test_format_result_summary_with_tools() {
        let result = CognitionResult {
            understanding: "Search for trains".to_string(),
            complexity: super::super::types::Complexity::Complex,
            answer_directly: false,
            direct_answer: None,
            tools: vec![super::super::types::DiscoveredTool {
                name: "web_search".to_string(),
                description: "Search".to_string(),
                reason: "Need to search".to_string(),
            }],
            skills: Vec::new(),
            mcp_tools: Vec::new(),
            memory_context: Some("User prefers Frecciarossa".to_string()),
            rag_context: None,
            plan: vec!["Step 1".to_string(), "Step 2".to_string()],
            constraints: Vec::new(),
            autonomy_override: None,
            intent_type: Some(super::super::types::IntentType::Informational),
            success_criteria: Some("Find train options".to_string()),
        };
        let summary = format_result_summary(&result);
        assert!(summary.contains("web_search"));
        assert!(summary.contains("Intent: informational"));
        assert!(summary.contains("Memory: loaded"));
        assert!(summary.contains("Plan: 2 steps"));
    }

    #[test]
    fn test_truncate_query() {
        let args = serde_json::json!({"query": "short"});
        assert_eq!(truncate_query(&args), "short");

        let long = "a".repeat(100);
        let args = serde_json::json!({"query": long});
        let result = truncate_query(&args);
        assert!(result.ends_with("..."));
        assert!(result.len() < 60);
    }
}
