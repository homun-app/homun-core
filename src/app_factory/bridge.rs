use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BridgePolicy {
    #[serde(default)]
    pub profiles: Vec<String>,
    #[serde(default)]
    pub contacts: ContactAccess,
    #[serde(default)]
    pub channels: ChannelAccess,
    #[serde(default)]
    pub knowledge_namespaces: Vec<String>,
    #[serde(default)]
    pub tools: Vec<String>,
    #[serde(default)]
    pub writeback: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ContactAccess {
    #[serde(default)]
    pub read: Vec<String>,
    #[serde(default)]
    pub link_app_users: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ChannelAccess {
    #[serde(default)]
    pub send: Vec<String>,
    #[serde(default)]
    pub receive: Vec<String>,
}

impl BridgePolicy {
    pub fn deny_all() -> Self {
        Self {
            profiles: Vec::new(),
            contacts: ContactAccess::default(),
            channels: ChannelAccess::default(),
            knowledge_namespaces: Vec::new(),
            tools: Vec::new(),
            writeback: Vec::new(),
        }
    }

    pub fn allows_tool(&self, tool: &str) -> bool {
        self.tools.iter().any(|name| name == tool)
    }

    pub fn allows_channel_send(&self, channel: &str) -> bool {
        self.channels.send.iter().any(|name| name == channel)
    }

    pub fn allows_knowledge_namespace(&self, namespace: &str) -> bool {
        self.knowledge_namespaces
            .iter()
            .any(|name| name == namespace)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deny_all_policy_blocks_everything() {
        let policy = BridgePolicy::deny_all();
        assert!(!policy.allows_tool("send_message"));
        assert!(!policy.allows_channel_send("email"));
        assert!(!policy.allows_knowledge_namespace("hr-policy"));
    }

    #[test]
    fn explicit_policy_allows_declared_capabilities() {
        let policy: BridgePolicy = serde_json::from_value(serde_json::json!({
            "tools": ["send_message"],
            "channels": {"send": ["email"]},
            "knowledge_namespaces": ["hr-policy"]
        }))
        .unwrap();

        assert!(policy.allows_tool("send_message"));
        assert!(policy.allows_channel_send("email"));
        assert!(policy.allows_knowledge_namespace("hr-policy"));
        assert!(!policy.allows_tool("vault"));
    }
}
