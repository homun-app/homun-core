use crate::{
    ActionClass, CapabilityCall, CapabilityCallResult, CapabilityConnection, CapabilityError,
    CapabilityProvider, CapabilityProviderKind, CapabilityResult, CapabilityTool,
    CapabilityTrigger, ManagedProviderMetadata, ProviderId,
};
use serde::{Deserialize, Serialize};
use std::cell::RefCell;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

/// Heuristic for MCP tools that DON'T declare `readOnlyHint`: decide read vs write
/// from the tool name. The action verb is conventionally the FIRST token
/// (`get_order`, `create_user`, `searchProducts`), so the leading verb decides —
/// this avoids misreading noun homographs like `order`/`post`/`draft` (e.g.
/// `get_order` is a read OF an order, not an order action). If the first token
/// isn't a known verb, fall back to: a read verb present and no write verb.
/// Tokenizes snake/kebab/camelCase. Kept in sync with the Composio verb lists.
pub fn name_is_read_only(name: &str) -> bool {
    const READ_VERBS: &[&str] = &[
        "search", "get", "list", "fetch", "find", "retrieve", "view", "read", "query",
        "lookup", "describe", "count", "check", "export", "browse", "scan", "poll",
    ];
    const WRITE_VERBS: &[&str] = &[
        "create", "update", "delete", "send", "add", "insert", "modify", "edit", "remove",
        "set", "write", "upload", "import", "enable", "disable", "revoke", "grant", "cancel",
        "rename", "publish", "reply", "forward", "archive", "move", "trash", "mark", "clear",
        "patch", "run", "execute", "trigger", "approve", "submit", "pay", "buy",
    ];
    let mut tokens: Vec<String> = Vec::new();
    let mut cur = String::new();
    for ch in name.chars() {
        if ch == '_' || ch == '-' || ch == ' ' || ch == '.' {
            if !cur.is_empty() {
                tokens.push(std::mem::take(&mut cur));
            }
        } else if ch.is_uppercase() && !cur.is_empty() {
            tokens.push(std::mem::take(&mut cur));
            cur.push(ch.to_ascii_lowercase());
        } else {
            cur.extend(ch.to_lowercase());
        }
    }
    if !cur.is_empty() {
        tokens.push(cur);
    }
    if let Some(first) = tokens.first().map(String::as_str) {
        if READ_VERBS.contains(&first) {
            return true;
        }
        if WRITE_VERBS.contains(&first) {
            return false;
        }
    }
    let has_read = tokens.iter().any(|t| READ_VERBS.contains(&t.as_str()));
    let has_write = tokens.iter().any(|t| WRITE_VERBS.contains(&t.as_str()));
    has_read && !has_write
}

pub trait McpTransport {
    fn request(
        &self,
        method: &str,
        params: Option<serde_json::Value>,
    ) -> CapabilityResult<serde_json::Value>;

    fn notify(&self, method: &str, params: Option<serde_json::Value>) -> CapabilityResult<()>;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct McpToolPolicy {
    pub tool_name: String,
    pub action: ActionClass,
    pub privacy_domains: Vec<String>,
    pub sensitivity: String,
}

#[derive(Debug, Clone)]
pub struct InMemoryMcpTransport {
    responses: HashMap<String, serde_json::Value>,
    requests: RefCell<Vec<(String, Option<serde_json::Value>)>>,
    notifications: RefCell<Vec<String>>,
}

impl InMemoryMcpTransport {
    pub fn new() -> Self {
        Self {
            responses: HashMap::new(),
            requests: RefCell::new(Vec::new()),
            notifications: RefCell::new(Vec::new()),
        }
    }

    pub fn with_response(mut self, method: impl Into<String>, response: serde_json::Value) -> Self {
        self.responses.insert(method.into(), response);
        self
    }

    pub fn notifications(&self) -> Vec<String> {
        self.notifications.borrow().clone()
    }

    pub fn requests(&self) -> Vec<(String, Option<serde_json::Value>)> {
        self.requests.borrow().clone()
    }
}

impl Default for InMemoryMcpTransport {
    fn default() -> Self {
        Self::new()
    }
}

impl McpTransport for InMemoryMcpTransport {
    fn request(
        &self,
        method: &str,
        params: Option<serde_json::Value>,
    ) -> CapabilityResult<serde_json::Value> {
        self.requests
            .borrow_mut()
            .push((method.to_string(), params.clone()));
        self.responses.get(method).cloned().ok_or_else(|| {
            CapabilityError::ProviderUnavailable(format!("mcp_response_not_found:{method}"))
        })
    }

