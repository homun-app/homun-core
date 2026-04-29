//! Tool for displaying workspace files inline to the user.
//!
//! Complements `write_file` (which emits a preview block on creation) and
//! `send_file` (which delivers files as channel attachments on
//! Telegram/WhatsApp/Discord/Email). `view_file` is the "show the user this
//! existing file" tool: it emits a `ResultBlock` that the web UI renders as
//! a View + Download card, opening a modal with smart rendering per file
//! type — CSV as a table, PDF inline, images, JSON/markdown/code with
//! syntax highlighting, plain text in a `<pre>`.
//!
//! The dedicated tool name is what makes this usable: without it, small
//! models pick `read_file` (raw byte dump) when the user asks "show me the
//! CSV", producing an unreadable text wall instead of a rendered table.
//! The description teaches the cognition engine to route "show/view/display"
//! intents here.

use anyhow::Result;
use async_trait::async_trait;
use serde_json::Value;

use super::registry::{get_string_param, Tool, ToolContext, ToolResult};

/// Tool that displays a workspace file inline in the chat UI with a
/// rich preview modal (CSV as table, PDF, images, code, markdown).
pub struct ViewFileTool;

impl ViewFileTool {
    pub fn new() -> Self {
        Self
    }
}

impl Default for ViewFileTool {
    fn default() -> Self {
        Self::new()
    }
}

/// Resolve a filename or path against the workspace directory.
///
/// Mirrors `send_file::resolve_workspace_file` to keep the two tools
/// behaviorally symmetric: both accept absolute paths, paths relative
/// to the workspace, and bare filenames.
fn resolve_workspace_file(raw: &str) -> Option<std::path::PathBuf> {
    let workspace = crate::config::Config::data_dir().join("workspace");
    let candidates = [
        std::path::PathBuf::from(raw),
        workspace.join(raw),
        workspace.join(std::path::Path::new(raw).file_name().unwrap_or_default()),
    ];
    for candidate in &candidates {
        if candidate.exists() && candidate.is_file() {
            return Some(candidate.clone());
        }
    }
    None
}

#[async_trait]
impl Tool for ViewFileTool {
    fn name(&self) -> &str {
        "view_file"
    }

    fn description(&self) -> &str {
        "Display a workspace file to the user with an interactive inline preview. \
         Opens a modal with smart rendering per file type: CSV as a table, PDF inline, \
         images, JSON/markdown/code with syntax highlighting, plain text otherwise. \
         Use this when the user asks to 'show', 'view', 'display', 'preview', \
         'mostrami', 'visualizza', 'fammi vedere', 'apri' a file that already exists \
         in the workspace. Does NOT dump raw bytes into the chat — that's what read_file \
         does for internal inspection. Does NOT deliver a file as an attachment on \
         Telegram/WhatsApp/Email — that's what send_file does. view_file is the right \
         choice on the web UI for any 'show me this file' intent."
    }

    fn parameters(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "file": {
                    "type": "string",
                    "description": "Filename or path of the workspace file to display \
                                    (e.g. 'diesel_shops.csv', 'report.pdf', 'notes.md'). \
                                    Resolved against the workspace directory."
                }
            },
            "required": ["file"]
        })
    }

    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<ToolResult> {
        let raw_file = get_string_param(&args, "file")?;

        // Resolve path
        let path = match super::file::resolve_profile_brain_alias(&raw_file, ctx)
            .filter(|path| path.exists() && path.is_file())
            .or_else(|| resolve_workspace_file(&raw_file))
        {
            Some(p) => p,
            None => {
                return Ok(ToolResult::error(format!(
                    "File not found: '{raw_file}'. Make sure the file exists in the workspace \
                     (use write_file to create it, or list_dir to discover existing files)."
                )));
            }
        };

        let is_profile_brain_file = ctx
            .profile_brain_dir
            .as_ref()
            .is_some_and(|dir| path.starts_with(dir));
        if is_profile_brain_file {
            return match tokio::fs::read_to_string(&path).await {
                Ok(content) => Ok(ToolResult::success(format!(
                    "{}\n\n{}",
                    path.display(),
                    content
                ))),
                Err(e) => Ok(ToolResult::error(format!(
                    "Failed to read file '{raw_file}': {e}"
                ))),
            };
        }

        // Read file size for the block
        let size_bytes = match tokio::fs::metadata(&path).await {
            Ok(meta) => meta.len() as usize,
            Err(e) => {
                return Ok(ToolResult::error(format!(
                    "Failed to stat file '{raw_file}': {e}"
                )));
            }
        };

        // Build the ResultBlock using the shared helper from file.rs.
        // The frontend's response-blocks.js detects the "Download" field
        // and attaches View + Download buttons that open the file modal.
        let block = super::file::build_workspace_file_block(&path, size_bytes);

        build_channel_aware_result(&ctx.channel, &raw_file, &path, size_bytes, block)
    }
}

