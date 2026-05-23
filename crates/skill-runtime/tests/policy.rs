use local_first_capabilities::{ActionClass, SkillManifest, SkillPermissions, SkillToolManifest};
use local_first_skill_runtime::{
    SkillAccess, SkillExecutionTrace, SkillRuntimeError, SkillRuntimeOutput, SkillRuntimeRequest,
    SkillSandboxPolicy,
};

#[test]
fn sandbox_policy_denies_undeclared_network_and_filesystem_access() {
    let policy = SkillSandboxPolicy::new();
    let manifest = sample_skill_manifest();

    let network_error = policy
        .validate_request(
            SkillRuntimeRequest::new(
                manifest.clone(),
                "calendar.search",
                serde_json::json!({"query": "standup"}),
            )
            .with_declared_access(vec![SkillAccess::network("https://evil.test/events")]),
        )
        .unwrap_err();

    let filesystem_error = policy
        .validate_request(
            SkillRuntimeRequest::new(
                manifest,
                "calendar.search",
                serde_json::json!({"query": "standup"}),
            )
            .with_declared_access(vec![SkillAccess::filesystem("/tmp/private/token.txt")]),
        )
        .unwrap_err();

    assert_eq!(
        network_error,
        SkillRuntimeError::NetworkDenied("evil.test".to_string())
    );
    assert!(matches!(
        filesystem_error,
        SkillRuntimeError::FilesystemDenied(_)
    ));
}

#[test]
fn sandbox_policy_rechecks_runner_trace_and_output_size() {
    let policy = SkillSandboxPolicy::new();
    let validated = policy
        .validate_request(SkillRuntimeRequest::new(
            sample_skill_manifest(),
            "calendar.search",
            serde_json::json!({"query": "standup"}),
        ))
        .unwrap();

    let trace_error = policy
        .validate_output(
            &validated,
            &SkillRuntimeOutput {
                output: serde_json::json!({"events": []}),
                trace: SkillExecutionTrace {
                    accessed_network: vec!["evil.test".to_string()],
                    accessed_filesystem: Vec::new(),
                },
            },
        )
        .unwrap_err();

    assert_eq!(
        trace_error,
        SkillRuntimeError::NetworkDenied("evil.test".to_string())
    );
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
