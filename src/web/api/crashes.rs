//! Crash reports API (OBS-3).
//!
//! Exposes CRUD operations on the `~/.homun/crashes/` directory written by
//! the panic hook, plus a "prepare-issue" endpoint that returns the 4
//! submission formats the UI can offer (clipboard markdown, download blob,
//! pre-filled GitHub issue URL, mailto URL). Each format is gated by its
//! own `[support]` config flag so the maintainer can enable/disable them
//! independently as the split-repo migration or email setup progresses.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::Json;
use axum::routing::get;
use axum::Router;
use serde::Serialize;

use crate::crash_reporter::{self, CrashReport};
use crate::web::server::AppState;

pub(super) fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/v1/crashes", get(list_crashes))
        .route("/v1/crashes/{id}", get(get_crash).delete(delete_crash))
        .route("/v1/crashes/{id}/formats", get(prepare_submission_formats))
}

// ─── List ───────────────────────────────────────────────────────

#[derive(Serialize)]
struct CrashListEntry {
    filename: String,
    timestamp: String,
    trace_id: String,
    message_preview: String,
    version: String,
    os: String,
}

#[derive(Serialize)]
struct CrashListResponse {
    count: usize,
    crashes: Vec<CrashListEntry>,
}

async fn list_crashes() -> Json<CrashListResponse> {
    let files = crash_reporter::list_crash_files();
    let mut crashes = Vec::with_capacity(files.len());

    for (filename, _) in files {
        if let Some(report) = crash_reporter::read_crash(&filename) {
            crashes.push(CrashListEntry {
                filename: filename.clone(),
                timestamp: report.timestamp,
                trace_id: report.trace_id,
                message_preview: preview(&report.message, 120),
                version: report.version.to_string(),
                os: report.os.to_string(),
            });
        }
    }

    Json(CrashListResponse {
        count: crashes.len(),
        crashes,
    })
}

// ─── Get one ────────────────────────────────────────────────────

async fn get_crash(Path(id): Path<String>) -> Result<Json<CrashReport>, StatusCode> {
    crash_reporter::read_crash(&id)
        .map(Json)
        .ok_or(StatusCode::NOT_FOUND)
}

// ─── Delete one ─────────────────────────────────────────────────

async fn delete_crash(Path(id): Path<String>) -> Result<Json<super::OkResponse>, StatusCode> {
    crash_reporter::delete_crash(&id)
        .map(|_| {
            Json(super::OkResponse {
                ok: true,
                message: None,
            })
        })
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::InvalidInput => StatusCode::BAD_REQUEST,
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        })
}

// ─── Prepare submission formats ─────────────────────────────────

/// Response body for `GET /v1/crashes/{id}/formats`.
///
/// Each field is `None` if the corresponding submission channel is
/// disabled in `[support]` config. The UI uses `Option::is_some()` to
/// decide which buttons to show.
#[derive(Serialize)]
struct SubmissionFormats {
    /// Markdown-formatted crash summary suitable for clipboard paste.
    /// Always `Some(...)` when `crash_submit_clipboard = true`.
    #[serde(skip_serializing_if = "Option::is_none")]
    clipboard_markdown: Option<String>,
    /// Relative URL to the full JSON file. Always `Some("/api/v1/crashes/<id>")`
    /// when `crash_submit_download = true`.
    #[serde(skip_serializing_if = "Option::is_none")]
    download_url: Option<String>,
    /// Pre-filled GitHub "New Issue" URL pointing at `support.public_repo`.
    /// `Some(...)` when both `crash_submit_github = true` and `public_repo`
    /// is non-empty.
    #[serde(skip_serializing_if = "Option::is_none")]
    github_issue_url: Option<String>,
    /// `mailto:` URL with pre-filled subject + body.
    /// `Some(...)` when both `crash_submit_email = true` and `email` is set.
    #[serde(skip_serializing_if = "Option::is_none")]
    mailto_url: Option<String>,
}

