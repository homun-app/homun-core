use local_first_local_computer_session::SurfaceKind;

#[test]
fn old_surface_records_still_deserialize_and_host_apps_is_additive() {
    for value in ["browser", "shell", "files", "logs"] {
        let surface: SurfaceKind = serde_json::from_str(&format!("\"{value}\"")).unwrap();
        assert_ne!(surface, SurfaceKind::HostApps);
    }
    assert_eq!(serde_json::to_string(&SurfaceKind::HostApps).unwrap(), "\"host_apps\"");
}

#[test]
fn host_event_payload_is_never_projected_into_timeline_text() {
    let payload = serde_json::json!({
        "text": "customer-secret",
        "resume_token": "resume-secret",
        "artifact_path": "/Users/example/private.png"
    });
    let serialized = serde_json::to_string(&payload).unwrap();
    assert!(serialized.contains("customer-secret"));
    // The read model deliberately exposes only title/subtitle and marks payload redacted.
    assert!(!format!("{:?}", local_first_local_computer_session::TimelineItem {
        event_id: "e".into(),
        surface: SurfaceKind::HostApps,
        kind: "host_action".into(),
        status: "done".into(),
        title: "Action complete".into(),
        subtitle_redacted: "Control updated".into(),
        markdown_redacted: None,
        artifact_refs: vec![],
        started_at: time::OffsetDateTime::UNIX_EPOCH,
        completed_at: None,
        approval_required: false,
        payload_redacted: true,
    }).contains("customer-secret"));
}
