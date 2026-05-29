use crate::{
    ActionClass, CapabilityCall, CapabilityCallResult, CapabilityConnection, CapabilityError,
    CapabilityProvider, CapabilityProviderKind, CapabilityResult, CapabilityTool,
    CapabilityTrigger, ManagedProviderMetadata, ProviderId,
};
use local_first_browser_automation::{BrowserAutomationClient, BrowserMethod, BrowserTransport};

pub struct BrowserCapabilityProvider<T> {
    id: ProviderId,
    client: BrowserAutomationClient<T>,
}

impl<T: BrowserTransport> BrowserCapabilityProvider<T> {
    pub fn new(transport: T) -> Self {
        Self {
            id: ProviderId::new("browser"),
            client: BrowserAutomationClient::new(transport),
        }
    }

    pub fn client(&self) -> &BrowserAutomationClient<T> {
        &self.client
    }
}

impl<T: BrowserTransport> CapabilityProvider for BrowserCapabilityProvider<T> {
    fn id(&self) -> &ProviderId {
        &self.id
    }

    fn kind(&self) -> CapabilityProviderKind {
        CapabilityProviderKind::Browser
    }

    fn is_enabled(&self) -> bool {
        true
    }

    fn managed_metadata(&self) -> Option<&ManagedProviderMetadata> {
        None
    }

    fn list_tools(&self) -> CapabilityResult<Vec<CapabilityTool>> {
        Ok(vec![
            tool("browser.health", ActionClass::Read, "Browser health"),
            tool(
                "browser.profiles",
                ActionClass::Read,
                "List browser profiles",
            ),
            tool("browser.tabs", ActionClass::Read, "List browser tabs"),
            tool(
                "browser.snapshot",
                ActionClass::Read,
                "Snapshot current page",
            ),
            tool(
                "browser.console",
                ActionClass::Read,
                "Read browser console messages",
            ),
            tool(
                "browser.open",
                ActionClass::WriteWithConfirmation,
                "Open URL",
            ),
            tool(
                "browser.focus",
                ActionClass::WriteWithConfirmation,
                "Focus browser tab",
            ),
            tool(
                "browser.close_tab",
                ActionClass::WriteWithConfirmation,
                "Close browser tab",
            ),
            tool(
                "browser.navigate",
                ActionClass::WriteWithConfirmation,
                "Navigate tab",
            ),
            tool(
                "browser.screenshot",
                ActionClass::WriteWithConfirmation,
                "Capture screenshot artifact",
            ),
            tool(
                "browser.pdf",
                ActionClass::WriteWithConfirmation,
                "Capture PDF artifact",
            ),
            tool(
                "browser.act",
                ActionClass::WriteWithConfirmation,
                "Execute browser action",
            ),
            tool(
                "browser.arm_file_chooser",
                ActionClass::WriteWithConfirmation,
                "Arm file chooser upload",
            ),
            tool(
                "browser.respond_dialog",
                ActionClass::WriteWithConfirmation,
                "Respond to browser dialog",
            ),
            tool(
                "browser.wait_download",
                ActionClass::WriteWithConfirmation,
                "Wait for and save download",
            ),
        ])
    }

    fn list_connections(&self) -> CapabilityResult<Vec<CapabilityConnection>> {
        Ok(Vec::new())
    }

    fn call_tool(&self, call: &CapabilityCall) -> CapabilityResult<CapabilityCallResult> {
        let method = method_for_tool(&call.tool_name)?;
        let output = self
            .client
            .call(method, call.arguments.clone())
            .map_err(|error| CapabilityError::ToolExecutionFailed(error.to_string()))?;
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
            "trigger_not_supported:{trigger_id}"
        )))
    }

    fn disable_trigger(&mut self, trigger_id: &str) -> CapabilityResult<()> {
        Err(CapabilityError::TriggerFailed(format!(
            "trigger_not_supported:{trigger_id}"
        )))
    }
}

fn tool(name: &str, action: ActionClass, description: &str) -> CapabilityTool {
    CapabilityTool {
        name: name.to_string(),
        provider_id: ProviderId::new("browser"),
        provider_kind: CapabilityProviderKind::Browser,
        action,
        description: description.to_string(),
        privacy_domains: vec!["browser".to_string()],
        sensitivity: "private".to_string(),
        input_schema: serde_json::json!({"type": "object"}),
    }
}

fn method_for_tool(tool_name: &str) -> CapabilityResult<BrowserMethod> {
    match tool_name {
        "browser.health" => Ok(BrowserMethod::Health),
        "browser.profiles" => Ok(BrowserMethod::Profiles),
        "browser.tabs" => Ok(BrowserMethod::Tabs),
        "browser.snapshot" => Ok(BrowserMethod::Snapshot),
        "browser.console" => Ok(BrowserMethod::Console),
        "browser.open" => Ok(BrowserMethod::Open),
        "browser.focus" => Ok(BrowserMethod::Focus),
        "browser.close_tab" => Ok(BrowserMethod::CloseTab),
        "browser.navigate" => Ok(BrowserMethod::Navigate),
        "browser.screenshot" => Ok(BrowserMethod::Screenshot),
        "browser.pdf" => Ok(BrowserMethod::Pdf),
        "browser.act" => Ok(BrowserMethod::Act),
        "browser.arm_file_chooser" => Ok(BrowserMethod::ArmFileChooser),
        "browser.respond_dialog" => Ok(BrowserMethod::RespondDialog),
        "browser.wait_download" => Ok(BrowserMethod::WaitDownload),
        _ => Err(CapabilityError::ToolExecutionFailed(format!(
            "tool_not_found:{tool_name}"
        ))),
    }
}
