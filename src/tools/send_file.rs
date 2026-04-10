//! Tool for sending workspace files to users via messaging channels.
//!
//! Dedicated file-sending tool with a clear name and description so that
//! any LLM — even smaller models — understands it can send documents.
//! Delegates to the same OutboundMessage pipeline as `send_message`.

use anyhow::Result;
use async_trait::async_trait;
use serde_json::Value;

use crate::bus::OutboundMessage;
use crate::channels::capabilities_for;

use super::registry::{get_optional_string, get_string_param, Tool, ToolContext, ToolResult};

/// Tool that sends a workspace file to the user on a messaging channel.
///
/// The file is delivered as a document attachment (e.g. Telegram send_document).
/// An optional caption message accompanies the file.
pub struct SendFileTool;

impl SendFileTool {
    pub fn new() -> Self {
        Self
    }
}

/// Resolve a file path against the workspace directory.
///
/// Tries multiple strategies: absolute, relative to workspace, filename-only.
fn resolve_workspace_file(raw: &str) -> Option<String> {
    let workspace = crate::config::Config::data_dir().join("workspace");
    let candidates = [
        std::path::PathBuf::from(raw),
        workspace.join(raw),
        workspace.join(std::path::Path::new(raw).file_name().unwrap_or_default()),
    ];
    for candidate in &candidates {
        if candidate.exists() && candidate.is_file() {
            tracing::debug!(
                raw = %raw,
                resolved = %candidate.display(),
                "Resolved file path for send_file"
            );
            return Some(candidate.to_string_lossy().to_string());
        }
    }
    None
}

#[async_trait]
impl Tool for SendFileTool {
    fn name(&self) -> &str {
        "send_file"
    }

    fn description(&self) -> &str {
        "Send a file to the user as a document attachment on Telegram, WhatsApp, Discord, \
         or other channels. Use this when the user asks you to send, share, or deliver a file. \
         The file must exist in the workspace (created by write_file or other tools)."
    }

    fn parameters(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "file": {
                    "type": "string",
                    "description": "Filename or path of the workspace file to send (e.g. 'coworking_italia.csv', 'report.pdf')"
                },
                "caption": {
                    "type": "string",
                    "description": "Optional message to accompany the file"
                },
                "channel": {
                    "type": "string",
                    "description": "Target channel: 'telegram', 'whatsapp', 'discord', 'slack', 'email'. Defaults to the channel the user wrote from."
                },
                "chat_id": {
                    "type": "string",
                    "description": "Override target chat ID. Defaults to the current chat."
                }
            },
            "required": ["file"]
        })
    }

    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<ToolResult> {
        let raw_file = get_string_param(&args, "file")?;
        let caption =
            get_optional_string(&args, "caption").unwrap_or_else(|| format!("File: {raw_file}"));
        let channel = get_optional_string(&args, "channel").unwrap_or_else(|| ctx.channel.clone());
        let explicit_chat_id = get_optional_string(&args, "chat_id");

        // Resolve file path
        let resolved = match resolve_workspace_file(&raw_file) {
            Some(p) => p,
            None => {
                return Ok(ToolResult::error(format!(
                    "File not found: '{raw_file}'. Make sure the file exists in the workspace \
                     (use write_file to create it first)."
                )));
            }
        };

        // Resolve chat_id for cross-channel sends
        let chat_id = if let Some(id) = explicit_chat_id {
            id
        } else if channel != ctx.channel {
            if let Some(defaults) = &ctx.channel_defaults {
                defaults
                    .get(&channel)
                    .cloned()
                    .unwrap_or_else(|| ctx.chat_id.clone())
            } else {
                ctx.chat_id.clone()
            }
        } else {
            ctx.chat_id.clone()
        };

        // Check if we have a message bus
        let tx = match &ctx.message_tx {
            Some(tx) => tx,
            None => {
                return Ok(ToolResult::error(
                    "Cannot send files in this context (no active channel). \
                     Try from the gateway (Telegram, WhatsApp, etc.).",
                ));
            }
        };

        // Check channel capabilities
        let caps = capabilities_for(&channel);
        if !caps.proactive_send {
            return Ok(ToolResult::error(format!(
                "Channel '{channel}' does not support sending files."
            )));
        }

        let outbound = OutboundMessage {
            channel: channel.clone(),
            chat_id: chat_id.clone(),
            content: caption,
            metadata: None,
            file_path: Some(resolved.clone()),
        };

        match tx.send(outbound).await {
            Ok(()) => {
                tracing::info!(
                    channel = %channel,
                    chat_id = %chat_id,
                    file = %resolved,
                    "File sent to user"
                );
                Ok(ToolResult::success(format!(
                    "File '{raw_file}' sent to {channel}."
                )))
            }
            Err(e) => {
                tracing::error!(error = %e, "Failed to send file");
                Ok(ToolResult::error(format!("Failed to deliver file: {e}")))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_ctx() -> ToolContext {
        ToolContext {
            workspace: "/tmp".to_string(),
            channel: "telegram".to_string(),
            chat_id: "123".to_string(),
            message_tx: None,
            approval_manager: None,
            skill_env: None,
            user_id: None,
            profile_id: None,
            profile_brain_dir: None,
            profile_slug: None,
            allowed_namespaces: None,
            contact_id: None,
            channel_defaults: None,
        }
    }

    #[test]
    fn test_send_file_name() {
        let tool = SendFileTool::new();
        assert_eq!(tool.name(), "send_file");
    }

    #[test]
    fn test_send_file_params_has_file() {
        let tool = SendFileTool::new();
        let params = tool.parameters();
        let required = params["required"].as_array().unwrap();
        assert!(required.contains(&serde_json::json!("file")));
    }

    #[tokio::test]
    async fn test_send_file_no_channel() {
        let tool = SendFileTool::new();
        let args = serde_json::json!({"file": "nonexistent.csv"});
        let result = tool.execute(args, &test_ctx()).await.unwrap();
        // Should fail because file doesn't exist or no channel
        assert!(result.is_error);
    }
}
