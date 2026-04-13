use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use chrono::Utc;
use serde::{Deserialize, Serialize};

use crate::bus::StreamMessage;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebChatRunEvent {
    pub event_type: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call: Option<crate::provider::ToolCallData>,
}

/// A pending approval block stored in the run snapshot for reconnect replay.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingBlockEntry {
    /// The unique block_id matching the `ApprovalGate` registry key.
    pub block_id: String,
    /// Serialized `Vec<ResponseBlock>` JSON — the full block payload.
    pub blocks_json: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebChatRunSnapshot {
    pub run_id: String,
    pub session_key: String,
    pub status: String,
    pub user_message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effective_model: Option<String>,
    pub assistant_response: String,
    pub created_at: String,
    pub updated_at: String,
    pub events: Vec<WebChatRunEvent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Pending approval blocks awaiting user response.
    /// Present only while an approval gate is active; cleared when
    /// the gate is resolved or times out.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pending_blocks: Vec<PendingBlockEntry>,
}

#[derive(Debug, Default)]
struct WebRunStoreInner {
    runs: HashMap<String, WebChatRunSnapshot>,
    active_by_session: HashMap<String, String>,
}

#[derive(Debug, Default)]
pub struct WebRunStore {
    next_id: AtomicU64,
    inner: Mutex<WebRunStoreInner>,
}

impl WebRunStore {
    pub fn start_run(
        &self,
        session_key: &str,
        user_message: &str,
    ) -> Result<WebChatRunSnapshot, String> {
        let mut inner = self.inner.lock().expect("web run store lock poisoned");
        if let Some(run_id) = inner.active_by_session.get(session_key) {
            if let Some(run) = inner.runs.get(run_id) {
                if matches!(run.status.as_str(), "running" | "stopping") {
                    return Err("A chat run is already in progress.".to_string());
                }
            }
        }

        let run_id = format!(
            "run_{}_{}",
            Utc::now().timestamp_millis(),
            self.next_id.fetch_add(1, Ordering::Relaxed)
        );
        let now = Utc::now().to_rfc3339();
        let snapshot = WebChatRunSnapshot {
            run_id: run_id.clone(),
            session_key: session_key.to_string(),
            status: "running".to_string(),
            user_message: user_message.to_string(),
            effective_model: None,
            assistant_response: String::new(),
            created_at: now.clone(),
            updated_at: now,
            events: Vec::new(),
            error: None,
            pending_blocks: Vec::new(),
        };

        inner
            .active_by_session
            .insert(session_key.to_string(), run_id.clone());
        inner.runs.insert(run_id, snapshot.clone());

        Ok(snapshot)
    }

    pub fn active_snapshot(&self, session_key: &str) -> Option<WebChatRunSnapshot> {
        let inner = self.inner.lock().expect("web run store lock poisoned");
        let run_id = inner.active_by_session.get(session_key)?;
        inner.runs.get(run_id).cloned()
    }

    pub fn append_stream_message(
        &self,
        session_key: &str,
        msg: &StreamMessage,
    ) -> Option<WebChatRunSnapshot> {
        let mut inner = self.inner.lock().expect("web run store lock poisoned");
        let run_id = inner.active_by_session.get(session_key).cloned()?;
        let run = inner.runs.get_mut(&run_id)?;

        run.updated_at = Utc::now().to_rfc3339();
        if let Some(event_type) = &msg.event_type {
            if event_type == "model" && !msg.delta.trim().is_empty() {
                run.effective_model = Some(msg.delta.clone());
            }
            let event = WebChatRunEvent {
                event_type: event_type.clone(),
                name: msg.delta.clone(),
                tool_call: msg.tool_call_data.clone(),
            };
            // Blocks events: store as pending approval blocks for reconnect replay.
            if event_type == "blocks" {
                if let Ok(blocks) = serde_json::from_str::<Vec<serde_json::Value>>(&msg.delta) {
                    if let Some(block_id) = blocks
                        .first()
                        .and_then(|b| b.get("id"))
                        .and_then(|v| v.as_str())
                    {
                        // Avoid duplicates (same block_id re-streamed)
                        if !run.pending_blocks.iter().any(|b| b.block_id == block_id) {
                            run.pending_blocks.push(PendingBlockEntry {
                                block_id: block_id.to_string(),
                                blocks_json: msg.delta.clone(),
                            });
                        }
                    }
                }
                // Don't push blocks as a generic event — they're tracked separately
                return Some(run.clone());
            }
            // Plan events: keep only the latest snapshot (replace, don't accumulate)
            // to avoid replaying stale intermediate states on reconnect.
            if event_type == "plan" {
                if let Some(existing) = run.events.iter_mut().rev().find(|e| e.event_type == "plan")
                {
                    *existing = event;
                } else {
                    run.events.push(event);
                }
            } else {
                run.events.push(event);
            }
        } else if !msg.delta.is_empty() {
            run.assistant_response.push_str(&msg.delta);
        }
        Some(run.clone())
    }

