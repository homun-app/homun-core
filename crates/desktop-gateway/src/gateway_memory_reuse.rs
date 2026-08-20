//! Stream memory reuse attestation owner.
//!
//! Converts recall/approval/actionable stream observations into persisted
//! transcript event parts and the memory reuse envelope used at assistant
//! finalization. Stream transport and final message persistence stay outside
//! this module.

use crate::gateway_remote_approval::{
    ActionableCard, RemoteApprovalIntent, remote_approval_event_part,
};

pub(crate) fn memory_reuse_envelope_from_read_set(
    reads: &local_first_engine::events::TurnMemoryReadSet,
) -> local_first_memory::MemoryReuseEnvelope {
    if reads.is_blocked_unknown() {
        return local_first_memory::MemoryReuseEnvelope::blocked_unknown();
    }
    if !reads.has_linked_reads() {
        return local_first_memory::MemoryReuseEnvelope::normal();
    }
    local_first_memory::MemoryReuseEnvelope::user_input_only(
        reads
            .linked
            .iter()
            .map(|read| local_first_memory::LinkedMemoryReadRef {
                source_workspace_id: read.source_workspace_id.clone(),
                grant_id: read.grant_id.clone(),
                policy_version: read.policy_version,
                memory_ref: read.memory_ref.clone(),
                source_revision: read.source_revision.clone(),
            })
            .collect(),
    )
}

#[derive(Debug, Default)]
pub(crate) struct StreamMemoryReuseCollector {
    event_parts: Vec<serde_json::Value>,
    reads: local_first_engine::events::TurnMemoryReadSet,
}

impl StreamMemoryReuseCollector {
    pub(crate) fn observe_line(&mut self, line: &str) {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
            return;
        };
        if value.get("type").and_then(serde_json::Value::as_str) != Some("recall") {
            return;
        }
        let Some(payload_value) = value.get("payload").cloned() else {
            self.reads.blocked_unknown = true;
            return;
        };
        let part = serde_json::json!({
            "type": "recall",
            "payload": payload_value,
        });
        if !self.event_parts.contains(&part) {
            self.event_parts.push(part);
        }
        match serde_json::from_value::<local_first_subagents::RecallStreamPayload>(payload_value) {
            Ok(payload) => self.reads.extend_payload(&payload),
            Err(_) => self.reads.blocked_unknown = true,
        }
    }

    pub(crate) fn event_parts(&self) -> &[serde_json::Value] {
        &self.event_parts
    }

    pub(crate) fn observe_remote_approval(&mut self, intent: &RemoteApprovalIntent) {
        let part = remote_approval_event_part(intent);
        if !self.event_parts.contains(&part) {
            self.event_parts.push(part);
        }
    }

    pub(crate) fn observe_actionable_cards(&mut self, cards: &[ActionableCard]) {
        for card in cards {
            let part = serde_json::json!({
                "type": "actionable_card",
                "kind": card.kind,
                "payload": card.payload,
                "raw": card.raw,
            });
            if !self.event_parts.contains(&part) {
                self.event_parts.push(part);
            }
        }
    }

    pub(crate) fn envelope(&self) -> local_first_memory::MemoryReuseEnvelope {
        memory_reuse_envelope_from_read_set(&self.reads)
    }
}