    fn notify(&self, method: &str, _params: Option<serde_json::Value>) -> CapabilityResult<()> {
        self.notifications.borrow_mut().push(method.to_string());
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct McpStdioConfig {
    pub command: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

pub struct McpStdioTransport {
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
    stdout: Mutex<BufReader<ChildStdout>>,
    next_id: AtomicU64,
}

impl McpStdioTransport {
    pub fn spawn(config: McpStdioConfig) -> CapabilityResult<Self> {
        let mut command = Command::new(&config.command);
        command.args(&config.args);
        for (key, value) in &config.env {
            command.env(key, value);
        }
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| {
                CapabilityError::ProviderUnavailable(format!("mcp_stdio_spawn_failed:{error}"))
            })?;
        let stdin = child.stdin.take().ok_or_else(|| {
            CapabilityError::ProviderUnavailable("mcp_stdio_missing_stdin".to_string())
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            CapabilityError::ProviderUnavailable("mcp_stdio_missing_stdout".to_string())
        })?;
        Ok(Self {
            child: Mutex::new(child),
            stdin: Mutex::new(stdin),
            stdout: Mutex::new(BufReader::new(stdout)),
            next_id: AtomicU64::new(1),
        })
    }

    fn write_message(&self, message: &serde_json::Value) -> CapabilityResult<()> {
        let mut stdin = self.stdin.lock().map_err(|_| {
            CapabilityError::ProviderUnavailable("mcp_stdio_stdin_lock_poisoned".to_string())
        })?;
        serde_json::to_writer(&mut *stdin, message).map_err(|error| {
            CapabilityError::ProviderUnavailable(format!("mcp_stdio_write_failed:{error}"))
        })?;
        stdin.write_all(b"\n").map_err(|error| {
            CapabilityError::ProviderUnavailable(format!("mcp_stdio_write_failed:{error}"))
        })?;
        stdin.flush().map_err(|error| {
            CapabilityError::ProviderUnavailable(format!("mcp_stdio_flush_failed:{error}"))
        })?;
        Ok(())
    }
}

impl McpTransport for McpStdioTransport {
    fn request(
        &self,
        method: &str,
        params: Option<serde_json::Value>,
    ) -> CapabilityResult<serde_json::Value> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let mut message = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
        });
        if let Some(params) = params {
            message["params"] = params;
        }
        self.write_message(&message)?;

        let mut stdout = self.stdout.lock().map_err(|_| {
            CapabilityError::ProviderUnavailable("mcp_stdio_stdout_lock_poisoned".to_string())
        })?;
        loop {
            let mut line = String::new();
            let bytes = stdout.read_line(&mut line).map_err(|error| {
                CapabilityError::ProviderUnavailable(format!("mcp_stdio_read_failed:{error}"))
            })?;
            if bytes == 0 {
                return Err(CapabilityError::ProviderUnavailable(
                    "mcp_stdio_closed".to_string(),
                ));
            }
            let response: serde_json::Value = serde_json::from_str(&line).map_err(|error| {
                CapabilityError::ProviderUnavailable(format!("mcp_stdio_invalid_json:{error}"))
            })?;
            if response.get("id").and_then(|value| value.as_u64()) != Some(id) {
                continue;
            }
            if let Some(error) = response.get("error") {
                return Err(CapabilityError::ProviderUnavailable(format!(
                    "mcp_stdio_error:{error}"
                )));
            }
            return Ok(response
                .get("result")
                .cloned()
                .unwrap_or(serde_json::Value::Null));
        }
    }

    fn notify(&self, method: &str, params: Option<serde_json::Value>) -> CapabilityResult<()> {
        let mut message = serde_json::json!({
            "jsonrpc": "2.0",
            "method": method,
        });
        if let Some(params) = params {
            message["params"] = params;
        }
        self.write_message(&message)
    }
}

