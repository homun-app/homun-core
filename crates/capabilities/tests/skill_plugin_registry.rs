use local_first_capabilities::{
    ActionClass, CapabilityCall, CapabilityFacade, CapabilityPolicy, CapabilityProvider,
    CapabilityProviderGrant, CapabilityProviderKind, InMemoryCapabilityAudit, PluginInstallRecord,
    PluginManifest, ProviderId, SkillCapabilityProvider, SkillInstallRecord, SkillManifest,
    SkillPermissions, SkillPluginRegistryStore, SkillToolManifest, SkillTrustLevel, UserId,
    WorkspaceId,
};

#[test]
fn contracts_serialize_skill_plugin_manifests() {
    let skill = sample_skill_manifest("calendar-local", "0.1.0");
    let plugin = PluginManifest::new(
        "productivity-suite",
        "0.1.0",
        "Productivity Suite",
        vec![skill.clone()],
    );
    let skill_install = SkillInstallRecord::new(
        UserId::new("user_1"),
        WorkspaceId::new("workspace_1"),
        skill.id.clone(),
        skill.version.clone(),
        "/plugins/productivity/calendar",
        SkillTrustLevel::TrustedLocal,
    )
    .with_manifest_hash("sha256:calendar");
    let plugin_install = PluginInstallRecord::new(
        UserId::new("user_1"),
        WorkspaceId::new("workspace_1"),
        plugin.id.clone(),
        plugin.version.clone(),
        "/plugins/productivity",
        SkillTrustLevel::TrustedLocal,
    )
    .with_manifest_hash("sha256:plugin");

    let encoded = serde_json::to_value(&plugin).unwrap();
    let decoded: PluginManifest = serde_json::from_value(encoded).unwrap();
    let encoded_install = serde_json::to_value(&skill_install).unwrap();

    assert_eq!(decoded.id, "productivity-suite");
    assert_eq!(decoded.skills[0].tools[0].name, "calendar.search");
    assert_eq!(decoded.skills[0].tools[0].action, ActionClass::Read);
    assert_eq!(decoded.skills[0].permissions.privacy_domains, vec!["work"]);
    assert_eq!(
        skill_install.provider_id(),
        ProviderId::new("skill:calendar-local")
    );
    assert!(skill_install.enabled);
    assert_eq!(encoded_install["trust_level"], "trusted_local");
    assert_eq!(encoded_install["manifest_hash"], "sha256:calendar");
    assert_eq!(plugin_install.trust_level, SkillTrustLevel::TrustedLocal);
}

#[test]
fn registry_round_trips_skill_manifests_and_installs_by_scope() {
    let store = SkillPluginRegistryStore::open_in_memory().unwrap();
    assert_eq!(store.schema_version().unwrap(), 1);
    store.run_migrations().unwrap();

    let manifest = sample_skill_manifest("calendar-local", "0.1.0");
    let user_1 = UserId::new("user_1");
    let user_2 = UserId::new("user_2");
    let workspace = WorkspaceId::new("workspace_1");
    let install = SkillInstallRecord::new(
        user_1.clone(),
        workspace.clone(),
        manifest.id.clone(),
        manifest.version.clone(),
        "/plugins/productivity/calendar",
        SkillTrustLevel::Reviewed,
    )
    .with_manifest_hash("sha256:calendar");
    let other_user_install = SkillInstallRecord::new(
        user_2.clone(),
        workspace.clone(),
        manifest.id.clone(),
        manifest.version.clone(),
        "/plugins/productivity/calendar",
        SkillTrustLevel::Untrusted,
    )
    .disabled();

    store.upsert_skill_manifest(&manifest).unwrap();
    store.upsert_skill_install(&install).unwrap();
    store.upsert_skill_install(&other_user_install).unwrap();

    let loaded_manifest = store
        .skill_manifest("calendar-local", "0.1.0")
        .unwrap()
        .unwrap();
    let user_1_installs = store.skill_installs(&user_1, &workspace).unwrap();
    let user_2_installs = store.skill_installs(&user_2, &workspace).unwrap();

    assert_eq!(loaded_manifest.tools[0].name, "calendar.search");
    assert_eq!(user_1_installs, vec![install]);
    assert_eq!(user_2_installs, vec![other_user_install]);
}

#[test]
fn registry_registers_plugin_manifest_and_bundled_skills() {
    let store = SkillPluginRegistryStore::open_in_memory().unwrap();
    let calendar = sample_skill_manifest("calendar-local", "0.1.0");
    let files = sample_skill_manifest("files-local", "0.2.0");
    let plugin = PluginManifest::new(
        "productivity-suite",
        "0.1.0",
        "Productivity Suite",
        vec![calendar.clone(), files.clone()],
    );
    let install = PluginInstallRecord::new(
        UserId::new("user_1"),
        WorkspaceId::new("workspace_1"),
        plugin.id.clone(),
        plugin.version.clone(),
        "/plugins/productivity",
        SkillTrustLevel::TrustedLocal,
    );

    store.upsert_plugin_manifest(&plugin).unwrap();
    store.upsert_plugin_install(&install).unwrap();

    let loaded_plugin = store
        .plugin_manifest("productivity-suite", "0.1.0")
        .unwrap()
        .unwrap();
    let loaded_calendar = store
        .skill_manifest("calendar-local", "0.1.0")
        .unwrap()
        .unwrap();
    let plugin_installs = store
        .plugin_installs(&UserId::new("user_1"), &WorkspaceId::new("workspace_1"))
        .unwrap();

    assert_eq!(loaded_plugin.skills.len(), 2);
    assert_eq!(loaded_calendar.id, calendar.id);
    assert_eq!(plugin_installs, vec![install]);
}

