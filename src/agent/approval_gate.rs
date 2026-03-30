//! Pause/resume approval gate for the agent loop.
//!
//! When a tool needs user approval (site access, shell command, etc.),
//! the agent loop registers a gate, streams a ChoiceBlock to the client,
//! and `await`s the user's response — pausing inline without starting a
//! new turn. The WS handler resolves the gate when the user clicks,
//! waking the agent instantly.

use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use tokio::sync::{oneshot, Mutex};

use crate::provider::StreamChunk;
use crate::tools::response_blocks::{BlockResponse, ResponseBlock};

/// Default timeout for user approval (5 minutes).
pub const DEFAULT_APPROVAL_TIMEOUT: Duration = Duration::from_secs(300);

// ─── Outcome ───────────────────────────────────────────────────

/// Result of awaiting user approval via the gate.
#[derive(Debug)]
pub enum ApprovalOutcome {
    /// User responded (approved or denied — inspect the `BlockResponse` fields).
    Responded(BlockResponse),
    /// Timeout expired before the user responded.
    Timeout,
    /// Agent stop was requested while waiting.
    Cancelled,
}

// ─── Gate Registry ─────────────────────────────────────────────

/// Global registry of pending approval oneshot channels.
///
/// The agent loop calls `register()` to create a pending gate, then
/// `await`s the returned `Receiver`. The WS handler calls `resolve()`
/// with the user's `BlockResponse`, which fires the oneshot and wakes
/// the agent loop.
#[derive(Debug)]
pub struct ApprovalGate {
    /// Pending oneshot senders keyed by block_id.
    pending: Mutex<HashMap<String, oneshot::Sender<BlockResponse>>>,
}

impl ApprovalGate {
    /// Create a new empty gate registry.
    pub fn new() -> Self {
        Self {
            pending: Mutex::new(HashMap::new()),
        }
    }

    /// Register a pending approval and return the receiver to await.
    ///
    /// The caller must stream the corresponding `ChoiceBlock` to the client
    /// before (or immediately after) calling this method.
    pub async fn register(&self, block_id: &str) -> oneshot::Receiver<BlockResponse> {
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(block_id.to_string(), tx);
        tracing::debug!(block_id, "Approval gate registered");
        rx
    }

    /// Resolve a pending approval by firing the oneshot.
    ///
    /// Returns `true` if a gate was found and resolved, `false` if no
    /// pending gate exists for this `block_id` (e.g. timeout already
    /// cleaned it up, or it's a non-gated block).
    pub async fn resolve(&self, block_id: &str, response: BlockResponse) -> bool {
        if let Some(tx) = self.pending.lock().await.remove(block_id) {
            let ok = tx.send(response).is_ok();
            if ok {
                tracing::info!(block_id, "Approval gate resolved");
            } else {
                tracing::warn!(block_id, "Approval gate resolved but receiver dropped");
            }
            ok
        } else {
            false
        }
    }

    /// Cancel a pending gate (e.g. on timeout). Drops the sender so
    /// the receiver gets a `RecvError`.
    pub async fn cancel(&self, block_id: &str) {
        if self.pending.lock().await.remove(block_id).is_some() {
            tracing::debug!(block_id, "Approval gate cancelled");
        }
    }
}

impl Default for ApprovalGate {
    fn default() -> Self {
        Self::new()
    }
}

// ─── Global Instance ───────────────────────────────────────────

static GLOBAL_GATE: OnceLock<Arc<ApprovalGate>> = OnceLock::new();

/// Get the global approval gate instance.
/// Panics if `init_approval_gate()` was not called.
pub fn approval_gate() -> Arc<ApprovalGate> {
    GLOBAL_GATE
        .get()
        .cloned()
        .expect("ApprovalGate not initialized — call init_approval_gate() at startup")
}

/// Initialize the global approval gate. Safe to call multiple times
/// (subsequent calls are no-ops).
pub fn init_approval_gate() {
    let _ = GLOBAL_GATE.set(Arc::new(ApprovalGate::new()));
}

// ─── Await Helper ──────────────────────────────────────────────