    pub fn complete_run(
        &self,
        session_key: &str,
        final_response: &str,
    ) -> Option<WebChatRunSnapshot> {
        let mut inner = self.inner.lock().expect("web run store lock poisoned");
        let run_id = inner.active_by_session.remove(session_key)?;
        let run = inner.runs.get_mut(&run_id)?;
        run.status = "completed".to_string();
        run.assistant_response = final_response.to_string();
        run.updated_at = Utc::now().to_rfc3339();
        Some(run.clone())
    }

    /// Mark the active run as completed from within the streaming path.
    ///
    /// Called when a `StreamMessage { done: true, .. }` arrives — the
    /// assistant response has already been accumulated delta-by-delta via
    /// `append_stream_message`, so we only need to flip the status and
    /// deregister the session. This is the fix for runs that finish via
    /// pure streaming without emitting a separate `OutboundMessage`:
    /// without this, the run would stay in `running` state forever and
    /// `/api/v1/chat/run` would keep re-hydrating it on tab focus.
    ///
    /// Idempotent: if the session is already deregistered (e.g. because
    /// `complete_run` ran first from the outbound path), returns `None`.
    pub fn finalize_streaming_run(&self, session_key: &str) -> Option<WebChatRunSnapshot> {
        let mut inner = self.inner.lock().expect("web run store lock poisoned");
        let run_id = inner.active_by_session.remove(session_key)?;
        let run = inner.runs.get_mut(&run_id)?;
        run.status = "completed".to_string();
        run.updated_at = Utc::now().to_rfc3339();
        Some(run.clone())
    }

    pub fn request_stop(&self, session_key: &str) -> Option<WebChatRunSnapshot> {
        let mut inner = self.inner.lock().expect("web run store lock poisoned");
        let run_id = inner.active_by_session.get(session_key).cloned()?;
        let run = inner.runs.get_mut(&run_id)?;
        run.status = "stopping".to_string();
        run.updated_at = Utc::now().to_rfc3339();
        Some(run.clone())
    }

    pub fn clear_session(&self, session_key: &str) {
        let mut inner = self.inner.lock().expect("web run store lock poisoned");
        if let Some(run_id) = inner.active_by_session.remove(session_key) {
            inner.runs.remove(&run_id);
        }
        inner.runs.retain(|_, run| run.session_key != session_key);
    }

    /// Remove a pending approval block from the active run.
    ///
    /// Called when a gate is resolved (user clicked) or timed out, so the
    /// block is not re-streamed on subsequent reconnects.
    pub fn remove_pending_block(
        &self,
        session_key: &str,
        block_id: &str,
    ) -> Option<WebChatRunSnapshot> {
        let mut inner = self.inner.lock().expect("web run store lock poisoned");
        let run_id = inner.active_by_session.get(session_key).cloned()?;
        let run = inner.runs.get_mut(&run_id)?;
        run.pending_blocks.retain(|b| b.block_id != block_id);
        run.updated_at = Utc::now().to_rfc3339();
        Some(run.clone())
    }

    /// Mark runs that have been "running" or "stopping" for too long as
    /// "interrupted".  Prevents orphaned runs when the agent crashes or
    /// the WebSocket disconnects without a clean completion.
    /// Returns snapshots of runs that were just marked as interrupted,
    /// so the caller can persist them to the database.
    pub fn expire_stale_runs(&self, max_age_secs: u64) -> Vec<WebChatRunSnapshot> {
        let cutoff = Utc::now() - chrono::Duration::seconds(max_age_secs as i64);
        let mut inner = self.inner.lock().expect("web run store lock poisoned");
        let mut expired_keys = Vec::new();
        let mut expired_snapshots = Vec::new();
        for run in inner.runs.values_mut() {
            if matches!(run.status.as_str(), "running" | "stopping") {
                if let Ok(created) = chrono::DateTime::parse_from_rfc3339(&run.created_at) {
                    if created < cutoff {
                        run.status = "interrupted".to_string();
                        run.updated_at = Utc::now().to_rfc3339();
                        expired_keys.push(run.session_key.clone());
                        expired_snapshots.push(run.clone());
                    }
                }
            }
        }
        for key in &expired_keys {
            inner.active_by_session.remove(key);
        }
        if !expired_snapshots.is_empty() {
            tracing::info!(count = expired_snapshots.len(), "Expired stale web chat runs");
        }
        expired_snapshots
    }
}

