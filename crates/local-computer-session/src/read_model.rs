use crate::{
    ArtifactRecord, ArtifactSnapshot, ComputerEventRecord, ComputerSessionSnapshot,
    ComputerSurfaceSnapshot, LocalComputerSessionStore, TimelineItem, redact_text, redact_url,
};
use local_first_context_compression::{
    CompressionPolicy, ContextCompressor, ContextItem, ContextKind,
};
use serde_json::Value;
use time::OffsetDateTime;

pub struct LocalComputerReadModel<'a> {
    store: &'a LocalComputerSessionStore,
}

impl<'a> LocalComputerReadModel<'a> {
    pub fn new(store: &'a LocalComputerSessionStore) -> Self {
        Self { store }
    }

    pub fn snapshot(
        &self,
        session_id: &str,
        user_id: &str,
        workspace_id: &str,
    ) -> Result<Option<ComputerSessionSnapshot>, String> {
        let Some(session) = self.store.session(session_id, user_id, workspace_id)? else {
            return Ok(None);
        };
        let events = self
            .store
            .events_for_session(session_id, user_id, workspace_id)?;
        let artifacts = self
            .store
            .artifacts_for_session(session_id, user_id, workspace_id)?;
        let now = OffsetDateTime::now_utc();

        Ok(Some(ComputerSessionSnapshot {
            computer_session_id: session.session_id,
            task_id: session.task_id,
            workflow_id: session.workflow_id,
            user_id: session.user_id,
            workspace_id: session.workspace_id,
            status: session.status,
            active_surface: session.active_surface,
            surfaces: session
                .surfaces
                .into_iter()
                .map(|surface| ComputerSurfaceSnapshot {
                    surface: surface.surface,
                    label: surface.label,
                    status: surface.status,
                    detail_redacted: surface.detail.map(|detail| redact_text(&detail)),
                })
                .collect(),
            activity_title: redact_text(&session.title),
            activity_subtitle: redact_text(&session.subtitle),
            progress_current: session.progress_current,
            progress_total: session.progress_total,
            elapsed_seconds: (now - session.started_at).whole_seconds().max(0),
            preview_frame_ref: latest_preview_ref(&artifacts),
            current_url_redacted: latest_url(&events).map(|url| redact_url(&url)),
            terminal_excerpt_redacted: terminal_excerpt(&events),
            artifact_refs: artifacts.into_iter().map(artifact_snapshot).collect(),
            timeline: events.into_iter().map(timeline_item).collect(),
            approval_state: session.approval_state,
            takeover_state: session.takeover_state,
            risk_level: session.risk_level,
            last_error_redacted: session.last_error.map(|error| redact_text(&error)),
            updated_at: session.updated_at,
        }))
    }
}

fn timeline_item(event: ComputerEventRecord) -> TimelineItem {
    TimelineItem {
        event_id: event.event_id,
        surface: event.surface,
        kind: event.kind,
        status: event.status,
        title: redact_text(&event.title),
        subtitle_redacted: redact_text(&event.subtitle),
        markdown_redacted: event
            .payload
            .get("operational_plan_markdown")
            .and_then(Value::as_str)
            .map(redact_multiline_text),
        artifact_refs: event.artifact_refs,
        started_at: event.created_at,
        completed_at: Some(event.created_at),
        approval_required: event.approval_required,
        payload_redacted: true,
    }
}

fn redact_multiline_text(value: &str) -> String {
    value
        .lines()
        .map(redact_text)
        .collect::<Vec<_>>()
        .join("\n")
}

fn artifact_snapshot(artifact: ArtifactRecord) -> ArtifactSnapshot {
    ArtifactSnapshot {
        artifact_id: artifact.artifact_id,
        title_redacted: redact_text(&artifact.title),
        kind: artifact.kind,
        size_bytes: artifact.size_bytes,
        preview_ref: artifact.preview_ref,
        created_at: artifact.created_at,
    }
}

fn latest_preview_ref(artifacts: &[ArtifactRecord]) -> Option<String> {
    artifacts
        .iter()
        .rev()
        .find_map(|artifact| artifact.preview_ref.clone())
}

fn latest_url(events: &[ComputerEventRecord]) -> Option<String> {
    events.iter().rev().find_map(|event| {
        event
            .payload
            .get("url")
            .and_then(Value::as_str)
            .map(str::to_string)
    })
}

fn terminal_excerpt(events: &[ComputerEventRecord]) -> Vec<String> {
    let mut lines = Vec::new();
    for event in events {
        if event.kind == "computer_terminal_output" {
            if let Some(output) = event.payload.get("output").and_then(Value::as_str) {
                lines.push(output.to_string());
            }
        }
    }
    if lines.is_empty() {
        return Vec::new();
    }

    let result = ContextCompressor::default().compress(
        &ContextItem::new(ContextKind::ShellOutput, lines.join("\n")),
        &CompressionPolicy::for_kind(ContextKind::ShellOutput).with_max_chars(1_800),
    );
    let redacted_lines = result.text.lines().map(redact_text).collect::<Vec<_>>();
    let keep_from = redacted_lines.len().saturating_sub(24);
    redacted_lines.into_iter().skip(keep_from).collect()
}
