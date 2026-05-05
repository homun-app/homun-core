use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context as _, Result};
use async_trait::async_trait;
use serde_json::Value;
use tokio::process::Command;

use crate::config::PermissionsConfig;
use crate::tools::file::{check_path_permission, FileOp, PermissionResult};
use crate::tools::registry::{
    get_optional_string, get_string_param, Tool, ToolContext, ToolResult,
};

pub struct DocumentConversionTool {
    allowed_dir: Option<PathBuf>,
    permissions: Option<Arc<PermissionsConfig>>,
}

impl DocumentConversionTool {
    pub fn new(allowed_dir: Option<PathBuf>) -> Self {
        Self {
            allowed_dir,
            permissions: None,
        }
    }

    pub fn with_permissions(
        allowed_dir: Option<PathBuf>,
        permissions: Arc<PermissionsConfig>,
    ) -> Self {
        Self {
            allowed_dir,
            permissions: Some(permissions),
        }
    }
}

#[async_trait]
impl Tool for DocumentConversionTool {
    fn name(&self) -> &str {
        "convert_document"
    }

    fn description(&self) -> &str {
        "Convert workspace documents locally. Supports Markdown to HTML and Markdown to PDF. \
         Use this before send_file when the user asks for a Markdown document as a PDF or HTML file."
    }

    fn parameters(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "source_path": {
                    "type": "string",
                    "description": "Path to the source Markdown file."
                },
                "target_format": {
                    "type": "string",
                    "enum": ["html", "pdf"],
                    "description": "Output format to create."
                },
                "output_path": {
                    "type": "string",
                    "description": "Optional output path. Defaults to the source filename with the target extension."
                },
                "title": {
                    "type": "string",
                    "description": "Optional HTML document title."
                }
            },
            "required": ["source_path", "target_format"]
        })
    }

    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<ToolResult> {
        let source_raw = get_string_param(&args, "source_path")?;
        let target_format = get_string_param(&args, "target_format")?.to_ascii_lowercase();
        if !matches!(target_format.as_str(), "html" | "pdf") {
            return Ok(ToolResult::error(
                "Unsupported target_format. Use 'html' or 'pdf'.",
            ));
        }

        let source_path =
            match resolve_path_for_document(&source_raw, ctx, self.allowed_dir.as_deref()) {
                Ok(path) => path,
                Err(e) => return Ok(ToolResult::error(e)),
            };
        if let Some(result) = permission_error(
            &source_path,
            FileOp::Read,
            self.permissions.as_deref(),
            self.allowed_dir.as_deref(),
        ) {
            return Ok(result);
        }
        if !source_path.is_file() {
            return Ok(ToolResult::error(format!(
                "Source file not found: {}",
                source_path.display()
            )));
        }

        let output_path = match get_optional_string(&args, "output_path") {
            Some(raw) => match resolve_path_for_document(&raw, ctx, self.allowed_dir.as_deref()) {
                Ok(path) => path,
                Err(e) => return Ok(ToolResult::error(e)),
            },
            None => default_output_path(&source_path, &target_format),
        };
        if let Some(result) = permission_error(
            &output_path,
            FileOp::Write,
            self.permissions.as_deref(),
            self.allowed_dir.as_deref(),
        ) {
            return Ok(result);
        }

        let markdown = tokio::fs::read_to_string(&source_path)
            .await
            .with_context(|| format!("Failed to read {}", source_path.display()))?;
        let title = get_optional_string(&args, "title").unwrap_or_else(|| {
            source_path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("Document")
                .to_string()
        });
        let html = markdown_to_standalone_html(&markdown, &title);

        if target_format == "html" {
            write_output_file(&output_path, html.as_bytes()).await?;
            return Ok(ToolResult::success(format!(
                "Converted '{}' to HTML: {}",
                source_path.display(),
                output_path.display()
            )));
        }

        let html_path = output_path.with_extension("html");
        if let Some(result) = permission_error(
            &html_path,
            FileOp::Write,
            self.permissions.as_deref(),
            self.allowed_dir.as_deref(),
        ) {
            return Ok(result);
        }
        write_output_file(&html_path, html.as_bytes()).await?;
        match render_pdf_with_local_engine(&html_path, &output_path).await {
            Ok(engine) => Ok(ToolResult::success(format!(
                "Converted '{}' to PDF using {engine}: {}",
                source_path.display(),
                output_path.display()
            ))),
            Err(e) => Ok(ToolResult::error(format!(
                "Could not create PDF: {e}. HTML fallback was created at {}",
                html_path.display()
            ))),
        }
    }
}

fn resolve_path_for_document(
    raw: &str,
    ctx: &ToolContext,
    allowed_dir: Option<&Path>,
) -> std::result::Result<PathBuf, String> {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    let expanded = if let Some(stripped) = raw.strip_prefix("~/") {
        home.join(stripped)
    } else {
        let path = PathBuf::from(raw);
        if path.is_absolute() {
            path
        } else {
            PathBuf::from(&ctx.workspace).join(path)
        }
    };

    let resolved = expanded
        .canonicalize()
        .or_else(|_| -> std::io::Result<PathBuf> {
            if let Some(parent) = expanded.parent() {
                if parent.exists() {
                    return Ok(parent
                        .canonicalize()
                        .unwrap_or_else(|_| parent.to_path_buf())
                        .join(expanded.file_name().unwrap_or_default()));
                }
            }
            Ok(expanded.clone())
        })
        .map_err(|e| format!("Invalid path '{raw}': {e}"))?;

    if let Some(allowed) = allowed_dir {
        let allowed_resolved = allowed
            .canonicalize()
            .unwrap_or_else(|_| allowed.to_path_buf());
        if !resolved.starts_with(&allowed_resolved) {
            return Err(format!(
                "Path '{}' is outside allowed directories",
                resolved.display()
            ));
        }
    }

    Ok(resolved)
}

