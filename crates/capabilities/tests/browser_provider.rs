use local_first_browser_automation::{BrowserRequest, BrowserTransport};
use local_first_capabilities::{
    ActionClass, BrowserCapabilityProvider, CapabilityCall, CapabilityProvider,
    CapabilityProviderKind, ProviderId,
};
use std::cell::RefCell;

#[derive(Default)]
struct FakeBrowserTransport {
    response: String,
    sent: RefCell<Vec<BrowserRequest>>,
}

impl BrowserTransport for FakeBrowserTransport {
    fn send(
        &self,
        request: &BrowserRequest,
    ) -> local_first_browser_automation::BrowserResult<String> {
        self.sent.borrow_mut().push(request.clone());
        Ok(self.response.clone())
    }
}

#[test]
fn browser_provider_lists_policy_classified_tools() {
    let provider = BrowserCapabilityProvider::new(FakeBrowserTransport::default());

    let tools = provider.list_tools().unwrap();
    let tool_names: Vec<_> = tools.iter().map(|tool| tool.name.as_str()).collect();
    let snapshot = tools
        .iter()
        .find(|tool| tool.name == "browser.snapshot")
        .unwrap();
    let act = tools
        .iter()
        .find(|tool| tool.name == "browser.act")
        .unwrap();

    assert_eq!(provider.id(), &ProviderId::new("browser"));
    assert_eq!(provider.kind(), CapabilityProviderKind::Browser);
    assert_eq!(
        tool_names,
        vec![
            "browser.health",
            "browser.profiles",
            "browser.tabs",
            "browser.snapshot",
            "browser.console",
            "browser.open",
            "browser.focus",
            "browser.close_tab",
            "browser.navigate",
            "browser.screenshot",
            "browser.pdf",
            "browser.act",
            "browser.arm_file_chooser",
            "browser.respond_dialog",
            "browser.wait_download",
        ]
    );
    assert_eq!(snapshot.action, ActionClass::Read);
    assert_eq!(act.action, ActionClass::WriteWithConfirmation);
    assert_eq!(snapshot.privacy_domains, vec!["browser"]);
}

#[test]
fn browser_provider_calls_sidecar_through_browser_client() {
    let transport = FakeBrowserTransport {
        response: serde_json::json!({
            "id": "browser_req_1",
            "ok": true,
            "result": {"status": "ready"}
        })
        .to_string(),
        sent: Default::default(),
    };
    let provider = BrowserCapabilityProvider::new(transport);

    let result = provider
        .call_tool(&CapabilityCall {
            provider_id: ProviderId::new("browser"),
            tool_name: "browser.health".to_string(),
            arguments: serde_json::json!({}),
        })
        .unwrap();

    assert_eq!(result.provider_id, ProviderId::new("browser"));
    assert_eq!(result.tool_name, "browser.health");
    assert_eq!(result.output["status"], "ready");
    assert_eq!(
        provider.client().transport().sent.borrow()[0].method,
        local_first_browser_automation::BrowserMethod::Health
    );
}
