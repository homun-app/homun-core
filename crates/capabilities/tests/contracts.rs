use local_first_capabilities::{
    ActionClass, CapabilityProviderKind, CapabilityTool, DataBoundary, ManagedProviderMetadata,
    PluginCapabilityDeclaration, PluginCapabilityKind, PluginChannel, PluginEntitlement,
    PluginManifest, PluginRegistryEntry, PluginRegistryIndex, PluginSignature, ProviderId,
    SkillManifest, SkillPermissions, SkillToolManifest, UserId, WorkspaceId,
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

#[test]
fn plugin_manifest_declares_distribution_and_capability_contract() {
    let mut manifest = PluginManifest::new(
        "presentations-pro",
        "1.2.3",
        "Presentations Pro",
        vec![sample_skill_manifest()],
    );
    manifest.channel = PluginChannel::Beta;
    manifest.min_homun_version = Some("0.1.1046".to_string());
    manifest.entitlement = PluginEntitlement::Paid;
    manifest.signature = Some(PluginSignature {
        algorithm: "ed25519".to_string(),
        public_key: "pk_live_test".to_string(),
        signature: "sig_live_test".to_string(),
    });
    manifest.capabilities = vec![PluginCapabilityDeclaration {
        id: "make_deck".to_string(),
        kind: PluginCapabilityKind::Workflow,
        description: "Create and render presentation decks".to_string(),
        action: ActionClass::WriteWithConfirmation,
        privacy_domains: vec!["project".to_string()],
    }];

    let encoded = serde_json::to_value(&manifest).unwrap();
    let decoded: PluginManifest = serde_json::from_value(encoded.clone()).unwrap();

    assert_eq!(encoded["channel"], "beta");
    assert_eq!(encoded["entitlement"], "paid");
    assert_eq!(encoded["min_homun_version"], "0.1.1046");
    assert_eq!(encoded["signature"]["algorithm"], "ed25519");
    assert_eq!(encoded["capabilities"][0]["kind"], "workflow");
    assert_eq!(decoded.channel, PluginChannel::Beta);
    assert_eq!(
        decoded.capabilities[0].action,
        ActionClass::WriteWithConfirmation
    );
}

#[test]
fn plugin_manifest_legacy_json_defaults_to_stable_free() {
    let decoded: PluginManifest = serde_json::from_value(serde_json::json!({
        "id": "legacy-plugin",
        "version": "0.1.0",
        "display_name": "Legacy Plugin",
        "skills": [sample_skill_manifest()]
    }))
    .unwrap();

    assert_eq!(decoded.channel, PluginChannel::Stable);
    assert_eq!(decoded.entitlement, PluginEntitlement::Free);
    assert_eq!(decoded.min_homun_version, None);
    assert_eq!(decoded.signature, None);
    assert!(decoded.capabilities.is_empty());
}

#[test]
fn plugin_registry_index_declares_signed_packages() {
    let index = PluginRegistryIndex {
        schema_version: 1,
        generated_at: "2026-06-24T00:00:00Z".to_string(),
        plugins: vec![PluginRegistryEntry {
            plugin_id: "presentations-pro".to_string(),
            version: "1.2.3".to_string(),
            channel: PluginChannel::Stable,
            min_homun_version: Some("0.1.1046".to_string()),
            entitlement: PluginEntitlement::Paid,
            manifest_url: "https://homun.app/plugins/presentations-pro/manifest.json".to_string(),
            package_url: "https://homun.app/plugins/presentations-pro/presentations-pro-1.2.3.hplugin".to_string(),
            package_sha256: "sha256:abc123".to_string(),
            signature: PluginSignature {
                algorithm: "ed25519".to_string(),
                public_key: "pk_live_test".to_string(),
                signature: "sig_live_test".to_string(),
            },
        }],
    };

    let encoded = serde_json::to_value(&index).unwrap();
    let decoded: PluginRegistryIndex = serde_json::from_value(encoded.clone()).unwrap();

    assert_eq!(encoded["schema_version"], 1);
    assert_eq!(encoded["plugins"][0]["channel"], "stable");
    assert_eq!(encoded["plugins"][0]["package_sha256"], "sha256:abc123");
    assert_eq!(encoded["plugins"][0]["signature"]["algorithm"], "ed25519");
    assert_eq!(decoded.plugins[0].entitlement, PluginEntitlement::Paid);
}

fn sample_skill_manifest() -> SkillManifest {
    SkillManifest {
        id: "deck-local".to_string(),
        version: "1.2.3".to_string(),
        description: "Deck generation tools".to_string(),
        runtime: "process".to_string(),
        tools: vec![SkillToolManifest {
            name: "deck.render".to_string(),
            description: "Render a deck".to_string(),
            action: ActionClass::WriteWithConfirmation,
            privacy_domains: vec!["project".to_string()],
            sensitivity: "private".to_string(),
            input_schema: serde_json::json!({"type": "object"}),
        }],
        permissions: SkillPermissions {
            network: vec![],
            filesystem: vec!["project".to_string()],
            privacy_domains: vec!["project".to_string()],
        },
    }
}