fn permission_error(
    path: &Path,
    op: FileOp,
    permissions: Option<&PermissionsConfig>,
    allowed_dir: Option<&Path>,
) -> Option<ToolResult> {
    match check_path_permission(path, op, permissions, allowed_dir) {
        PermissionResult::Allowed => None,
        PermissionResult::Denied(reason) => Some(ToolResult::error(reason)),
        PermissionResult::NeedsConfirmation(reason) => Some(ToolResult::error(format!(
            "{} (confirmation required)",
            reason
        ))),
    }
}

fn default_output_path(source: &Path, target_format: &str) -> PathBuf {
    source.with_extension(target_format)
}

async fn write_output_file(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::write(path, bytes)
        .await
        .with_context(|| format!("Failed to write {}", path.display()))
}

fn markdown_to_standalone_html(markdown: &str, title: &str) -> String {
    let parser = pulldown_cmark::Parser::new_ext(markdown, pulldown_cmark::Options::all());
    let mut body = String::new();
    pulldown_cmark::html::push_html(&mut body, parser);

    format!(
        r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{}</title>
<style>
body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; line-height: 1.55; max-width: 760px; margin: 48px auto; padding: 0 24px; color: #202124; }}
h1, h2, h3 {{ line-height: 1.2; }}
code, pre {{ font-family: "SFMono-Regular", Consolas, monospace; }}
pre {{ padding: 16px; overflow-x: auto; background: #f6f8fa; border-radius: 6px; }}
blockquote {{ border-left: 4px solid #d0d7de; margin-left: 0; padding-left: 16px; color: #57606a; }}
table {{ border-collapse: collapse; width: 100%; }}
th, td {{ border: 1px solid #d0d7de; padding: 6px 8px; }}
@page {{ margin: 20mm; }}
</style>
</head>
<body>
{}
</body>
</html>
"#,
        escape_html(title),
        body
    )
}

fn escape_html(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

async fn render_pdf_with_local_engine(html_path: &Path, pdf_path: &Path) -> Result<&'static str> {
    let engines = [
        ("google-chrome", "chrome"),
        ("chromium", "chromium"),
        ("chromium-browser", "chromium-browser"),
        ("wkhtmltopdf", "wkhtmltopdf"),
        ("pandoc", "pandoc"),
    ];

    let mut errors = Vec::new();
    for (cmd, label) in engines {
        let status = match cmd {
            "google-chrome" | "chromium" | "chromium-browser" => {
                Command::new(cmd)
                    .arg("--headless")
                    .arg("--disable-gpu")
                    .arg("--no-sandbox")
                    .arg(format!("--print-to-pdf={}", pdf_path.display()))
                    .arg(format!("file://{}", html_path.display()))
                    .status()
                    .await
            }
            "wkhtmltopdf" => {
                Command::new(cmd)
                    .arg(html_path)
                    .arg(pdf_path)
                    .status()
                    .await
            }
            "pandoc" => {
                Command::new(cmd)
                    .arg(html_path)
                    .arg("-o")
                    .arg(pdf_path)
                    .status()
                    .await
            }
            _ => unreachable!(),
        };

        match status {
            Ok(status) if status.success() && pdf_path.exists() => return Ok(label),
            Ok(status) => errors.push(format!("{cmd} exited with {status}")),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => errors.push(format!("{cmd}: {e}")),
        }
    }

    if errors.is_empty() {
        anyhow::bail!("no local PDF engine found (tried Chrome/Chromium, wkhtmltopdf, pandoc)");
    }
    anyhow::bail!("{}", errors.join("; "))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::{Tool, ToolContext};

    fn test_ctx(workspace: &std::path::Path) -> ToolContext {
        ToolContext {
            workspace: workspace.to_string_lossy().to_string(),
            channel: "cli".to_string(),
            chat_id: "local".to_string(),
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

    #[tokio::test]
    async fn converts_markdown_to_html_file() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("report.md");
        tokio::fs::write(&source, "# Report\n\n**Ready**")
            .await
            .unwrap();

        let tool = DocumentConversionTool::new(Some(dir.path().to_path_buf()));
        let result = tool
            .execute(
                serde_json::json!({
                    "source_path": source.to_string_lossy(),
                    "target_format": "html"
                }),
                &test_ctx(dir.path()),
            )
            .await
            .unwrap();

        assert!(!result.is_error, "{}", result.output);
        let html_path = dir.path().join("report.html");
        let html = tokio::fs::read_to_string(html_path).await.unwrap();
        assert!(html.contains("<h1>Report</h1>"));
        assert!(html.contains("<strong>Ready</strong>"));
    }
}