#[test]
fn skill_provider_exposes_only_enabled_install_tools_for_scope() {
    let store = SkillPluginRegistryStore::open_in_memory().unwrap();
    let user = UserId::new("user_1");
    let workspace = WorkspaceId::new("workspace_1");
    let calendar = sample_skill_manifest("calendar-local", "0.1.0");
    let files = sample_skill_manifest("files-local", "0.1.0");
    store.upsert_skill_manifest(&calendar).unwrap();
    store.upsert_skill_manifest(&files).unwrap();
    store
        .upsert_skill_install(&SkillInstallRecord::new(
            user.clone(),
            workspace.clone(),
            calendar.id.clone(),
            calendar.version.clone(),
            "/plugins/calendar",
            SkillTrustLevel::Reviewed,
        ))
        .unwrap();
    store
        .upsert_skill_install(
            &SkillInstallRecord::new(
                user.clone(),
                workspace.clone(),
                files.id.clone(),
                files.version.clone(),
                "/plugins/files",
                SkillTrustLevel::Reviewed,
            )
            .disabled(),
        )
        .unwrap();

    let providers = store.enabled_skill_providers(&user, &workspace).unwrap();

    assert_eq!(providers.len(), 1);
    assert_eq!(providers[0].id(), &ProviderId::new("skill:calendar-local"));
    assert_eq!(providers[0].kind(), CapabilityProviderKind::Skill);
    assert_eq!(
        providers[0].list_tools().unwrap()[0].name,
        "calendar.search"
    );
}

#[test]
fn skill_provider_tools_are_filtered_by_capability_policy() {
    let store = SkillPluginRegistryStore::open_in_memory().unwrap();
    let user = UserId::new("user_1");
    let workspace = WorkspaceId::new("workspace_1");
    let manifest = sample_skill_manifest("calendar-local", "0.1.0");
    store.upsert_skill_manifest(&manifest).unwrap();
    store
        .upsert_skill_install(&SkillInstallRecord::new(
            user.clone(),
            workspace.clone(),
            manifest.id.clone(),
            manifest.version.clone(),
            "/plugins/calendar",
            SkillTrustLevel::TrustedLocal,
        ))
        .unwrap();

    let mut facade = CapabilityFacade::new(CapabilityPolicy::new(), InMemoryCapabilityAudit::new());
    for provider in store.enabled_skill_providers(&user, &workspace).unwrap() {
        facade.register_provider(provider);
    }
    let context = CapabilityProviderGrant::new(
        ProviderId::new("skill:calendar-local"),
        user.clone(),
        workspace.clone(),
    )
    .with_privacy_domains(vec!["work".to_string()])
    .with_allowed_actions(vec![ActionClass::Read])
    .with_max_autonomy_level(0);
    let policy_context = local_first_capabilities::PolicyContext {
        user_id: user,
        workspace_id: workspace,
        enabled_providers: vec![context.provider_id],
        privacy_domains: context.privacy_domains,
        allowed_actions: context.allowed_actions,
        max_autonomy_level: context.max_autonomy_level,
        allow_managed_cloud: false,
    };

    let access = facade.list_tools(&policy_context).unwrap();

    assert_eq!(access.visible_tool_names(), vec!["calendar.search"]);
    assert_eq!(access.executable_tool_names(), vec!["calendar.search"]);
}

#[test]
fn skill_provider_refuses_direct_execution_until_sandbox_runtime_exists() {
    let provider = SkillCapabilityProvider::new(sample_skill_manifest("calendar-local", "0.1.0"));
    let error = provider
        .call_tool(&CapabilityCall {
            provider_id: ProviderId::new("skill:calendar-local"),
            tool_name: "calendar.search".to_string(),
            arguments: serde_json::json!({"query": "standup"}),
        })
        .unwrap_err();

    assert_eq!(
        error.as_str(),
        "skill_execution_unavailable:calendar.search"
    );
}

fn sample_skill_manifest(id: &str, version: &str) -> SkillManifest {
    SkillManifest {
        id: id.to_string(),
        version: version.to_string(),
        description: "Cerca eventi calendario in modo locale".to_string(),
        runtime: "wasm".to_string(),
        tools: vec![SkillToolManifest {
            name: "calendar.search".to_string(),
            description: "Search local calendar events".to_string(),
            action: ActionClass::Read,
            privacy_domains: vec!["work".to_string()],
            sensitivity: "private".to_string(),
            input_schema: serde_json::json!({
                "type": "object",
                "required": ["query"],
                "properties": {
                    "query": {"type": "string"}
                }
            }),
        }],
        permissions: SkillPermissions {
            network: vec!["calendar.local".to_string()],
            filesystem: vec!["~/Calendars".to_string()],
            privacy_domains: vec!["work".to_string()],
        },
    }
}