async fn prepare_submission_formats(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<SubmissionFormats>, StatusCode> {
    let report = crash_reporter::read_crash(&id).ok_or(StatusCode::NOT_FOUND)?;
    let cfg = state.config.read().await;
    let support = &cfg.support;

    let markdown = build_markdown(&report);

    let clipboard_markdown = if support.crash_submit_clipboard {
        Some(markdown.clone())
    } else {
        None
    };

    let download_url = if support.crash_submit_download {
        Some(format!("/api/v1/crashes/{}", id))
    } else {
        None
    };

    let github_issue_url = if support.crash_submit_github && !support.public_repo.is_empty() {
        Some(build_github_issue_url(&support.public_repo, &report, &markdown))
    } else {
        None
    };

    let mailto_url = if support.crash_submit_email && !support.email.is_empty() {
        Some(build_mailto_url(&support.email, &report, &markdown))
    } else {
        None
    };

    Ok(Json(SubmissionFormats {
        clipboard_markdown,
        download_url,
        github_issue_url,
        mailto_url,
    }))
}

// ─── Format builders ────────────────────────────────────────────

fn preview(s: &str, max_len: usize) -> String {
    if s.chars().count() <= max_len {
        s.to_string()
    } else {
        let truncated: String = s.chars().take(max_len).collect();
        format!("{}…", truncated)
    }
}

/// Build the markdown body shared by clipboard + GitHub issue + email.
///
/// Mirrors the layout of a well-formed bug report: a header summary, a
/// metadata table, a collapsible backtrace, and a collapsible recent-logs
/// tail. The recent logs are included verbatim as JSON lines because they
/// already passed through the exfiltration redactor when the crash file
/// was written — re-redacting here would be pointless double work.
fn build_markdown(report: &CrashReport) -> String {
    let mut out = String::with_capacity(4096);
    out.push_str("## Crash report\n\n");
    out.push_str(&format!("**Message**: `{}`\n\n", report.message));
    if let Some(loc) = &report.location {
        out.push_str(&format!("**Location**: `{}`\n\n", loc));
    }
    out.push_str("**Environment**\n\n");
    out.push_str("| Field | Value |\n");
    out.push_str("|---|---|\n");
    out.push_str(&format!("| Version | `{}` |\n", report.version));
    out.push_str(&format!("| OS | `{}` |\n", report.os));
    out.push_str(&format!("| Arch | `{}` |\n", report.arch));
    out.push_str(&format!("| Timestamp | `{}` |\n", report.timestamp));
    out.push_str(&format!("| Trace ID | `{}` |\n", report.trace_id));
    out.push('\n');

    out.push_str("<details><summary>Backtrace</summary>\n\n```\n");
    out.push_str(&report.backtrace);
    out.push_str("\n```\n\n</details>\n\n");

    out.push_str(&format!(
        "<details><summary>Recent log records ({})</summary>\n\n```json\n",
        report.recent_logs.len()
    ));
    for rec in &report.recent_logs {
        if let Ok(line) = serde_json::to_string(rec) {
            out.push_str(&line);
            out.push('\n');
        }
    }
    out.push_str("```\n\n</details>\n");
    out
}

fn build_github_issue_url(repo: &str, report: &CrashReport, body: &str) -> String {
    let title = format!(
        "Crash v{} on {} — {}",
        report.version,
        report.os,
        preview(&report.message, 60)
    );
    format!(
        "https://github.com/{}/issues/new?title={}&body={}&labels=crash",
        repo,
        percent_encode(&title),
        percent_encode(body)
    )
}

fn build_mailto_url(email: &str, report: &CrashReport, body: &str) -> String {
    let subject = format!(
        "[Homun] Crash v{} on {} — {}",
        report.version,
        report.os,
        preview(&report.message, 60)
    );
    format!(
        "mailto:{}?subject={}&body={}",
        email,
        percent_encode(&subject),
        percent_encode(body)
    )
}

/// Percent-encode a string for use in URL query values.
///
/// Implements RFC 3986 unreserved + `-_.~` passthrough, everything else
/// becomes `%XX`. Covers the subset needed for GitHub issue URLs and
/// `mailto:` subjects/bodies. Avoids pulling in `urlencoding` or
/// `percent-encoding` as dedicated deps (both are dormant anyway in
/// Homun's dep tree, so adding one means a fresh compile dependency).
fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for byte in s.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{:02X}", byte));
        }
    }
    out
}