/// Channel identifiers that render ResponseBlocks as native UI cards
/// (modal preview, inline table/PDF/image rendering).
///
/// Kept as a small allowlist rather than a capability flag because this
/// is a UI concern, not a channel protocol concern — adding "flutter" or
/// "mobile" here is a conscious UX decision per client, not a side-effect
/// of channel capabilities.
fn supports_rich_blocks(channel: &str) -> bool {
    matches!(channel, "web" | "flutter" | "mobile")
}

/// Compose the ToolResult for a resolved workspace file, adapting the
/// output to what the current channel can actually deliver.
///
/// Three cases:
///
/// 1. **Rich-block channel (web / flutter / mobile)** — return the
///    `ResultBlock` directly. The client renders View + Download buttons
///    that open a modal with smart per-format preview (CSV as table,
///    PDF inline, images, code with highlight, markdown rendered).
///
/// 2. **Attachment-capable channel** (telegram, whatsapp, discord,
///    slack, email) — no inline preview is possible, but the channel
///    *can* deliver the file as a native attachment. We return a
///    success result whose text tells the model that this file exists
///    and that it should offer the user to receive it via `send_file`.
///    The model then surfaces the offer to the user ("posso inviarti il
///    file come allegato, vuoi riceverlo?"). This is the soft-delegation
///    pattern: we don't auto-send (respects user autonomy on large
///    files / sensitive data) but we make the next-step action discoverable.
///
/// 3. **Text-only channel (cli, or unknown)** — no inline preview AND
///    no attachment delivery. Return the absolute file path so the user
///    can open it manually from their file manager / terminal.
fn build_channel_aware_result(
    channel: &str,
    raw_file: &str,
    path: &std::path::Path,
    size_bytes: usize,
    block: Option<crate::tools::response_blocks::ResponseBlock>,
) -> Result<ToolResult> {
    let size = crate::tools::file::format_file_size(size_bytes);

    // Case 1: rich-block UI — emit the block, frontend handles everything.
    if supports_rich_blocks(channel) {
        return match block {
            Some(b) => Ok(ToolResult::with_blocks(
                format!("Showing '{raw_file}' ({size}) in the chat."),
                vec![b],
            )),
            None => Ok(ToolResult::error(format!(
                "File '{raw_file}' is outside the workspace directory. \
                 view_file only works for files under ~/.homun/workspace/."
            ))),
        };
    }

    // Case 2 / 3: no inline preview — decide based on channel capabilities.
    let caps = crate::channels::capabilities_for(channel);

    if caps.outbound_attachments {
        // The channel can deliver the file — tell the model to offer it.
        // Text is written as an instruction to the LLM, not user-facing
        // copy: the model will rephrase naturally in the user's language.
        Ok(ToolResult::success(format!(
            "File '{raw_file}' ({size}) exists and is ready. \
             This channel ('{channel}') cannot render an inline preview, \
             but it CAN deliver the file as a native attachment. \
             Offer the user the option to receive '{raw_file}' as an \
             attachment — if they confirm, call the `send_file` tool with \
             file='{raw_file}'. Do not auto-send without confirmation."
        )))
    } else {
        // No preview, no attachment — best we can do is point to the file.
        Ok(ToolResult::success(format!(
            "File '{raw_file}' ({size}) exists at {}. \
             This channel ('{channel}') supports neither inline preview \
             nor file attachments. Tell the user the file is ready and \
             share the absolute path so they can open it manually.",
            path.display()
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_ctx(channel: &str) -> ToolContext {
        ToolContext {
            workspace: "/tmp".to_string(),
            channel: channel.to_string(),
            chat_id: "test".to_string(),
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
    fn view_file_tool_has_descriptive_name_and_keywords() {
        let tool = ViewFileTool::new();
        assert_eq!(tool.name(), "view_file");
        let desc = tool.description();
        // The description must explicitly teach the cognition engine the
        // intents it covers — this is what steers the model away from
        // read_file for "show me" requests.
        assert!(desc.contains("show"));
        assert!(desc.contains("view"));
        assert!(desc.contains("mostrami"));
        // And explicitly distinguish from the two neighbouring tools.
        assert!(desc.contains("read_file"));
        assert!(desc.contains("send_file"));
    }

    #[test]
    fn view_file_parameters_require_file() {
        let tool = ViewFileTool::new();
        let params = tool.parameters();
        let required = params["required"].as_array().unwrap();
        assert!(required.contains(&serde_json::json!("file")));
    }

    #[tokio::test]
    async fn view_file_reports_missing_file_clearly() {
        let tool = ViewFileTool::new();
        let args = serde_json::json!({"file": "definitely_not_a_real_file_xyz.csv"});
        let result = tool.execute(args, &test_ctx("web")).await.unwrap();
        assert!(result.is_error);
        assert!(result.output.contains("not found"));
        // The error must steer the model toward recovery actions.
        assert!(result.output.contains("write_file") || result.output.contains("list_dir"));
    }

    #[test]
    fn supports_rich_blocks_matches_expected_channels() {
        assert!(supports_rich_blocks("web"));
        assert!(supports_rich_blocks("flutter"));
        assert!(supports_rich_blocks("mobile"));
        assert!(!supports_rich_blocks("telegram"));
        assert!(!supports_rich_blocks("cli"));
        assert!(!supports_rich_blocks(""));
    }

    /// The attachment-capable fallback must tell the model to OFFER
    /// send_file, not auto-invoke it. This protects users on mobile data
    /// from surprise downloads and respects the cognition-first pattern.
    #[test]
    fn attachment_capable_channel_returns_offer_text() {
        let block = None; // Doesn't matter for this path
        let result = build_channel_aware_result(
            "telegram",
            "report.pdf",
            std::path::Path::new("/tmp/report.pdf"),
            2048,
            block,
        )
        .unwrap();
        assert!(!result.is_error);
        let text = &result.output;
        // Must name the tool to call and explicitly forbid auto-send.
        assert!(text.contains("send_file"));
        assert!(text.contains("confirm") || text.contains("Offer"));
        assert!(text.contains("Do not auto-send"));
        // Must include the filename so the model can pass it through.
        assert!(text.contains("report.pdf"));
        // No rich block rendered on non-rich channels.
        assert!(result.blocks.is_empty());
    }

    /// Text-only channels (cli) can't preview or send files. The only
    /// actionable output is the absolute path — test that it's present.
    #[test]
    fn text_only_channel_exposes_absolute_path() {
        let result = build_channel_aware_result(
            "cli",
            "notes.md",
            std::path::Path::new("/Users/me/.homun/workspace/notes.md"),
            512,
            None,
        )
        .unwrap();
        assert!(!result.is_error);
        assert!(result
            .output
            .contains("/Users/me/.homun/workspace/notes.md"));
        assert!(result.output.contains("cli"));
        assert!(result.blocks.is_empty());
    }

    /// Rich-block channels must return the block when one is available
    /// (i.e. the file is under the workspace) and an error otherwise.
    #[test]
    fn rich_block_channel_emits_block_when_inside_workspace() {
        use crate::tools::response_blocks::{ResponseBlock, ResultBlock};
        let fake_block = ResponseBlock::Result(ResultBlock {
            id: "test".to_string(),
            title: "t".to_string(),
            fields: vec![],
            icon: None,
        });
        let result = build_channel_aware_result(
            "web",
            "data.csv",
            std::path::Path::new("/tmp/data.csv"),
            100,
            Some(fake_block),
        )
        .unwrap();
        assert!(!result.is_error);
        assert_eq!(result.blocks.len(), 1);
    }

    #[test]
    fn rich_block_channel_errors_when_block_missing() {
        let result = build_channel_aware_result(
            "web",
            "escaped.txt",
            std::path::Path::new("/tmp/escaped.txt"),
            10,
            None,
        )
        .unwrap();
        assert!(result.is_error);
        assert!(result.output.contains("workspace"));
    }
}
