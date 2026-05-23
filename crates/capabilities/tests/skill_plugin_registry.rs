use local_first_capabilities::{
    ActionClass, PluginInstallRecord, PluginManifest, ProviderId, SkillInstallRecord,
    SkillManifest, SkillPermissions, SkillToolManifest, SkillTrustLevel, UserId, WorkspaceId,
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
    assert_eq!(skill_install.provider_id(), ProviderId::new("skill:calendar-local"));
    assert!(skill_install.enabled);
    assert_eq!(encoded_install["trust_level"], "trusted_local");
    assert_eq!(encoded_install["manifest_hash"], "sha256:calendar");
    assert_eq!(plugin_install.trust_level, SkillTrustLevel::TrustedLocal);
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
