use local_first_browser_automation::{
    BrowserAutomationClient, BrowserMethod, BrowserRequest, BrowserTransport,
};
use serde_json::Value;

#[derive(Default)]
struct FakeTransport {
    response: String,
    sent: std::cell::RefCell<Vec<BrowserRequest>>,
}

impl BrowserTransport for FakeTransport {
    fn send(
        &self,
        request: &BrowserRequest,
    ) -> local_first_browser_automation::BrowserResult<String> {
        self.sent.borrow_mut().push(request.clone());
        Ok(self.response.clone())
    }
}

#[test]
fn client_sends_health_envelope_and_returns_result() {
    let transport = FakeTransport {
        response: serde_json::json!({
            "id": "browser_req_1",
            "ok": true,
            "result": {"status": "ready"}
        })
        .to_string(),
        sent: Default::default(),
    };
    let client = BrowserAutomationClient::new(transport);

    let result = client
        .call(BrowserMethod::Health, Value::Object(Default::default()))
        .unwrap();

    assert_eq!(result["status"], "ready");
    assert_eq!(
        client.transport().sent.borrow()[0].method,
        BrowserMethod::Health
    );
}
