use local_first_browser_automation::{
    BrowserAutomationError, BrowserLoopDecision, BrowserLoopPlanner, BrowserLoopRequest,
    BrowserLoopRunner, BrowserObservation, BrowserRequest, BrowserResult, BrowserTransport,
    browser_loop_event_payload,
};
use serde_json::Value;
use std::cell::RefCell;
use std::collections::VecDeque;
use std::rc::Rc;

#[derive(Default)]
struct QueuedTransport {
    responses: RefCell<VecDeque<Value>>,
    sent: Rc<RefCell<Vec<BrowserRequest>>>,
}

impl QueuedTransport {
    fn new(responses: Vec<Value>) -> Self {
        Self {
            responses: RefCell::new(VecDeque::from(responses)),
            sent: Rc::default(),
        }
    }
}

impl BrowserTransport for QueuedTransport {
    fn send(
        &self,
        request: &BrowserRequest,
    ) -> local_first_browser_automation::BrowserResult<String> {
        self.sent.borrow_mut().push(request.clone());
        let mut response = self.responses.borrow_mut().pop_front().unwrap();
        response["id"] = Value::String(request.id.clone());
        Ok(response.to_string())
    }
}

struct FixturePlanner;

impl BrowserLoopPlanner for FixturePlanner {
    fn decide_next(
        &mut self,
        _request: &BrowserLoopRequest,
        observation: &BrowserObservation,
        _iterations: &[local_first_browser_automation::BrowserLoopIteration],
    ) -> BrowserResult<BrowserLoopDecision> {
        if observation.snapshot.contains("Risultato finale") {
            return Ok(BrowserLoopDecision::Complete {
                output: serde_json::json!({
                    "answer": "Risultato finale",
                }),
            });
        }
        if observation.snapshot.contains("Milano Centrale") {
            return Ok(BrowserLoopDecision::Act {
                action: serde_json::json!({
                    "kind": "click",
                    "ref": "e2",
                }),
                expected_observation: Some("risultati mostrati".to_string()),
            });
        }
        Ok(BrowserLoopDecision::Act {
            action: serde_json::json!({
                "kind": "type",
                "ref": "e1",
                "text": "Mil",
            }),
            expected_observation: Some("autocomplete mostrato".to_string()),
        })
    }
}

struct NoProgressPlanner;

impl BrowserLoopPlanner for NoProgressPlanner {
    fn decide_next(
        &mut self,
        _request: &BrowserLoopRequest,
        _observation: &BrowserObservation,
        _iterations: &[local_first_browser_automation::BrowserLoopIteration],
    ) -> BrowserResult<BrowserLoopDecision> {
        Ok(BrowserLoopDecision::Act {
            action: serde_json::json!({
                "kind": "click",
                "ref": "e1",
            }),
            expected_observation: Some("page changes".to_string()),
        })
    }
}

struct StaleRefPlanner;

impl BrowserLoopPlanner for StaleRefPlanner {
    fn decide_next(
        &mut self,
        _request: &BrowserLoopRequest,
        observation: &BrowserObservation,
        _iterations: &[local_first_browser_automation::BrowserLoopIteration],
    ) -> BrowserResult<BrowserLoopDecision> {
        if observation.snapshot.contains("Risultato finale") {
            return Ok(BrowserLoopDecision::Complete {
                output: serde_json::json!({"answer": "ok"}),
            });
        }
        let ref_id = if observation.snapshot.contains("[ref=e2]") {
            "e2"
        } else {
            "e1"
        };
        Ok(BrowserLoopDecision::Act {
            action: serde_json::json!({
                "kind": "click",
                "ref": ref_id,
            }),
            expected_observation: Some("clic sicuro".to_string()),
        })
    }
}

struct PlannerValidationErrorThenCompletePlanner;

impl BrowserLoopPlanner for PlannerValidationErrorThenCompletePlanner {
    fn decide_next(
        &mut self,
        _request: &BrowserLoopRequest,
        _observation: &BrowserObservation,
        iterations: &[local_first_browser_automation::BrowserLoopIteration],
    ) -> BrowserResult<BrowserLoopDecision> {
        if iterations.is_empty() {
            return Err(BrowserAutomationError::InvalidResponse(
                "browser loop action uses ref not present in current snapshot: e118".to_string(),
            ));
        }
        Ok(BrowserLoopDecision::Complete {
            output: serde_json::json!({"answer": "recovered"}),
        })
    }
}

