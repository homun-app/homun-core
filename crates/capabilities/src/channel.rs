use crate::{CapabilityResult, ProviderId};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChannelCapabilities {
    pub supports_reactions: bool,
    pub supports_draft_updates: bool,
    pub supports_typing: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChannelMessage {
    pub provider_id: ProviderId,
    pub id: String,
    pub sender: String,
    pub reply_target: String,
    pub content: String,
    pub timestamp: u64,
    pub thread_id: Option<String>,
}

impl ChannelMessage {
    pub fn new(
        provider_id: ProviderId,
        id: impl Into<String>,
        sender: impl Into<String>,
        reply_target: impl Into<String>,
        content: impl Into<String>,
        timestamp: u64,
    ) -> Self {
        Self {
            provider_id,
            id: id.into(),
            sender: sender.into(),
            reply_target: reply_target.into(),
            content: content.into(),
            timestamp,
            thread_id: None,
        }
    }

    pub fn in_thread(mut self, thread_id: Option<String>) -> Self {
        self.thread_id = thread_id;
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OutboundChannelMessage {
    pub provider_id: ProviderId,
    pub recipient: String,
    pub content: String,
    pub thread_id: Option<String>,
}

impl OutboundChannelMessage {
    pub fn new(
        provider_id: ProviderId,
        recipient: impl Into<String>,
        content: impl Into<String>,
    ) -> Self {
        Self {
            provider_id,
            recipient: recipient.into(),
            content: content.into(),
            thread_id: None,
        }
    }

    pub fn in_thread(mut self, thread_id: Option<String>) -> Self {
        self.thread_id = thread_id;
        self
    }
}

pub trait ChannelProvider {
    fn id(&self) -> &ProviderId;
    fn capabilities(&self) -> &ChannelCapabilities;
    fn send_message(&mut self, message: &OutboundChannelMessage) -> CapabilityResult<()>;
    fn start_typing(&mut self, recipient: &str) -> CapabilityResult<()>;
    fn send_reaction(&mut self, message_id: &str, reaction: &str) -> CapabilityResult<()>;
    fn health(&self) -> bool;
}

#[derive(Debug, Clone)]
pub struct FakeChannelProvider {
    id: ProviderId,
    capabilities: ChannelCapabilities,
    sent_messages: Vec<OutboundChannelMessage>,
    typing_targets: Vec<String>,
    reactions: Vec<(String, String)>,
}

impl FakeChannelProvider {
    pub fn new(id: ProviderId, capabilities: ChannelCapabilities) -> Self {
        Self {
            id,
            capabilities,
            sent_messages: Vec::new(),
            typing_targets: Vec::new(),
            reactions: Vec::new(),
        }
    }

    pub fn sent_messages(&self) -> Vec<OutboundChannelMessage> {
        self.sent_messages.clone()
    }

    pub fn typing_targets(&self) -> Vec<String> {
        self.typing_targets.clone()
    }

    pub fn reactions(&self) -> Vec<(String, String)> {
        self.reactions.clone()
    }
}

impl ChannelProvider for FakeChannelProvider {
    fn id(&self) -> &ProviderId {
        &self.id
    }

    fn capabilities(&self) -> &ChannelCapabilities {
        &self.capabilities
    }

    fn send_message(&mut self, message: &OutboundChannelMessage) -> CapabilityResult<()> {
        self.sent_messages.push(message.clone());
        Ok(())
    }

    fn start_typing(&mut self, recipient: &str) -> CapabilityResult<()> {
        self.typing_targets.push(recipient.to_string());
        Ok(())
    }

    fn send_reaction(&mut self, message_id: &str, reaction: &str) -> CapabilityResult<()> {
        self.reactions
            .push((message_id.to_string(), reaction.to_string()));
        Ok(())
    }

    fn health(&self) -> bool {
        true
    }
}