#[cfg(test)]
mod tests {
    use super::WebRunStore;
    use crate::bus::StreamMessage;

    #[test]
    fn run_store_tracks_active_run_and_completion() {
        let store = WebRunStore::default();
        let snapshot = store.start_run("web:default", "ciao").unwrap();
        assert_eq!(snapshot.status, "running");
        assert!(store.active_snapshot("web:default").is_some());

        store.append_stream_message(
            "web:default",
            &StreamMessage {
                chat_id: "default".to_string(),
                delta: "hello".to_string(),
                done: false,
                event_type: None,
                tool_call_data: None,
            },
        );

        let active = store.active_snapshot("web:default").unwrap();
        assert_eq!(active.assistant_response, "hello");

        let done = store.complete_run("web:default", "hello world").unwrap();
        assert_eq!(done.status, "completed");
        assert!(store.active_snapshot("web:default").is_none());
    }

    /// Regression test for the tab-reload double-render bug.
    ///
    /// When a run finishes via pure streaming (no separate OutboundMessage),
    /// `finalize_streaming_run` is the only path that flips status to
    /// "completed". This test verifies:
    /// 1. The final state is `completed` with the accumulated text intact.
    /// 2. The session is deregistered so `active_snapshot` returns None.
    /// 3. The call is idempotent: a second finalize (or a complete_run
    ///    arriving late from the outbound path) is a no-op, not a panic.
    #[test]
    fn finalize_streaming_run_marks_completed_and_is_idempotent() {
        let store = WebRunStore::default();
        store.start_run("web:stream", "ciao").unwrap();

        // Simulate streaming chunks accumulating the response.
        for delta in ["Hel", "lo ", "world"] {
            store.append_stream_message(
                "web:stream",
                &StreamMessage {
                    chat_id: "stream".to_string(),
                    delta: delta.to_string(),
                    done: false,
                    event_type: None,
                    tool_call_data: None,
                },
            );
        }

        // Final chunk with `done: true` but empty delta (OpenAI-style EOF).
        store.append_stream_message(
            "web:stream",
            &StreamMessage {
                chat_id: "stream".to_string(),
                delta: String::new(),
                done: true,
                event_type: None,
                tool_call_data: None,
            },
        );

        // Stream-path finalization should mark completed without touching the
        // already-accumulated response.
        let finalized = store.finalize_streaming_run("web:stream").unwrap();
        assert_eq!(finalized.status, "completed");
        assert_eq!(finalized.assistant_response, "Hello world");
        assert!(store.active_snapshot("web:stream").is_none());

        // Second finalize is a no-op (returns None) — no panic, no state change.
        assert!(store.finalize_streaming_run("web:stream").is_none());

        // A late `complete_run` from the outbound path (race condition) is
        // also a no-op because the session was already deregistered.
        assert!(store
            .complete_run("web:stream", "should not overwrite")
            .is_none());
    }

    #[test]
    fn expire_stale_runs_marks_old_as_interrupted() {
        let store = WebRunStore::default();
        let run = store.start_run("web:stale", "old message").unwrap();
        assert_eq!(run.status, "running");

        // With max_age=0 every running run is considered stale
        let expired = store.expire_stale_runs(0);

        // Should return the expired snapshot for DB persistence
        assert_eq!(expired.len(), 1);
        assert_eq!(expired[0].status, "interrupted");

        // Run should no longer be active
        assert!(store.active_snapshot("web:stale").is_none());
        let inner = store.inner.lock().unwrap();
        let stored = inner.runs.values().next().unwrap();
        assert_eq!(stored.status, "interrupted");
    }

    #[test]
    fn plan_events_keep_only_latest() {
        let store = WebRunStore::default();
        store.start_run("web:plan", "do something").unwrap();

        // Send two plan events
        store.append_stream_message(
            "web:plan",
            &StreamMessage {
                chat_id: "plan".into(),
                delta: r#"{"objective":"step 1"}"#.into(),
                done: false,
                event_type: Some("plan".into()),
                tool_call_data: None,
            },
        );
        store.append_stream_message(
            "web:plan",
            &StreamMessage {
                chat_id: "plan".into(),
                delta: r#"{"objective":"step 2"}"#.into(),
                done: false,
                event_type: Some("plan".into()),
                tool_call_data: None,
            },
        );

        let snap = store.active_snapshot("web:plan").unwrap();
        let plan_events: Vec<_> = snap
            .events
            .iter()
            .filter(|e| e.event_type == "plan")
            .collect();
        assert_eq!(
            plan_events.len(),
            1,
            "should keep only the latest plan event"
        );
        assert!(plan_events[0].name.contains("step 2"));
    }
}
