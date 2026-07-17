//! Local HTTP gateway contracts for the Electron desktop shell.

// The single control-marker toolkit (‹‹NAME››…‹‹/NAME›› protocol) moved WHOLE into the engine crate
// (ADR 0024 inc 5e.3, pure); re-exported so `local_first_desktop_gateway::markers::…` call sites
// (main.rs, chat_store.rs) are unchanged. Mirror of the frontend's `lib/markers.ts`.
pub use local_first_engine::markers;

use local_first_context_compression::{
    CompressionMetrics, CompressionPolicy, CompressionResult, ContextCompressor, ContextItem,
    ContextKind,
};
use serde::{Deserialize, Serialize};

const DEFAULT_CONTEXT_BUDGET_CHARS: usize = 3_600;
const MAX_SINGLE_CONTEXT_MESSAGE_CHARS: usize = 2_000;
/// At/above this total budget the caller is a capable big-context model, so the
/// per-message small-model clamp is lifted (the total budget still bounds the sum).
const CAPABLE_CHAT_CONTEXT_CHARS: usize = 32_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatContextRole {
    User,
    Assistant,
    System,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatContextMessage {
    pub role: ChatContextRole,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BuildPromptRequest {
    pub prompt: String,
    #[serde(default)]
    pub context: Vec<ChatContextMessage>,
    #[serde(default)]
    pub max_context_chars: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BuildPromptResponse {
    pub runtime_prompt: String,
    pub local_first: bool,
    pub compression: PromptCompressionSummary,
}

/// A file attached in the composer. The wire shape matches what the frontend
/// sends (snake_case). `local_path` is an absolute host path the gateway opens.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AttachmentInput {
    pub local_path: String,
    #[serde(default)]
    pub display_name: String,
    #[serde(default)]
    pub mime_type: String,
    #[serde(default)]
    pub size_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChatGenerateStreamRequest {
    pub request_id: String,
    pub prompt: String,
    /// Chat thread this request belongs to. Lets browser work reuse a single
    /// persistent browser session per thread (search → then book on the same
    /// tab) instead of spawning a fresh one each call.
    #[serde(default)]
    pub thread_id: Option<String>,
    #[serde(default)]
    pub context: Vec<ChatContextMessage>,
    #[serde(default)]
    pub max_context_chars: Option<usize>,
    /// Optional per-message model override (inline composer selector). When set
    /// and non-empty, it replaces the role-resolved model for THIS request only;
    /// the persistent default profile is untouched.
    #[serde(default)]
    pub model: Option<String>,
    /// Optional images (base64 `data:` URLs) for vision models. When present, the
    /// user message is sent as multimodal content (text + image_url parts).
    #[serde(default)]
    pub images: Vec<String>,
    /// Files the user attached in the composer. The gateway reads each by its
    /// absolute `local_path` (same host) and turns it into model-visible content:
    /// extracted text (PDF text layer / text files) injected into the prompt, and
    /// images (photos, or scanned-PDF pages rendered via pdfium) fed to the vision
    /// model. Attaching IS the access grant — no folder authorization needed.
    #[serde(default)]
    pub attachments: Vec<AttachmentInput>,
    pub max_tokens: u32,
    pub temperature: f64,
    pub wait_if_busy: bool,
    #[serde(default)]
    pub request_timeout_seconds: Option<f64>,
    /// Tool policy for this turn. "read_only" (channel turns) offers only tools
    /// without side effects; None/other = full toolset (in-app chat). See M8.
    #[serde(default)]
    pub tool_policy: Option<String>,
    /// Interaction mode chosen in the composer: "agent" (default, full tools),
    /// "plan" (always propose a plan first), "ask" (no tools, pure conversation),
    /// "debug" (debugging methodology, project chats). None = "agent".
    #[serde(default)]
    pub mode: Option<String>,
}

/// A plugin-owned deterministic routing binding (S2), pinned to a THREAD rather than
/// re-derived per-turn from the prompt via BM25. Root cause this fixes: "Use template"
/// intake follow-up turns ("mio", "1 Senior developer…") don't BM25-match the original
/// route text, so per-turn routing falls through to the general AgentLoop (no tool
/// pruning) and a weak model wanders into skills/shell. Set once when the user picks a
/// template/route; read at EVERY turn of the thread so it survives those intake turns.
/// Mirrors `capabilities::workflow_routing::WorkflowRouting`'s `plugin_id`/`route_id`
/// naming so the two line up when the router (S2-T3) resolves this binding back to a
/// registered `WorkflowRouting`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoutingBinding {
    pub plugin_id: String,
    pub route_id: String,
    #[serde(default)]
    pub args: serde_json::Value,
}

/// Body for POST /api/chat/turns. The new broker entry point.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct EnqueueTurnRequest {
    pub thread_id: String,
    pub prompt: String,
    /// Client-generated correlation id. The turn_id is `turn_{request_id}`, so the client can
    /// derive it for cancel (DELETE /turns/{id}) and resume WITHOUT waiting for the response.
    /// Server falls back to a generated id when absent/blank (e.g. non-interactive callers).
    #[serde(default)]
    pub request_id: Option<String>,
    #[serde(default)]
    pub visible_prompt: Option<String>,
    /// Inline composer images. These are data URLs because a pasted image has
    /// no stable path for the queued worker to re-open.
    #[serde(default)]
    pub images: Vec<String>,
    #[serde(default)]
    pub attachments: Option<serde_json::Value>,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    /// "interactive" | "automation" | "channel" | "connector". Defaults to "interactive".
    #[serde(default)]
    pub source: Option<String>,
    /// Set on the turn that picks a plugin template/route (e.g. "Use template"). When
    /// present it is persisted thread-scoped (see `chat_store::ChatStore::
    /// set_thread_routing_binding`) BEFORE the turn runs, so the binding outlives this
    /// one request and keeps steering every later turn of the thread. Absent on
    /// ordinary turns — fail-open, no behavior change.
    #[serde(default)]
    pub routing_binding: Option<RoutingBinding>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CancelGenerationRequest {
    pub request_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatThread {
    pub thread_id: String,
    /// Workspace/project that owns this thread. Legacy rows may omit it in older
    /// serialized payloads, so clients treat it as optional.
    #[serde(default)]
    pub workspace_id: Option<String>,
    pub title: String,
    pub subtitle: String,
    pub status: String,
    pub pinned: bool,
    pub computer_session_id: String,
    pub task_id: String,
    pub updated_at: String,
    pub message_count: u32,
    /// Origin: a channel tag ("whatsapp"/"telegram") or None for an in-app chat.
    /// Lets the UI badge channel-originated conversations.
    #[serde(default)]
    pub source: Option<String>,
    /// Reply target for channel-originated conversations. When present, app-side
    /// replies in this thread can be mirrored back to the originating channel.
    #[serde(default)]
    pub channel_recipient: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatThreadSnapshot {
    pub active_thread_id: String,
    pub threads: Vec<ChatThread>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChatMessage {
    pub id: String,
    pub role: String,
    pub text: String,
    pub timestamp: String,
    pub metadata: Option<String>,
    pub metrics: Option<serde_json::Value>,
    pub feedback: Option<String>,
    pub saved_memory_ref: Option<String>,
    pub linked_task_id: Option<String>,
    pub linked_automation_ref: Option<String>,
    #[serde(default)]
    pub attachments: Vec<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub event_parts: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChatMessagesSnapshot {
    pub thread_id: String,
    pub messages: Vec<ChatMessage>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetThreadPinnedRequest {
    pub pinned: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CommitPromptResultRequest {
    pub user_message: ChatMessage,
    pub assistant_message: ChatMessage,
    /// Edit-as-branch: when set, the new turn is committed as a SIBLING of this
    /// message (the chat tree keeps the old branch). Absent = a plain append.
    #[serde(default)]
    pub branch_from_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CommitContinuationResultRequest {
    pub assistant_message: ChatMessage,
}

/// Commit a regenerated answer as a sibling of the previous one, under the user
/// message that prompted it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CommitRegeneratedResultRequest {
    pub user_message_id: String,
    pub assistant_message: ChatMessage,
}

/// Point a thread's displayed conversation at a specific leaf (branch switcher).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetActiveLeafRequest {
    pub leaf_id: Option<String>,
}

/// Name (or clear) a branch — Phase 4, for the coding workflow.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetBranchLabelRequest {
    pub message_id: String,
    #[serde(default)]
    pub label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PromptCompressionSummary {
    pub input_messages: usize,
    pub input_chars: usize,
    pub output_chars: usize,
    pub estimated_input_tokens: usize,
    pub estimated_output_tokens: usize,
    pub compressed: bool,
    pub redacted: bool,
    pub redaction_count: usize,
    pub compression_ratio: f64,
}

pub fn build_chat_runtime_prompt(request: &BuildPromptRequest) -> BuildPromptResponse {
    let max_context_chars = request
        .max_context_chars
        .unwrap_or(DEFAULT_CONTEXT_BUDGET_CHARS)
        .max(800);
    // promptjuice is an optimization, not a gate: when a capable model gives a
    // generous total budget, stop sub-clamping each message to the small-model
    // 2K cap (a long pasted block would otherwise be truncated even with room
    // to spare). Small/default budgets keep the cheap per-message cap.
    let max_message_chars = if max_context_chars >= CAPABLE_CHAT_CONTEXT_CHARS {
        max_context_chars
    } else {
        MAX_SINGLE_CONTEXT_MESSAGE_CHARS
    };
    let raw_context = render_context_lines(&request.context, max_message_chars);
    let compression = ContextCompressor::default().compress(
        &ContextItem::new(ContextKind::ChatHistory, raw_context),
        &CompressionPolicy::for_kind(ContextKind::ChatHistory).with_max_chars(max_context_chars),
    );
    let context_text = clean_context_text_for_prompt(&compression);
    let runtime_prompt = render_runtime_prompt(request.prompt.trim(), context_text.trim());

    BuildPromptResponse {
        runtime_prompt,
        local_first: true,
        compression: PromptCompressionSummary::from_context(
            request.context.len(),
            context_text.chars().count(),
            compression.redacted,
            &compression.metrics,
        ),
    }
}

pub fn seeded_ready_message(thread_id: &str, timestamp: String) -> ChatMessage {
    ChatMessage {
        id: format!("{thread_id}_ready"),
        role: "assistant".to_string(),
        text: "I'm ready. Go ahead and write to me: I answer locally.".to_string(),
        timestamp,
        metadata: Some("Local model".to_string()),
        metrics: None,
        feedback: None,
        saved_memory_ref: None,
        linked_task_id: None,
        linked_automation_ref: None,
        attachments: Vec::new(),
        event_parts: Vec::new(),
    }
}

pub fn compact_thread_title(text: &str) -> String {
    let normalized = text
        .chars()
        .map(|ch| {
            if ch.is_alphanumeric() || ch == '\'' || ch == '-' {
                ch
            } else {
                ' '
            }
        })
        .collect::<String>();
    let words = normalized.split_whitespace().collect::<Vec<_>>();
    let stop_words = [
        "a", "ad", "al", "alla", "anche", "che", "con", "crea", "creare", "dai", "dammi", "ci",
        "del", "della", "di", "dimmi", "e", "fai", "fare", "il", "in", "la", "le", "lo", "mi",
        "per", "puoi", "se", "sono", "sto", "su", "sui", "una", "usando", "usa", "using", "with",
        "the", "for", "to", "create", "make", "me", "tell", "give",
    ];
    let keywords = words
        .iter()
        .copied()
        .filter(|word| !stop_words.contains(&word.to_lowercase().as_str()))
        .collect::<Vec<_>>();
    let source = if keywords.is_empty() { words } else { keywords };
    let title = source.into_iter().take(5).collect::<Vec<_>>().join(" ");
    if title.chars().count() > 44 {
        format!("{}...", title.chars().take(41).collect::<String>().trim())
    } else {
        title
    }
}

fn clean_context_text_for_prompt(result: &CompressionResult) -> String {
    if result.metrics.output_chars <= result.metrics.input_chars {
        return result.text.clone();
    }
    result
        .text
        .lines()
        .filter(|line| !line.starts_with("[context compressed: input_chars="))
        .collect::<Vec<_>>()
        .join("\n")
}

fn render_context_lines(context: &[ChatContextMessage], max_message_chars: usize) -> String {
    context
        .iter()
        .filter_map(|message| {
            let text = normalize_context_text(&message.text, max_message_chars);
            if text.is_empty() {
                return None;
            }
            Some(format!("{}: {text}", role_label(&message.role)))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn render_runtime_prompt(prompt: &str, compressed_context: &str) -> String {
    let context_block = if compressed_context.is_empty() {
        String::new()
    } else {
        format!("Recent chat context:\n{compressed_context}\n\n")
    };

    [
        "You are a local personal assistant. Reply in the user's language, directly and to the point.",
        "The recent context has been redacted and compressed by the local Rust Desktop Gateway with a JuicePrompt-style budget.",
        "Keep your first answer compact: 1-4 short paragraphs or an essential code block.",
        "If you include code, always use fenced markdown blocks with a language.",
        "Use the recent context to resolve references like 'the other one', 'continue', 'the one from before' or 'explain it better'.",
        "Grounding: do NOT state checkable or time-sensitive facts (current events, news, sports results/standings, who won or qualified, schedules, dates, prices, live status) from memory — verify them with a tool (browser / web search / sandbox) before answering. If you cannot verify, say so plainly and do not invent. If the user disputes a fact you gave, verify it before answering again — never double down on an unverified claim. Stable, well-known facts you may answer directly.",
        "",
        &context_block,
        &format!("User: {prompt}"),
    ]
    .join("\n")
}

// The canonical display-marker stripper + tag list now live in `local_first_engine::markers`
// (5.D1c: caposaldo #5 — one strip primitive for the whole backend). Re-exported here so this crate's
// callers (in-app context renderer, channel mirror) keep using `strip_display_markers` unchanged.
pub use local_first_engine::markers::strip_display_markers;

fn normalize_context_text(text: &str, max_message_chars: usize) -> String {
    // Strip display-only markers BEFORE compressing: the model must see the prior answer's
    // prose, never the UI's collapsed reasoning/plan markers (which it would misread as content).
    let stripped = strip_display_markers(text);
    let normalized = stripped.split_whitespace().collect::<Vec<_>>().join(" ");
    clamp_end(&normalized, max_message_chars)
}

fn role_label(role: &ChatContextRole) -> &'static str {
    match role {
        ChatContextRole::User => "User",
        ChatContextRole::Assistant => "Assistant",
        ChatContextRole::System => "System",
    }
}

fn clamp_end(input: &str, max_chars: usize) -> String {
    if input.chars().count() <= max_chars {
        return input.to_string();
    }
    if max_chars <= 4 {
        return input.chars().take(max_chars).collect();
    }
    format!(
        "{}...",
        input
            .chars()
            .take(max_chars.saturating_sub(3))
            .collect::<String>()
    )
}

impl PromptCompressionSummary {
    fn from_context(
        input_messages: usize,
        output_chars: usize,
        redacted: bool,
        metrics: &CompressionMetrics,
    ) -> Self {
        let compressed = output_chars < metrics.input_chars;
        Self {
            input_messages,
            input_chars: metrics.input_chars,
            output_chars,
            estimated_input_tokens: metrics.estimated_input_tokens,
            estimated_output_tokens: output_chars.div_ceil(4).max(1),
            compressed,
            redacted,
            redaction_count: metrics.redaction_count,
            compression_ratio: if metrics.input_chars == 0 {
                1.0
            } else {
                output_chars as f64 / metrics.input_chars as f64
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_display_markers_removes_blocks_including_unclosed() {
        // A closed reasoning trace + plan card are removed; the answer prose stays.
        let s = strip_display_markers(
            "‹‹REASONING››long chain of thought‹‹/REASONING››\nThe answer is 42.‹‹PLAN››- [x] step‹‹/PLAN››",
        );
        assert!(!s.contains("‹‹"), "no marker left: {s:?}");
        assert!(!s.contains("chain of thought"));
        assert!(s.contains("The answer is 42."));
        // An UNCLOSED marker (reasoning truncated by finish_reason:length) drops to end.
        let trunc = strip_display_markers("Visible.‹‹REASONING››thinking that got cut off");
        assert_eq!(trunc.trim(), "Visible.");
    }

    #[test]
    fn followup_context_excludes_the_assistant_reasoning_trace() {
        // Regression: a reasoning model's prior ‹‹REASONING›› trace must NOT re-enter the model
        // context — else it reads its own markers as pasted text ("il testo è già completo").
        let response = build_chat_runtime_prompt(&BuildPromptRequest {
            prompt: "continue".to_string(),
            context: vec![ChatContextMessage {
                role: ChatContextRole::Assistant,
                text: "‹‹REASONING››I should explain X then Y‹‹/REASONING››\nHere is X.".to_string(),
            }],
            max_context_chars: Some(1_000),
        });
        assert!(response.runtime_prompt.contains("Assistant: Here is X."));
        assert!(!response.runtime_prompt.contains("REASONING"));
        assert!(!response.runtime_prompt.contains("I should explain X"));
    }

    #[test]
    fn prompt_builder_keeps_recent_context_for_followups() {
        let response = build_chat_runtime_prompt(&BuildPromptRequest {
            prompt: "tell me another one".to_string(),
            context: vec![
                ChatContextMessage {
                    role: ChatContextRole::User,
                    text: "tell me a joke".to_string(),
                },
                ChatContextMessage {
                    role: ChatContextRole::Assistant,
                    text: "Why do scientists prefer eyelets?".to_string(),
                },
            ],
            max_context_chars: Some(1_000),
        });

        assert!(response.runtime_prompt.contains("Recent chat context"));
        assert!(response.runtime_prompt.contains("User: tell me a joke"));
        assert!(
            response
                .runtime_prompt
                .contains("Assistant: Why do scientists")
        );
        assert!(
            response
                .runtime_prompt
                .contains("User: tell me another one")
        );
    }

    #[test]
    fn large_budget_lifts_the_per_message_clamp_for_capable_models() {
        let long_message = "x".repeat(5_000);
        let context = vec![ChatContextMessage {
            role: ChatContextRole::User,
            text: long_message.clone(),
        }];

        // Default/small budget: the per-message small-model clamp (2K) truncates.
        let small = build_chat_runtime_prompt(&BuildPromptRequest {
            prompt: "continue".to_string(),
            context: context.clone(),
            max_context_chars: Some(DEFAULT_CONTEXT_BUDGET_CHARS),
        });
        assert!(!small.runtime_prompt.contains(&long_message));

        // Capable budget: the whole message survives (promptjuice passes through).
        let capable = build_chat_runtime_prompt(&BuildPromptRequest {
            prompt: "continue".to_string(),
            context,
            max_context_chars: Some(chat_budget_for_window_tokens()),
        });
        assert!(capable.runtime_prompt.contains(&long_message));
    }

    fn chat_budget_for_window_tokens() -> usize {
        CAPABLE_CHAT_CONTEXT_CHARS * 4
    }

    #[test]
    fn prompt_builder_redacts_sensitive_context_before_returning_to_renderer() {
        let response = build_chat_runtime_prompt(&BuildPromptRequest {
            prompt: "pick up from here".to_string(),
            context: vec![ChatContextMessage {
                role: ChatContextRole::User,
                text: "my email is fabio@example.com token=sk-secret".to_string(),
            }],
            max_context_chars: Some(1_000),
        });

        assert!(response.runtime_prompt.contains("[REDACTED]"));
        assert!(!response.runtime_prompt.contains("fabio@example.com"));
        assert!(!response.runtime_prompt.contains("sk-secret"));
        assert!(!response.runtime_prompt.contains("context compressed"));
        assert!(response.compression.redacted);
        assert!(response.compression.redaction_count >= 2);
    }

    #[test]
    fn prompt_builder_compresses_older_turns_under_budget() {
        let context = (0..16)
            .flat_map(|index| {
                [
                    ChatContextMessage {
                        role: ChatContextRole::User,
                        text: format!("old message number {index} with lots of repeated text"),
                    },
                    ChatContextMessage {
                        role: ChatContextRole::Assistant,
                        text: format!("old reply number {index} with repeated details"),
                    },
                ]
            })
            .collect::<Vec<_>>();

        let response = build_chat_runtime_prompt(&BuildPromptRequest {
            prompt: "continue".to_string(),
            context,
            max_context_chars: Some(500),
        });

        assert!(response.compression.compressed);
        assert!(response.runtime_prompt.contains("Earlier context"));
        assert!(response.runtime_prompt.contains("User: continue"));
        assert!(response.compression.output_chars <= 500);
    }
}
