use local_first_host_computer::protocol::{
    ActionRequest, ActionResult, ActionTarget, SemanticAction,
};

#[test]
fn action_target_always_carries_snapshot_generation() {
    let request = ActionRequest {
        target: ActionTarget {
            snapshot_id: "snapshot-1".to_string(),
            generation: 7,
            index: 3,
        },
        action: SemanticAction::Press,
        value: None,
    };
    let json = serde_json::to_value(request).unwrap();

    assert_eq!(json["target"]["generation"], 7);
    assert!(json.get("raw_ax_pointer").is_none());
}

#[test]
fn successful_action_requires_a_fresh_snapshot() {
    let result: ActionResult = serde_json::from_value(serde_json::json!({
        "snapshot_required": true
    }))
    .unwrap();
    assert!(result.snapshot_required);
}
