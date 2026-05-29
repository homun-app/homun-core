//! Local HTTP gateway contracts for the Electron desktop shell.

/// Browser observe/act loop planner (prompt construction + decision parsing).
/// Exposed from the library so it can be exercised by integration harnesses and
/// examples, not only from inside the gateway binary.
pub mod browser_loop_controller;

use local_first_context_compression::{
    CompressionMetrics, CompressionPolicy, CompressionResult, ContextCompressor, ContextItem,
    ContextKind,
};
use serde::{Deserialize, Serialize};

const DEFAULT_CONTEXT_BUDGET_CHARS: usize = 3_600;
const MAX_SINGLE_CONTEXT_MESSAGE_CHARS: usize = 2_000;

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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChatGenerateStreamRequest {
    pub request_id: String,
    pub prompt: String,
    #[serde(default)]
    pub context: Vec<ChatContextMessage>,
    #[serde(default)]
    pub max_context_chars: Option<usize>,
    pub max_tokens: u32,
    pub temperature: f64,
    pub wait_if_busy: bool,
    #[serde(default)]
    pub request_timeout_seconds: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CancelGenerationRequest {
    pub request_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatThread {
    pub thread_id: String,
    pub title: String,
    pub subtitle: String,
    pub status: String,
    pub pinned: bool,
    pub computer_session_id: String,
    pub task_id: String,
    pub updated_at: String,
    pub message_count: u32,
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
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CommitContinuationResultRequest {
    pub assistant_message: ChatMessage,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GemmaGenerateStreamRequest {
    pub prompt: String,
    pub max_tokens: u32,
    pub temperature: f64,
    pub wait_if_busy: bool,
    pub request_timeout_seconds: Option<f64>,
    pub request_id: String,
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
    let raw_context = render_context_lines(&request.context);
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

pub fn build_gemma_generate_stream_request(
    request: &ChatGenerateStreamRequest,
) -> GemmaGenerateStreamRequest {
    let prompt = build_chat_runtime_prompt(&BuildPromptRequest {
        prompt: request.prompt.clone(),
        context: request.context.clone(),
        max_context_chars: request.max_context_chars,
    })
    .runtime_prompt;

    GemmaGenerateStreamRequest {
        prompt,
        max_tokens: request.max_tokens.clamp(1, 4_096),
        temperature: request.temperature.clamp(0.0, 2.0),
        wait_if_busy: request.wait_if_busy,
        request_timeout_seconds: request.request_timeout_seconds,
        request_id: request.request_id.clone(),
    }
}

pub fn seeded_ready_message(thread_id: &str, timestamp: String) -> ChatMessage {
    ChatMessage {
        id: format!("{thread_id}_ready"),
        role: "assistant".to_string(),
        text: "Sono pronto. Scrivimi pure: rispondo con Gemma locale.".to_string(),
        timestamp,
        metadata: Some("Gemma locale".to_string()),
        metrics: None,
        feedback: None,
        saved_memory_ref: None,
        linked_task_id: None,
        linked_automation_ref: None,
        attachments: Vec::new(),
    }
}

pub fn compact_thread_title(text: &str) -> String {
    let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.chars().count() > 44 {
        format!("{}...", normalized.chars().take(41).collect::<String>())
    } else {
        normalized
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

fn render_context_lines(context: &[ChatContextMessage]) -> String {
    context
        .iter()
        .filter_map(|message| {
            let text = normalize_context_text(&message.text);
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
        format!("Contesto recente della chat:\n{compressed_context}\n\n")
    };

    [
        "Sei un assistente personale locale. Rispondi nella lingua dell'utente, in modo diretto.",
        "Il contesto recente e' stato redatto e compresso dal Desktop Gateway Rust locale con budget stile JuicePrompt.",
        "Mantieni la prima risposta compatta: 1-4 paragrafi brevi o un blocco codice essenziale.",
        "Se includi codice, usa sempre blocchi markdown fenced con linguaggio.",
        "Usa il contesto recente per risolvere riferimenti come 'un'altra', 'continua', 'quello di prima' o 'spiegamelo meglio'.",
        "",
        &context_block,
        &format!("Utente: {prompt}"),
    ]
    .join("\n")
}

fn normalize_context_text(text: &str) -> String {
    let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
    clamp_end(&normalized, MAX_SINGLE_CONTEXT_MESSAGE_CHARS)
}

fn role_label(role: &ChatContextRole) -> &'static str {
    match role {
        ChatContextRole::User => "Utente",
        ChatContextRole::Assistant => "Assistente",
        ChatContextRole::System => "Sistema",
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
    fn prompt_builder_keeps_recent_context_for_followups() {
        let response = build_chat_runtime_prompt(&BuildPromptRequest {
            prompt: "dimmene un'altra".to_string(),
            context: vec![
                ChatContextMessage {
                    role: ChatContextRole::User,
                    text: "dimmi una barzelletta".to_string(),
                },
                ChatContextMessage {
                    role: ChatContextRole::Assistant,
                    text: "Perche' gli scienziati preferiscono gli occhielli?".to_string(),
                },
            ],
            max_context_chars: Some(1_000),
        });

        assert!(
            response
                .runtime_prompt
                .contains("Contesto recente della chat")
        );
        assert!(
            response
                .runtime_prompt
                .contains("Utente: dimmi una barzelletta")
        );
        assert!(
            response
                .runtime_prompt
                .contains("Assistente: Perche' gli scienziati")
        );
        assert!(response.runtime_prompt.contains("Utente: dimmene un'altra"));
    }

    #[test]
    fn prompt_builder_redacts_sensitive_context_before_returning_to_renderer() {
        let response = build_chat_runtime_prompt(&BuildPromptRequest {
            prompt: "riprendi da qui".to_string(),
            context: vec![ChatContextMessage {
                role: ChatContextRole::User,
                text: "la mia email e' fabio@example.com token=sk-secret".to_string(),
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
                        text: format!("messaggio vecchio numero {index} con molto testo ripetuto"),
                    },
                    ChatContextMessage {
                        role: ChatContextRole::Assistant,
                        text: format!("risposta vecchia numero {index} con dettagli ripetuti"),
                    },
                ]
            })
            .collect::<Vec<_>>();

        let response = build_chat_runtime_prompt(&BuildPromptRequest {
            prompt: "continua".to_string(),
            context,
            max_context_chars: Some(500),
        });

        assert!(response.compression.compressed);
        assert!(response.runtime_prompt.contains("Earlier context"));
        assert!(response.runtime_prompt.contains("Utente: continua"));
        assert!(response.compression.output_chars <= 500);
    }

    #[test]
    fn generate_stream_request_builds_runtime_payload_with_budgeted_context() {
        let payload = build_gemma_generate_stream_request(&ChatGenerateStreamRequest {
            request_id: "req_1".to_string(),
            prompt: "dimmene un'altra".to_string(),
            context: vec![ChatContextMessage {
                role: ChatContextRole::Assistant,
                text: "Perche' gli scienziati preferiscono gli occhielli?".to_string(),
            }],
            max_context_chars: Some(1_000),
            max_tokens: 9_999,
            temperature: 9.0,
            wait_if_busy: true,
            request_timeout_seconds: Some(120.0),
        });

        assert_eq!(payload.request_id, "req_1");
        assert_eq!(payload.max_tokens, 4_096);
        assert_eq!(payload.temperature, 2.0);
        assert!(payload.prompt.contains("Contesto recente della chat"));
        assert!(payload.prompt.contains("Utente: dimmene un'altra"));
    }
}
