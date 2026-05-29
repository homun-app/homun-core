use local_first_capabilities::{
    ActionClass, CachedCapabilityTool, CapabilityConnectionConfig, CapabilityFacade,
    CapabilityPolicy, CapabilityProviderConfig, CapabilityProviderGrant, CapabilityProviderKind,
    CapabilityRegistryStore, CapabilityTool, ConnectionStatus, DataBoundary,
    FakeCapabilityProvider, InMemoryCapabilityAudit, ManagedProviderMetadata, ProviderId, UserId,
    WorkspaceId,
};
use local_first_secrets::{InMemorySecretStore, SecretMaterial, SecretRef, SecretStore};
use local_first_task_runtime::ResourceClass;

#[test]
fn registry_creates_schema_and_migrations_are_idempotent() {
    let store = CapabilityRegistryStore::open_in_memory().unwrap();
    assert_eq!(store.schema_version().unwrap(), 1);
    store.run_migrations().unwrap();
    assert_eq!(store.schema_version().unwrap(), 1);
}

#[test]
fn registry_round_trips_provider_config_with_resource_hint() {
    let store = CapabilityRegistryStore::open_in_memory().unwrap();
    let config = provider_config("github", CapabilityProviderKind::Native)
        .with_resource_class(ResourceClass::FilesystemIo)
        .with_rate_limit_per_minute(60);

    store.upsert_provider_config(&config).unwrap();
    let loaded = store
        .provider_config(&ProviderId::new("github"))
        .unwrap()
        .unwrap();

    assert_eq!(loaded.provider_id, ProviderId::new("github"));
    assert_eq!(loaded.provider_kind, CapabilityProviderKind::Native);
    assert_eq!(loaded.resource_class, ResourceClass::FilesystemIo);
    assert_eq!(loaded.rate_limit_per_minute, Some(60));
}

#[test]
fn registry_derives_policy_context_from_enabled_grants() {
    let store = CapabilityRegistryStore::open_in_memory().unwrap();
    store
        .upsert_provider_config(&provider_config("github", CapabilityProviderKind::Native))
        .unwrap();
    store
        .upsert_provider_grant(
            &CapabilityProviderGrant::new(
                ProviderId::new("github"),
                UserId::new("user_1"),
                WorkspaceId::new("workspace_1"),
            )
            .with_privacy_domains(vec!["work".to_string(), "code".to_string()])
            .with_allowed_actions(vec![ActionClass::Read, ActionClass::Draft])
            .with_max_autonomy_level(2),
        )
        .unwrap();

    let context = store
        .policy_context(&UserId::new("user_1"), &WorkspaceId::new("workspace_1"))
        .unwrap();

    assert_eq!(context.enabled_providers, vec![ProviderId::new("github")]);
    assert_eq!(context.privacy_domains, vec!["code", "work"]);
    assert_eq!(
        context.allowed_actions,
        vec![ActionClass::Read, ActionClass::Draft]
    );
    assert_eq!(context.max_autonomy_level, 2);
    assert!(!context.allow_managed_cloud);
}

#[test]
fn registry_excludes_disabled_grants_and_requires_managed_opt_in() {
    let store = CapabilityRegistryStore::open_in_memory().unwrap();
    store
        .upsert_provider_config(&provider_config("github", CapabilityProviderKind::Native))
        .unwrap();
    store
        .upsert_provider_config(
            &provider_config("composio", CapabilityProviderKind::Managed).with_managed_metadata(
                ManagedProviderMetadata {
                    provider_name: "Composio".to_string(),
                    data_boundary: DataBoundary::ManagedCloud,
                    auth_mode: "composio_connect".to_string(),
                    data_categories: vec!["email".to_string()],
                    retention_notes: Some("managed provider".to_string()),
                },
            ),
        )
        .unwrap();
    store
        .upsert_provider_grant(
            &CapabilityProviderGrant::new(
                ProviderId::new("github"),
                UserId::new("user_1"),
                WorkspaceId::new("workspace_1"),
            )
            .disabled(),
        )
        .unwrap();
    store
        .upsert_provider_grant(
            &CapabilityProviderGrant::new(
                ProviderId::new("composio"),
                UserId::new("user_1"),
                WorkspaceId::new("workspace_1"),
            )
            .with_privacy_domains(vec!["work".to_string()])
            .with_allowed_actions(vec![ActionClass::Read])
            .with_allow_managed_cloud(true),
        )
        .unwrap();

    let context = store
        .policy_context(&UserId::new("user_1"), &WorkspaceId::new("workspace_1"))
        .unwrap();

    assert_eq!(context.enabled_providers, vec![ProviderId::new("composio")]);
    assert!(context.allow_managed_cloud);
}