struct RecoverableActionErrorThenCompletePlanner;

impl BrowserLoopPlanner for RecoverableActionErrorThenCompletePlanner {
    fn decide_next(
        &mut self,
        _request: &BrowserLoopRequest,
        _observation: &BrowserObservation,
        iterations: &[local_first_browser_automation::BrowserLoopIteration],
    ) -> BrowserResult<BrowserLoopDecision> {
        if iterations.is_empty() {
            return Ok(BrowserLoopDecision::Act {
                action: serde_json::json!({
                    "kind": "fill_form",
                    "fields": [{"ref": "e95", "value": "Napoli Centrale"}],
                }),
                expected_observation: Some("origin field filled".to_string()),
            });
        }
        Ok(BrowserLoopDecision::Complete {
            output: serde_json::json!({"answer": "recovered from action error"}),
        })
    }
}

struct RepeatedRecoverableActionErrorPlanner;

impl BrowserLoopPlanner for RepeatedRecoverableActionErrorPlanner {
    fn decide_next(
        &mut self,
        _request: &BrowserLoopRequest,
        _observation: &BrowserObservation,
        _iterations: &[local_first_browser_automation::BrowserLoopIteration],
    ) -> BrowserResult<BrowserLoopDecision> {
        Ok(BrowserLoopDecision::Act {
            action: serde_json::json!({
                "kind": "fill_form",
                "fields": [{"ref": "e95", "value": "Napoli Centrale"}],
            }),
            expected_observation: Some("origin field filled".to_string()),
        })
    }
}

#[test]
fn loop_executes_one_action_per_fresh_observation() {
    let transport = QueuedTransport::new(vec![
        serde_json::json!({
            "ok": true,
            "result": {"targetId": "booking", "url": "http://fixture", "opened": true}
        }),
        serde_json::json!({
            "ok": true,
            "result": {
                "targetId": "booking",
                "url": "http://fixture",
                "snapshot": "- textbox \"Destination\" [ref=e1]",
                "refsMode": "aria",
                "snapshotFormat": "ai",
                "stats": {"refs": 1}
            }
        }),
        serde_json::json!({
            "ok": true,
            "result": {
                "ok": true,
                "targetId": "booking",
                "url": "http://fixture",
                "snapshot": "- textbox \"Destination\" [ref=e1]\n- button \"Milano Centrale\" [ref=e2]",
                "refsMode": "aria",
                "snapshotFormat": "ai",
                "stats": {"refs": 2}
            }
        }),
        serde_json::json!({
            "ok": true,
            "result": {
                "ok": true,
                "targetId": "booking",
                "url": "http://fixture/results",
                "snapshot": "Risultato finale\n- text \"FR 9606 09:10\"",
                "refsMode": "aria",
                "snapshotFormat": "ai",
                "stats": {"refs": 0}
            }
        }),
    ]);
    let sent = Rc::clone(&transport.sent);
    let mut runner = BrowserLoopRunner::new(transport, FixturePlanner);
    let request = BrowserLoopRequest::new("cerca treni", "booking")
        .with_initial_url("http://fixture")
        .with_max_iterations(4);

    let output = runner.run(&request).unwrap();

    assert!(output.completed);
    assert_eq!(output.iterations.len(), 2);
    assert_eq!(output.output["answer"], "Risultato finale");

    let sent = sent.borrow();
    assert_eq!(
        serde_json::to_value(sent[0].method).unwrap(),
        "browser.open"
    );
    assert_eq!(
        serde_json::to_value(sent[1].method).unwrap(),
        "browser.snapshot"
    );
    assert_eq!(sent[1].params["urls"], true);
    assert_eq!(serde_json::to_value(sent[2].method).unwrap(), "browser.act");
    assert_eq!(sent[2].params["snapshot_after"], true);
    assert_eq!(sent[2].params["target_id"], "booking");
    assert_eq!(serde_json::to_value(sent[3].method).unwrap(), "browser.act");
    assert_eq!(sent[3].params["snapshot_after"], true);
    assert_eq!(sent[3].params["target_id"], "booking");
}

