use local_first_capabilities::{ActionClass, SkillManifest, SkillPermissions, SkillToolManifest};
use local_first_skill_runtime::{SkillAccess, SkillRuntimeLimits, SkillRuntimeRequest};

#[test]
fn runtime_request_serializes_manifest_tool_arguments_and_declared_access() {
    let request = SkillRuntimeRequest::new(
        sample_skill_manifest(),
        "calendar.search",
        serde_json::json!({"query": "standup"}),
    )
    .with_declared_access(vec![
        SkillAccess::network("https://calendar.local/events"),
        SkillAccess::filesystem("/tmp/calendars/work.ics"),
    ])
    .with_limits(SkillRuntimeLimits {
        timeout_seconds: 10,
        max_output_bytes: 4096,
    });

    let encoded = serde_json::to_value(&request).unwrap();
    let decoded: SkillRuntimeRequest = serde_json::from_value(encoded).unwrap();

    assert_eq!(decoded.manifest.id, "calendar-local");
    assert_eq!(decoded.tool_name, "calendar.search");
    assert_eq!(
        decoded.declared_access[0].target,
        "https://calendar.local/events"
    );
    assert_eq!(decoded.limits.max_output_bytes, 4096);
}

fn sample_skill_manifest() -> SkillManifest {
    SkillManifest {
        id: "calendar-local".to_string(),
        version: "0.1.0".to_string(),
        description: "Local calendar search".to_string(),
        runtime: "local-handler".to_string(),
        tools: vec![SkillToolManifest {
            name: "calendar.search".to_string(),
            description: "Search local calendar events".to_string(),
            action: ActionClass::Read,
            privacy_domains: vec!["work".to_string()],
            sensitivity: "private".to_string(),
            input_schema: serde_json::json!({
                "type": "object",
                "required": ["query"],
                "properties": {"query": {"type": "string"}}
            }),
        }],
        permissions: SkillPermissions {
            network: vec!["calendar.local".to_string()],
            filesystem: vec!["/tmp/calendars".to_string()],
            privacy_domains: vec!["work".to_string()],
        },
    }
}
