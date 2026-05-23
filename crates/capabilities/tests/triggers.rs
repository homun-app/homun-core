use local_first_capabilities::{
    CapabilityProvider, CapabilityProviderKind, CapabilityTrigger, FakeCapabilityProvider,
    ProviderId, TriggerStatus,
};

#[test]
fn fake_provider_lists_enables_and_disables_triggers() {
    let mut provider = FakeCapabilityProvider::new(
        ProviderId::new("composio"),
        CapabilityProviderKind::Managed,
        true,
        None,
        vec![],
    );
    provider.add_trigger(CapabilityTrigger {
        id: "trigger_1".to_string(),
        provider_id: ProviderId::new("composio"),
        name: "gmail.new_message".to_string(),
        status: TriggerStatus::Disabled,
        privacy_domains: vec!["work".to_string()],
        config: serde_json::json!({"label": "inbox"}),
    });

    assert_eq!(provider.list_triggers().unwrap()[0].status, TriggerStatus::Disabled);

    provider.enable_trigger("trigger_1").unwrap();
    assert_eq!(provider.list_triggers().unwrap()[0].status, TriggerStatus::Active);

    provider.disable_trigger("trigger_1").unwrap();
    assert_eq!(provider.list_triggers().unwrap()[0].status, TriggerStatus::Disabled);
}