#[test]
fn loop_recovers_from_stale_ref_with_fresh_snapshot() {
    let transport = QueuedTransport::new(vec![
        serde_json::json!({
            "ok": true,
            "result": {
                "targetId": "booking",
                "url": "http://fixture",
                "snapshot": "- button \"Cerca\" [ref=e1]",
                "refsMode": "aria",
                "snapshotFormat": "ai",
                "stats": {"refs": 1}
            }
        }),
        serde_json::json!({
            "ok": false,
            "error": {
                "code": "BROWSER_STALE_REF",
                "message": "ref is stale; take a fresh snapshot",
                "retryable": true,
                "manual_action_required": false
            }
        }),
        serde_json::json!({
            "ok": true,
            "result": {
                "targetId": "booking",
                "url": "http://fixture",
                "snapshot": "- button \"Cerca\" [ref=e2]",
                "refsMode": "aria",
                "snapshotFormat": "ai",
                "stats": {"refs": 1}
            }
        }),
        serde_json::json!({
            "ok": true,
            "result": {
                "ok": true,
                "targetId": "booking",
                "url": "http://fixture/results",
                "snapshot": "Risultato finale",
                "refsMode": "aria",
                "snapshotFormat": "ai",
                "stats": {"refs": 0}
            }
        }),
    ]);
    let sent = Rc::clone(&transport.sent);
    let mut runner = BrowserLoopRunner::new(transport, StaleRefPlanner);
    let request = BrowserLoopRequest::new("cerca treni", "booking").with_max_iterations(4);

    let output = runner.run(&request).unwrap();

    assert!(output.completed);
    assert_eq!(output.iterations.len(), 2);
    assert_eq!(output.iterations[0].status, "stale_ref_recovered");
    assert_eq!(output.iterations[1].status, "observed");

    let sent = sent.borrow();
    assert_eq!(
        serde_json::to_value(sent[0].method).unwrap(),
        "browser.snapshot"
    );
    assert_eq!(serde_json::to_value(sent[1].method).unwrap(), "browser.act");
    assert_eq!(
        serde_json::to_value(sent[2].method).unwrap(),
        "browser.snapshot"
    );
    assert_eq!(serde_json::to_value(sent[3].method).unwrap(), "browser.act");
    assert_eq!(sent[3].params["ref"], "e2");
}

#[test]
fn loop_recovers_from_planner_stale_ref_validation_error() {
    let transport = QueuedTransport::new(vec![
        serde_json::json!({
            "ok": true,
            "result": {
                "targetId": "booking",
                "url": "http://fixture/results",
                "snapshot": "- button \"Risultati\" [ref=e44]",
                "refsMode": "aria",
                "snapshotFormat": "ai",
                "stats": {"refs": 1}
            }
        }),
        serde_json::json!({
            "ok": true,
            "result": {
                "targetId": "booking",
                "url": "http://fixture/results",
                "snapshot": "- button \"Risultati\" [ref=e45]",
                "refsMode": "aria",
                "snapshotFormat": "ai",
                "stats": {"refs": 1}
            }
        }),
    ]);
    let mut runner = BrowserLoopRunner::new(transport, PlannerValidationErrorThenCompletePlanner);
    let request = BrowserLoopRequest::new("cerca treni", "booking").with_max_iterations(3);

    let output = runner.run(&request).unwrap();

    assert!(output.completed);
    assert_eq!(output.output["answer"], "recovered");
    assert_eq!(output.iterations.len(), 1);
    assert_eq!(output.iterations[0].status, "stale_ref_rejected");
}

#[test]
fn loop_recovers_from_retryable_action_error_with_fresh_snapshot() {
    let transport = QueuedTransport::new(vec![
        serde_json::json!({
            "ok": true,
            "result": {
                "targetId": "booking",
                "url": "http://fixture/results",
                "snapshot": "- combobox \"Filtra risultati\" [ref=e95]",
                "refsMode": "aria",
                "snapshotFormat": "ai",
                "stats": {"refs": 1}
            }
        }),
        serde_json::json!({
            "ok": false,
            "error": {
                "code": "BROWSER_FORM_FILL_FAILED",
                "message": "e95: locator.fill: Error: Element is not an <input>",
                "retryable": true,
                "manual_action_required": false
            }
        }),
        serde_json::json!({
            "ok": true,
            "result": {
                "targetId": "booking",
                "url": "http://fixture/results",
                "snapshot": "- combobox \"Filtra risultati\" [ref=e96]\n- text \"Nessun campo origine visibile\"",
                "refsMode": "aria",
                "snapshotFormat": "ai",
                "stats": {"refs": 1}
            }
        }),
    ]);
    let mut runner = BrowserLoopRunner::new(transport, RecoverableActionErrorThenCompletePlanner);
    let request = BrowserLoopRequest::new("cerca treni", "booking").with_max_iterations(3);

    let output = runner.run(&request).unwrap();

    assert!(output.completed);
    assert_eq!(output.output["answer"], "recovered from action error");
    assert_eq!(output.iterations.len(), 1);
    assert_eq!(output.iterations[0].status, "action_error_recovered");
    assert_eq!(
        output.iterations[0].action["error_code"],
        "BROWSER_FORM_FILL_FAILED"
    );
}

