use local_first_browser_automation::{
    BrowserMethod, BrowserRequest, BrowserTaskExecutor, BrowserTaskRuntimeBridge, BrowserTransport,
};
use local_first_task_runtime::{ExecutorResult, ResourceClass, TaskExecutor, UserId, WorkspaceId};
use std::cell::RefCell;
use std::rc::Rc;

struct FakeTransport {
    response: String,
    sent: Rc<RefCell<Vec<BrowserRequest>>>,
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
fn bridge_declares_browser_session_resource() {
    let bridge = BrowserTaskRuntimeBridge::new();

    let task = bridge.enqueue_browser_call(
        "browser_task_1",
        UserId::new("user_1"),
        WorkspaceId::new("workspace_1"),
        BrowserMethod::Snapshot,
        serde_json::json!({"target_id": "booking"}),
    );

    assert_eq!(task.kind, "browser_automation");
    assert_eq!(
        task.resource_requirements[0].class,
        ResourceClass::BrowserSession
    );
    assert_eq!(task.resource_requirements[0].units, 1);
    assert_eq!(task.input_json["method"], "browser.snapshot");
}

#[test]
fn executor_checkpoints_snapshot_results() {
    let transport = FakeTransport {
        response: serde_json::json!({
            "id": "browser_req_1",
            "ok": true,
            "result": {"snapshot": "page", "refs": []}
        })
        .to_string(),
        sent: Rc::default(),
    };
    let mut executor = BrowserTaskExecutor::new(transport);
    let task = BrowserTaskRuntimeBridge::new().enqueue_browser_call(
        "browser_task_1",
        UserId::new("user_1"),
        WorkspaceId::new("workspace_1"),
        BrowserMethod::Snapshot,
        serde_json::json!({"target_id": "booking"}),
    );

    let result = executor.execute_step(&task, None).unwrap();

    assert_eq!(
        result,
        ExecutorResult::Checkpoint {
            payload: serde_json::json!({"snapshot": "page", "refs": []}),
            redacted_payload: serde_json::json!({
                "browser": {
                    "method": "browser.snapshot",
                    "target_id": "booking"
                },
                "result": {"snapshot": "page", "refs": []}
            }),
        }
    );
}

#[test]
fn executor_maps_manual_blockers_to_user_approval() {
    let transport = FakeTransport {
        response: serde_json::json!({
            "id": "browser_req_1",
            "ok": false,
            "error": {
                "code": "BROWSER_MANUAL_BLOCKER",
                "message": "2FA required",
                "retryable": false,
                "manual_action_required": true
            }
        })
        .to_string(),
        sent: Rc::default(),
    };
    let mut executor = BrowserTaskExecutor::new(transport);
    let task = BrowserTaskRuntimeBridge::new().enqueue_browser_call(
        "browser_task_1",
        UserId::new("user_1"),
        WorkspaceId::new("workspace_1"),
        BrowserMethod::Act,
        serde_json::json!({"target_id": "booking", "kind": "wait", "text": "2FA"}),
    );

    let result = executor.execute_step(&task, None).unwrap();

    assert_eq!(
        result,
        ExecutorResult::NeedsApproval {
            action: "browser.manual_action".to_string(),
            risk_level: "medium".to_string(),
            data_boundary: "local_browser".to_string(),
            explanation: "2FA required".to_string(),
        }
    );
}

#[test]
fn executor_blocks_click_actions_before_sidecar() {
    let transport = FakeTransport {
        response: serde_json::json!({
            "id": "browser_req_1",
            "ok": true,
            "result": {"ok": true}
        })
        .to_string(),
        sent: Rc::default(),
    };
    let sent = Rc::clone(&transport.sent);
    let mut executor = BrowserTaskExecutor::new(transport);
    let task = BrowserTaskRuntimeBridge::new().enqueue_browser_call(
        "browser_task_1",
        UserId::new("user_1"),
        WorkspaceId::new("workspace_1"),
        BrowserMethod::Act,
        serde_json::json!({"target_id": "booking", "kind": "click", "ref": "e1"}),
    );

    let result = executor.execute_step(&task, None).unwrap();

    assert_eq!(
        result,
        ExecutorResult::NeedsApproval {
            action: "browser.manual_action".to_string(),
            risk_level: "medium".to_string(),
            data_boundary: "local_browser".to_string(),
            explanation: "browser action requires approval before execution: click".to_string(),
        }
    );
    assert!(sent.borrow().is_empty());
}

#[test]
fn executor_completes_non_snapshot_calls() {
    let transport = FakeTransport {
        response: serde_json::json!({
            "id": "browser_req_1",
            "ok": true,
            "result": {"status": "ready"}
        })
        .to_string(),
        sent: Rc::default(),
    };
    let mut executor = BrowserTaskExecutor::new(transport);
    let task = BrowserTaskRuntimeBridge::new().enqueue_browser_call(
        "browser_task_1",
        UserId::new("user_1"),
        WorkspaceId::new("workspace_1"),
        BrowserMethod::Health,
        serde_json::json!({}),
    );

    let result = executor.execute_step(&task, None).unwrap();

    assert_eq!(
        result,
        ExecutorResult::Completed {
            output: serde_json::json!({"status": "ready"}),
        }
    );
}