/// Stream a response block to the client, register a gate, and await
/// the user's decision with timeout and cancellation support.
///
/// This is the **single entry point** for all approval checks in the
/// agent loop. It handles the full lifecycle:
/// 1. Streams the block via `stream_tx`
/// 2. Registers a oneshot in the global gate
/// 3. `tokio::select!` on: response, timeout, stop signal
/// 4. Cleans up the gate on timeout/cancel
pub async fn await_approval(
    block: ResponseBlock,
    block_id: &str,
    stream_tx: &tokio::sync::mpsc::Sender<StreamChunk>,
    timeout: Duration,
) -> ApprovalOutcome {
    // 1. Stream the block to the client
    let blocks_json = serde_json::to_string(&vec![block]).unwrap_or_default();
    let _ = stream_tx
        .send(StreamChunk {
            delta: blocks_json,
            done: false,
            event_type: Some("blocks".to_string()),
            tool_call_data: None,
        })
        .await;

    // 2. Register the gate and get the receiver
    let gate = approval_gate();
    let rx = gate.register(block_id).await;

    // 3. Wait for response or timeout.
    // NOTE: we intentionally do NOT include wait_for_stop() here.
    // The global stop flag is process-wide and may be stale from a
    // previous operation. The agent loop already checks is_stop_requested()
    // at the top of each iteration, so a real stop will be caught after
    // the gate resolves or times out.
    let outcome = tokio::select! {
        result = rx => {
            match result {
                Ok(response) => ApprovalOutcome::Responded(response),
                Err(_) => ApprovalOutcome::Cancelled, // sender dropped
            }
        }
        _ = tokio::time::sleep(timeout) => {
            gate.cancel(block_id).await;
            ApprovalOutcome::Timeout
        }
    };

    tracing::info!(block_id, ?outcome, "Approval gate outcome");
    outcome
}

// ─── Tests ─────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn register_and_resolve() {
        let gate = ApprovalGate::new();
        let rx = gate.register("test_1").await;

        let response = BlockResponse {
            block_id: "test_1".into(),
            option_id: Some("allow".into()),
            action: None,
            metadata: None,
        };

        assert!(gate.resolve("test_1", response.clone()).await);

        let result = rx.await.expect("should receive response");
        assert_eq!(result.option_id, Some("allow".into()));
    }

    #[tokio::test]
    async fn resolve_unknown_block_returns_false() {
        let gate = ApprovalGate::new();
        let response = BlockResponse {
            block_id: "unknown".into(),
            option_id: None,
            action: None,
            metadata: None,
        };
        assert!(!gate.resolve("unknown", response).await);
    }

    #[tokio::test]
    async fn cancel_drops_sender() {
        let gate = ApprovalGate::new();
        let rx = gate.register("test_cancel").await;
        gate.cancel("test_cancel").await;
        assert!(rx.await.is_err(), "receiver should get error after cancel");
    }

    #[tokio::test]
    async fn await_approval_timeout() {
        init_approval_gate();
        crate::agent::stop::clear_stop();

        let (tx, _rx) = tokio::sync::mpsc::channel(16);
        let block = ResponseBlock::Choice(crate::tools::response_blocks::ChoiceBlock {
            id: "timeout_test".into(),
            title: "Test".into(),
            subtitle: None,
            options: vec![],
        });

        let outcome =
            await_approval(block, "timeout_test", &tx, Duration::from_millis(50)).await;

        assert!(
            matches!(outcome, ApprovalOutcome::Timeout),
            "Expected Timeout, got {:?}",
            outcome
        );
    }

    #[tokio::test]
    async fn await_approval_resolved() {
        init_approval_gate();
        crate::agent::stop::clear_stop();

        let (tx, _rx) = tokio::sync::mpsc::channel(16);
        let block = ResponseBlock::Choice(crate::tools::response_blocks::ChoiceBlock {
            id: "resolve_test".into(),
            title: "Test".into(),
            subtitle: None,
            options: vec![],
        });

        // Spawn a task that resolves after a short delay
        let gate = approval_gate();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            gate.resolve(
                "resolve_test",
                BlockResponse {
                    block_id: "resolve_test".into(),
                    option_id: Some("allow".into()),
                    action: None,
                    metadata: None,
                },
            )
            .await;
        });

        let outcome =
            await_approval(block, "resolve_test", &tx, Duration::from_secs(5)).await;

        match outcome {
            ApprovalOutcome::Responded(resp) => {
                assert_eq!(resp.option_id, Some("allow".into()));
            }
            other => panic!("Expected Responded, got {:?}", other),
        }
    }
}