#[test]
fn registry_round_trips_connection_metadata_with_secret_ref_only() {
    let store = CapabilityRegistryStore::open_in_memory().unwrap();
    let connection = CapabilityConnectionConfig::new(
        "conn_1",
        ProviderId::new("github"),
        UserId::new("user_1"),
        WorkspaceId::new("workspace_1"),
        "GitHub Work",
        "keychain://github/conn_1",
    )
    .with_privacy_domains(vec!["work".to_string()])
    .with_metadata(serde_json::json!({"account": "fabio", "api_key": "must_not_store"}));

    store.upsert_connection_config(&connection).unwrap();
    let loaded = store
        .connection_configs(&UserId::new("user_1"), &WorkspaceId::new("workspace_1"))
        .unwrap();

    assert_eq!(loaded.len(), 1);
    assert_eq!(loaded[0].connection_id, "conn_1");
    assert_eq!(loaded[0].status, ConnectionStatus::Active);
    assert_eq!(loaded[0].secret_ref, "keychain://github/conn_1");
    assert_eq!(loaded[0].metadata["account"], "fabio");
    assert!(loaded[0].metadata.get("api_key").is_none());
}

#[test]
fn registry_stores_connection_secret_material_outside_database() {
    let store = CapabilityRegistryStore::open_in_memory().unwrap();
    let secrets = InMemorySecretStore::default();
    let reference = SecretRef::new("user_1", "workspace_1", "github", "conn_1").unwrap();
    let connection = CapabilityConnectionConfig::new(
        "conn_1",
        ProviderId::new("github"),
        UserId::new("user_1"),
        WorkspaceId::new("workspace_1"),
        "GitHub Work",
        reference.as_str(),
    )
    .with_metadata(serde_json::json!({"token": "must-not-persist"}));

    store
        .upsert_connection_config_with_secret(
            &connection,
            &secrets,
            reference.clone(),
            SecretMaterial::from_string("ghp_secret_value"),
        )
        .unwrap();

    let loaded = store
        .connection_configs(&UserId::new("user_1"), &WorkspaceId::new("workspace_1"))
        .unwrap();

    assert_eq!(loaded[0].secret_ref, reference.as_str());
    assert_eq!(loaded[0].metadata, serde_json::json!({}));
    assert_eq!(
        secrets
            .get(&reference)
            .unwrap()
            .unwrap()
            .expose_utf8()
            .unwrap(),
        "ghp_secret_value"
    );
}

#[test]
fn registry_round_trips_tool_cache_for_provider() {
    let store = CapabilityRegistryStore::open_in_memory().unwrap();
    let cached = CachedCapabilityTool::new(
        ProviderId::new("github"),
        "github.search",
        CapabilityProviderKind::Native,
        ActionClass::Read,
        "Search GitHub",
        vec!["work".to_string()],
        "private",
        serde_json::json!({
            "type": "object",
            "required": ["query"],
            "properties": {"query": {"type": "string"}}
        }),
    );

    store.upsert_cached_tool(&cached).unwrap();
    let tools = store.cached_tools(&ProviderId::new("github")).unwrap();

    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0].tool.name, "github.search");
    assert_eq!(tools[0].tool.provider_id, ProviderId::new("github"));
    assert_eq!(tools[0].tool.input_schema["required"][0], "query");
}

#[test]
fn registry_policy_context_filters_facade_tools() {
    let store = CapabilityRegistryStore::open_in_memory().unwrap();
    store
        .upsert_provider_config(&provider_config("github", CapabilityProviderKind::Native))
        .unwrap();
    store
        .upsert_provider_grant(
            &CapabilityProviderGrant::new(
                ProviderId::new("github"),
                UserId::new("user_1"),
                WorkspaceId::new("workspace_1"),
            )
            .with_privacy_domains(vec!["work".to_string()])
            .with_allowed_actions(vec![ActionClass::Read])
            .with_max_autonomy_level(1),
        )
        .unwrap();

    let mut facade = CapabilityFacade::new(CapabilityPolicy::new(), InMemoryCapabilityAudit::new());
    facade.register_provider(FakeCapabilityProvider::new(
        ProviderId::new("github"),
        CapabilityProviderKind::Native,
        true,
        None,
        vec![
            tool("github.search", ActionClass::Read),
            tool("github.create_issue", ActionClass::WriteWithConfirmation),
        ],
    ));

    let context = store
        .policy_context(&UserId::new("user_1"), &WorkspaceId::new("workspace_1"))
        .unwrap();
    let access = facade.list_tools(&context).unwrap();

    assert_eq!(
        access.visible_tool_names(),
        vec!["github.create_issue", "github.search"]
    );
    assert_eq!(access.executable_tool_names(), vec!["github.search"]);
}

fn provider_config(
    provider_id: impl Into<String>,
    provider_kind: CapabilityProviderKind,
) -> CapabilityProviderConfig {
    CapabilityProviderConfig::new(
        ProviderId::new(provider_id),
        provider_kind,
        "Provider".to_string(),
        false,
    )
}

fn tool(name: impl Into<String>, action: ActionClass) -> CapabilityTool {
    CapabilityTool {
        name: name.into(),
        provider_id: ProviderId::new("github"),
        provider_kind: CapabilityProviderKind::Native,
        action,
        description: "GitHub tool".to_string(),
        privacy_domains: vec!["work".to_string()],
        sensitivity: "private".to_string(),
        input_schema: serde_json::json!({"type": "object"}),
    }
}
