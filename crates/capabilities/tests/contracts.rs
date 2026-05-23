use local_first_capabilities::{
    ActionClass, CapabilityProviderKind, CapabilityTool, DataBoundary, ManagedProviderMetadata,
    ProviderId, SkillManifest, SkillPermissions, SkillToolManifest, UserId, WorkspaceId,
};

#[test]
fn provider_and_workspace_ids_are_stable() {
    let user = UserId::new("user_1");
    let workspace = WorkspaceId::new("workspace_1");
    let provider = ProviderId::new("composio");

    assert_eq!(user.as_str(), "user_1");
    assert_eq!(workspace.as_str(), "workspace_1");
    assert_eq!(provider.as_str(), "composio");
}

#[test]
fn managed_provider_metadata_marks_cloud_boundary() {
    let metadata = ManagedProviderMetadata {
        provider_name: "Composio".to_string(),
        data_boundary: DataBoundary::ManagedCloud,
        auth_mode: "oauth".to_string(),
        data_categories: vec!["calendar_events".to_string(), "email_metadata".to_string()],
        retention_notes: Some("Provider retention depends on connected toolkit.".to_string()),
    };

    let encoded = serde_json::to_value(&metadata).unwrap();

    assert_eq!(encoded["data_boundary"], "managed_cloud");
    assert_eq!(encoded["provider_name"], "Composio");
}

#[test]
fn capability_tool_serializes_action_and_provider_kind() {
    let tool = CapabilityTool {
        name: "gmail.search".to_string(),
        provider_id: ProviderId::new("composio"),
        provider_kind: CapabilityProviderKind::Managed,
        action: ActionClass::Read,
        description: "Search Gmail messages".to_string(),
        privacy_domains: vec!["work".to_string()],
        sensitivity: "private".to_string(),
        input_schema: serde_json::json!({
            "type": "object",
            "properties": {
                "query": {"type": "string"}
            },
            "required": ["query"]
        }),
    };

    let encoded = serde_json::to_value(&tool).unwrap();

    assert_eq!(encoded["provider_kind"], "managed");
    assert_eq!(encoded["action"], "read");
    assert_eq!(encoded["input_schema"]["required"][0], "query");
}

#[test]
fn skill_manifest_declares_permissions_without_runtime_execution() {
    let manifest = SkillManifest {
        id: "github-local".to_string(),
        version: "0.1.0".to_string(),
        description: "Local GitHub tools".to_string(),
        runtime: "quickjs".to_string(),
        tools: vec![SkillToolManifest {
            name: "github.list_issues".to_string(),
            description: "List GitHub issues".to_string(),
            action: ActionClass::Read,
            privacy_domains: vec!["work".to_string()],
            sensitivity: "private".to_string(),
            input_schema: serde_json::json!({"type": "object"}),
        }],
        permissions: SkillPermissions {
            network: vec!["api.github.com".to_string()],
            filesystem: vec![],
            privacy_domains: vec!["work".to_string()],
        },
    };

    let encoded = serde_json::to_string(&manifest).unwrap();
    let decoded: SkillManifest = serde_json::from_str(&encoded).unwrap();

    assert_eq!(decoded.id, "github-local");
    assert_eq!(decoded.tools[0].name, "github.list_issues");
    assert_eq!(decoded.permissions.network, vec!["api.github.com"]);
    assert_eq!(decoded.permissions.privacy_domains, vec!["work"]);
}