impl Drop for McpStdioTransport {
    fn drop(&mut self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

pub struct McpCapabilityProvider<T: McpTransport> {
    id: ProviderId,
    enabled: bool,
    transport: T,
    tool_policies: Vec<McpToolPolicy>,
}

impl<T: McpTransport> McpCapabilityProvider<T> {
    pub fn new(
        id: ProviderId,
        enabled: bool,
        transport: T,
        tool_policies: Vec<McpToolPolicy>,
    ) -> Self {
        Self {
            id,
            enabled,
            transport,
            tool_policies,
        }
    }

    pub fn initialize(&self, protocol_version: &str) -> CapabilityResult<serde_json::Value> {
        let result = self.transport.request(
            "initialize",
            Some(serde_json::json!({
                "protocolVersion": protocol_version,
                "capabilities": {},
                "clientInfo": {
                    "name": "homun",
                    "version": "0.1.0"
                }
            })),
        )?;
        self.transport
            .notify("notifications/initialized", Some(serde_json::json!({})))?;
        Ok(result)
    }

    pub fn transport(&self) -> &T {
        &self.transport
    }
}

impl<T: McpTransport> CapabilityProvider for McpCapabilityProvider<T> {
    fn id(&self) -> &ProviderId {
        &self.id
    }

    fn kind(&self) -> CapabilityProviderKind {
        CapabilityProviderKind::Mcp
    }

    fn is_enabled(&self) -> bool {
        self.enabled
    }

    fn managed_metadata(&self) -> Option<&ManagedProviderMetadata> {
        None
    }

    fn list_tools(&self) -> CapabilityResult<Vec<CapabilityTool>> {
        let response = self.transport.request("tools/list", None)?;
        let tools = response
            .get("tools")
            .and_then(|value| value.as_array())
            .ok_or_else(|| {
                CapabilityError::ProviderUnavailable("mcp tools/list missing tools".to_string())
            })?;

        tools
            .iter()
            .map(|tool| self.capability_tool_from_mcp(tool))
            .collect()
    }

    fn list_connections(&self) -> CapabilityResult<Vec<CapabilityConnection>> {
        Ok(Vec::new())
    }

    fn call_tool(&self, call: &CapabilityCall) -> CapabilityResult<CapabilityCallResult> {
        let output = self.transport.request(
            "tools/call",
            Some(serde_json::json!({
                "name": call.tool_name,
                "arguments": call.arguments,
            })),
        )?;
        Ok(CapabilityCallResult {
            provider_id: self.id.clone(),
            tool_name: call.tool_name.clone(),
            output,
        })
    }

    fn list_triggers(&self) -> CapabilityResult<Vec<CapabilityTrigger>> {
        Ok(Vec::new())
    }

    fn enable_trigger(&mut self, trigger_id: &str) -> CapabilityResult<()> {
        Err(CapabilityError::TriggerFailed(format!(
            "mcp_triggers_not_supported:{trigger_id}"
        )))
    }

    fn disable_trigger(&mut self, trigger_id: &str) -> CapabilityResult<()> {
        Err(CapabilityError::TriggerFailed(format!(
            "mcp_triggers_not_supported:{trigger_id}"
        )))
    }
}

impl<T: McpTransport> McpCapabilityProvider<T> {
    fn capability_tool_from_mcp(
        &self,
        tool: &serde_json::Value,
    ) -> CapabilityResult<CapabilityTool> {
        let name = tool
            .get("name")
            .and_then(|value| value.as_str())
            .ok_or_else(|| {
                CapabilityError::ProviderUnavailable("mcp tool missing name".to_string())
            })?;
        let policy = self
            .tool_policies
            .iter()
            .find(|policy| policy.tool_name == name);
        // Classify read vs write. An explicit per-tool policy wins. Otherwise we
        // honor the MCP `annotations.readOnlyHint`: true → Read, false → write. Most
        // servers OMIT the hint, though — and defaulting those to write made plain
        // reads (e.g. `search_products`) demand confirmation. So when the hint is
        // ABSENT, fall back to a verb heuristic on the tool name (search/get/list/…
        // → Read); only genuinely write-looking or ambiguous names stay confirmed.
        let read_only_hint = tool
            .get("annotations")
            .and_then(|a| a.get("readOnlyHint"))
            .and_then(|v| v.as_bool());
        let inferred_action = match read_only_hint {
            Some(true) => ActionClass::Read,
            Some(false) => ActionClass::WriteWithConfirmation,
            None if name_is_read_only(name) => ActionClass::Read,
            None => ActionClass::WriteWithConfirmation,
        };
        Ok(CapabilityTool {
            name: name.to_string(),
            provider_id: self.id.clone(),
            provider_kind: CapabilityProviderKind::Mcp,
            action: policy.map(|policy| policy.action).unwrap_or(inferred_action),
            description: tool
                .get("description")
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .to_string(),
            privacy_domains: policy
                .map(|policy| policy.privacy_domains.clone())
                .unwrap_or_default(),
            sensitivity: policy
                .map(|policy| policy.sensitivity.clone())
                .unwrap_or_else(|| "private".to_string()),
            input_schema: tool
                .get("inputSchema")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({"type": "object"})),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::name_is_read_only;

    #[test]
    fn reads_are_read_only() {
        // Incl. noun homographs after a read verb (order/post/draft are nouns here).
        for name in [
            "search_products", "get_order", "list_items", "fetch_prices", "searchProducts",
            "get_post", "list_drafts",
        ] {
            assert!(name_is_read_only(name), "{name} should be read-only");
        }
    }

    #[test]
    fn writes_and_ambiguous_are_not() {
        // Leading write verb, or no read verb at all → stays confirmed.
        for name in ["create_item", "delete_order", "send_message", "post_message", "process_order"] {
            assert!(!name_is_read_only(name), "{name} should NOT be read-only");
        }
    }
}
