# Document Conversion Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an internal `convert_document` tool so the agent can convert Markdown documents into HTML or PDF files locally, then deliver them with existing file sending flows.

**Architecture:** Add a focused `src/tools/document_conversion.rs` module that validates workspace paths, renders Markdown with `pulldown-cmark`, writes HTML directly, and renders PDF through a local headless browser/CLI engine when available. Register the tool in the built-in registry and extend the email channel to attach `OutboundMessage.file_path`.

**Tech Stack:** Rust, existing `Tool` trait, `pulldown-cmark`, `tokio::process::Command`, `lettre` multipart attachments.

---

### Task 1: Document Conversion Tool

**Files:**
- Create: `src/tools/document_conversion.rs`
- Modify: `src/tools/mod.rs`
- Modify: `src/tools/bootstrap.rs`

- [ ] **Step 1: Write failing tests**

Add tests in `src/tools/document_conversion.rs` covering:

```rust
#[tokio::test]
async fn converts_markdown_to_html_file() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("report.md");
    tokio::fs::write(&source, "# Report\n\n**Ready**").await.unwrap();

    let tool = DocumentConversionTool::new(Some(dir.path().to_path_buf()));
    let ctx = test_ctx(dir.path());
    let result = tool.execute(serde_json::json!({
        "source_path": source.to_string_lossy(),
        "target_format": "html"
    }), &ctx).await.unwrap();

    assert!(!result.is_error, "{}", result.output);
    let html_path = dir.path().join("report.html");
    let html = tokio::fs::read_to_string(html_path).await.unwrap();
    assert!(html.contains("<h1>Report</h1>"));
    assert!(html.contains("<strong>Ready</strong>"));
}
```

- [ ] **Step 2: Run test to verify RED**

Run: `cargo test tools::document_conversion::tests::converts_markdown_to_html_file --features gateway`

Expected: FAIL because `document_conversion` does not exist.

- [ ] **Step 3: Implement minimal tool**

Create `DocumentConversionTool` with:
- `name() == "convert_document"`
- parameters: `source_path`, `target_format`, optional `output_path`, optional `title`
- supported formats: `html`, `pdf`
- default output extension based on source stem
- workspace/path permission check reused from file tool helpers
- Markdown rendering via `pulldown_cmark::Parser` and `html::push_html`
- HTML output writes styled standalone HTML
- PDF output writes intermediate HTML and tries local engines in order: Chrome/Chromium headless, `wkhtmltopdf`, `pandoc`
- missing PDF engine returns an error that includes the HTML path

- [ ] **Step 4: Register exports and registry**

Add `pub mod document_conversion;` and `pub use document_conversion::DocumentConversionTool;` in `src/tools/mod.rs`.

Register in `src/tools/bootstrap.rs` with the same workspace restriction as file tools:

```rust
registry.register(Box::new(DocumentConversionTool::with_permissions(
    allowed_dir.clone(),
    permissions.clone(),
)));
```

- [ ] **Step 5: Verify GREEN**

Run: `cargo test tools::document_conversion --features gateway`

Expected: tests pass.

### Task 2: Email Attachments

**Files:**
- Modify: `src/channels/email.rs`

- [ ] **Step 1: Write failing test**

Add a unit test that builds an email from an `OutboundMessage` with `file_path: Some(...)` and asserts the generated MIME message contains a named attachment.

- [ ] **Step 2: Run test to verify RED**

Run: `cargo test channels::email::tests::builds_email_with_attachment --features channel-email`

Expected: FAIL because SMTP email currently builds only a plain singlepart body.

- [ ] **Step 3: Extract message builder**

Refactor email construction into a pure helper:

```rust
#[cfg(feature = "channel-email")]
fn build_email_message(config: &EmailAccountConfig, msg: &OutboundMessage) -> Result<Message>
```

If `msg.file_path` is `Some`, build a `MultiPart::mixed()` with body plus `Attachment::new(filename).body(bytes, content_type)`.

- [ ] **Step 4: Wire SMTP sender**

Change `send_email_account` to call `build_email_message(config, msg)` before sending.

- [ ] **Step 5: Verify GREEN**

Run: `cargo test channels::email::tests::builds_email_with_attachment --features channel-email`

Expected: test passes.

### Task 3: Final Verification

**Files:**
- All changed files.

- [ ] **Step 1: Run focused tests**

Run: `cargo test tools::document_conversion --features gateway`

Expected: pass.

Run: `cargo test channels::email::tests::builds_email_with_attachment --features channel-email`

Expected: pass.

- [ ] **Step 2: Run compile check**

Run: `cargo check --features gateway`

Expected: pass.

- [ ] **Step 3: Inspect diff**

Run: `git diff -- src/tools/document_conversion.rs src/tools/mod.rs src/tools/bootstrap.rs src/channels/email.rs docs/superpowers/plans/2026-05-05-document-conversion-tools.md`

Expected: only scoped conversion-tool and email-attachment changes.