#[test]
fn loop_stops_after_repeated_retryable_action_errors_without_progress() {
    let unchanged_snapshot = "- combobox \"Filtra risultati\" [ref=e95]";
    let observation = || {
        serde_json::json!({
            "ok": true,
            "result": {
                "targetId": "booking",
                "url": "http://fixture/results",
                "snapshot": unchanged_snapshot,
                "refsMode": "aria",
                "snapshotFormat": "ai",
                "stats": {"refs": 1}
            }
        })
    };
    let retryable_error = || {
        serde_json::json!({
            "ok": false,
            "error": {
                "code": "BROWSER_FORM_FILL_FAILED",
                "message": "e95: locator.fill: Error: Element is not an <input>",
                "retryable": true,
                "manual_action_required": false
            }
        })
    };
    let transport = QueuedTransport::new(vec![
        observation(),
        retryable_error(),
        observation(),
        retryable_error(),
        observation(),
    ]);
    let mut runner = BrowserLoopRunner::new(transport, RepeatedRecoverableActionErrorPlanner);
    let request = BrowserLoopRequest::new("cerca treni", "booking").with_max_iterations(6);

    let output = runner.run(&request).unwrap();

    assert!(!output.completed);
    assert_eq!(output.iterations.len(), 2);
    assert!(
        output.output["blocked_reason"]
            .as_str()
            .unwrap()
            .contains("retryable action errors")
    );
}

#[test]
fn loop_event_payload_is_compact_and_auditable() {
    let iteration = local_first_browser_automation::BrowserLoopIteration {
        iteration: 3,
        url_before: "https://example.test/form".to_string(),
        snapshot_hash_before: "a".to_string(),
        action: serde_json::json!({"kind": "click", "ref": "e42"}),
        expected_observation: Some("calendar opens".to_string()),
        url_after: "https://example.test/form".to_string(),
        snapshot_hash_after: "b".to_string(),
        status: "observed".to_string(),
    };

    let payload = browser_loop_event_payload(&iteration);

    assert_eq!(payload["iteration"], 3);
    assert_eq!(payload["action"]["ref"], "e42");
    assert_eq!(payload["expected_observation"], "calendar opens");
    assert!(payload.get("snapshot").is_none());
}

#[test]
fn loop_stops_after_repeated_no_progress_actions() {
    let unchanged_snapshot = "- button \"Search\" [ref=e1]";
    let unchanged_observation = || {
        serde_json::json!({
            "ok": true,
            "result": {
                "targetId": "booking",
                "url": "http://fixture",
                "snapshot": unchanged_snapshot,
                "refsMode": "aria",
                "snapshotFormat": "ai",
                "stats": {"refs": 1}
            }
        })
    };
    let transport = QueuedTransport::new(vec![
        unchanged_observation(),
        serde_json::json!({
            "ok": true,
            "result": {
                "ok": true,
                "targetId": "booking",
                "url": "http://fixture",
                "snapshot": unchanged_snapshot,
                "refsMode": "aria",
                "snapshotFormat": "ai",
                "stats": {"refs": 1}
            }
        }),
        serde_json::json!({
            "ok": true,
            "result": {
                "ok": true,
                "targetId": "booking",
                "url": "http://fixture",
                "snapshot": unchanged_snapshot,
                "refsMode": "aria",
                "snapshotFormat": "ai",
                "stats": {"refs": 1}
            }
        }),
    ]);
    let mut runner = BrowserLoopRunner::new(transport, NoProgressPlanner);
    let request = BrowserLoopRequest::new("cerca treni", "booking").with_max_iterations(6);

    let output = runner.run(&request).unwrap();

    assert!(!output.completed);
    assert_eq!(output.iterations.len(), 2);
    assert_eq!(output.iterations[0].status, "no_progress");
    assert_eq!(output.iterations[1].status, "no_progress");
    assert!(
        output.output["blocked_reason"]
            .as_str()
            .unwrap()
            .contains("no observable progress")
    );
}
