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

    pub fn allows_contact_ref(&self, contact_ref: &str) -> bool {
        self.contacts
            .read
            .iter()
            .any(|name| name == "*" || name.eq_ignore_ascii_case(contact_ref))
    }

    pub fn allows_knowledge_namespace(&self, namespace: &str) -> bool {
        self.knowledge_namespaces
            .iter()
            .any(|name| name == namespace)
    }

    pub fn normalized(mut self) -> Self {
        normalize_list(&mut self.profiles);
        normalize_list(&mut self.contacts.read);
        normalize_list(&mut self.channels.send);
        normalize_list(&mut self.channels.receive);
        normalize_list(&mut self.knowledge_namespaces);
        normalize_list(&mut self.tools);
        normalize_list(&mut self.writeback);
        self
    }
}

fn normalize_list(items: &mut Vec<String>) {
    let mut normalized = Vec::new();
    for item in items.drain(..) {
        let item = item.trim();
        if item.is_empty() || normalized.iter().any(|existing| existing == item) {
            continue;
        }
        normalized.push(item.to_string());
    }
    *items = normalized;
}

pub fn ensure_tool_allowed(policy: &BridgePolicy, tool: &str) -> anyhow::Result<()> {
    if !policy.allows_tool(tool) {
        anyhow::bail!("Bridge policy does not allow tool '{tool}'");
    }
    Ok(())
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
            "contacts": {"read": ["*"]},
            "knowledge_namespaces": ["hr-policy"]
        }))
        .unwrap();

        assert!(policy.allows_tool("send_message"));
        assert!(policy.allows_channel_send("email"));
        assert!(policy.allows_contact_ref("*"));
        assert!(policy.allows_knowledge_namespace("hr-policy"));
        assert!(!policy.allows_tool("vault"));
    }

    #[test]
    fn ensure_tool_allowed_fails_closed() {
        let policy = BridgePolicy::deny_all();

        assert!(ensure_tool_allowed(&policy, "send_message").is_err());
    }

    #[test]
    fn normalized_policy_trims_and_deduplicates_capabilities() {
        let policy = BridgePolicy {
            tools: vec![
                " send_message ".to_string(),
                "send_message".to_string(),
                "".to_string(),
                "contacts".to_string(),
            ],
            channels: ChannelAccess {
                send: vec![" email ".to_string(), "email".to_string()],
                receive: Vec::new(),
            },
            ..BridgePolicy::deny_all()
        }
        .normalized();

        assert_eq!(policy.tools, vec!["send_message", "contacts"]);
        assert_eq!(policy.channels.send, vec!["email"]);
    }
}