// ─── Tests ──────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_report() -> CrashReport {
        CrashReport {
            timestamp: "2026-04-14T12:34:56Z".to_string(),
            trace_id: "abc12345".to_string(),
            version: "0.1.0".to_string(),
            os: "macos".to_string(),
            arch: "aarch64".to_string(),
            message: "index out of bounds: the len is 3 but the index is 5".to_string(),
            location: Some("src/foo.rs:42:13".to_string()),
            backtrace: "   0: foo\n   1: bar".to_string(),
            recent_logs: vec![],
        }
    }

    #[test]
    fn markdown_contains_all_required_fields() {
        let md = build_markdown(&sample_report());
        assert!(md.contains("## Crash report"));
        assert!(md.contains("**Message**"));
        assert!(md.contains("index out of bounds"));
        assert!(md.contains("**Location**"));
        assert!(md.contains("src/foo.rs:42:13"));
        assert!(md.contains("| Version | `0.1.0` |"));
        assert!(md.contains("| OS | `macos` |"));
        assert!(md.contains("| Arch | `aarch64` |"));
        assert!(md.contains("| Trace ID | `abc12345` |"));
        assert!(md.contains("<details><summary>Backtrace</summary>"));
        assert!(md.contains("<details><summary>Recent log records"));
    }

    #[test]
    fn github_issue_url_well_formed() {
        let url = build_github_issue_url("homun-app/homun", &sample_report(), "body");
        assert!(url.starts_with("https://github.com/homun-app/homun/issues/new?"));
        assert!(url.contains("title="));
        assert!(url.contains("body="));
        assert!(url.contains("labels=crash"));
        // Title contains version and platform
        assert!(url.contains("Crash%20v0.1.0"));
        assert!(url.contains("macos"));
    }

    #[test]
    fn mailto_url_well_formed() {
        let url = build_mailto_url("dev@homun.app", &sample_report(), "body");
        assert!(url.starts_with("mailto:dev@homun.app?"));
        assert!(url.contains("subject="));
        assert!(url.contains("body="));
        assert!(url.contains("%5BHomun%5D%20Crash")); // [Homun] Crash URL-encoded
    }

    #[test]
    fn preview_handles_unicode() {
        // Character count, not byte count — multibyte chars don't split.
        let s = "Héllo wörld! 🌍";
        assert_eq!(preview(s, 5), "Héllo…");
        assert_eq!(preview(s, 100), s);
    }

    #[test]
    fn preview_exact_length_no_ellipsis() {
        assert_eq!(preview("hello", 5), "hello");
        assert_eq!(preview("hello", 6), "hello");
    }

    #[test]
    fn percent_encode_matches_rfc3986_unreserved() {
        // ASCII alphanumerics and -_.~ pass through unchanged.
        assert_eq!(percent_encode("abcDEF123"), "abcDEF123");
        assert_eq!(percent_encode("-_.~"), "-_.~");
        // Space and special chars get percent-escaped.
        assert_eq!(percent_encode(" "), "%20");
        assert_eq!(percent_encode("a b"), "a%20b");
        assert_eq!(percent_encode("["), "%5B");
        assert_eq!(percent_encode("]"), "%5D");
        assert_eq!(percent_encode("/"), "%2F");
        assert_eq!(percent_encode("?"), "%3F");
        assert_eq!(percent_encode("&"), "%26");
        assert_eq!(percent_encode("="), "%3D");
        assert_eq!(percent_encode("#"), "%23");
    }

    #[test]
    fn percent_encode_handles_multibyte_utf8() {
        // UTF-8 multi-byte sequences are encoded byte-by-byte.
        // "é" = U+00E9 = 0xC3 0xA9 in UTF-8 → %C3%A9
        assert_eq!(percent_encode("é"), "%C3%A9");
        // 🌍 = U+1F30D = 0xF0 0x9F 0x8C 0x8D → %F0%9F%8C%8D
        assert_eq!(percent_encode("🌍"), "%F0%9F%8C%8D");
    }
}
