use local_first_host_computer::{
    protocol::{AppSnapshot, HostElement, SemanticAction, SnapshotTreeMode},
    redaction::{DisclosurePolicy, ProviderDisclosure, project_snapshot},
};

fn snapshot(value: Option<&str>, sensitive: bool) -> AppSnapshot {
    AppSnapshot {
        snapshot_id: "snapshot".into(),
        generation: 1,
        captured_at_unix_ms: 0,
        tree_mode: SnapshotTreeMode::Full,
        base_snapshot_id: None,
        elements: vec![HostElement {
            index: 4,
            role: "AXTextField".into(),
            subrole: None,
            label: Some("Email".into()),
            help: None,
            value: value.map(str::to_string),
            bounds: None,
            enabled: true,
            focused: false,
            selected: None,
            expanded: None,
            sensitive,
            actions: vec![SemanticAction::Press],
            parent_index: None,
            child_indices: vec![],
        }],
        focused_element_index: None,
        screenshot_ref: None,
        truncated: false,
    }
}

#[test]
fn remote_projection_preserves_structure_and_actionability() {
    let projected = project_snapshot(
        &snapshot(Some("customer@example.com"), false),
        ProviderDisclosure::Remote,
        DisclosurePolicy {
            disclose_screenshots_to_remote: false,
        },
    );
    assert_eq!(projected.elements[0].index, 4);
    assert_eq!(projected.elements[0].value.as_deref(), Some("[redacted]"));
    assert_eq!(projected.elements[0].actions, [SemanticAction::Press]);
}

#[test]
fn unknown_provider_fails_closed_and_secure_controls_have_no_affordance() {
    let projected = project_snapshot(
        &snapshot(Some("secret"), true),
        ProviderDisclosure::Unknown,
        DisclosurePolicy {
            disclose_screenshots_to_remote: true,
        },
    );
    assert_eq!(projected.elements[0].value, None);
    assert!(projected.elements[0].actions.is_empty());
}
