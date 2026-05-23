use local_first_capabilities::{
    ActionClass, CapabilityProviderKind, CapabilityTool, ProviderId, UserId, WorkspaceId,
};
use local_first_orchestrator::ToolSearchIndexStore;

#[test]
fn tool_index_searches_compact_cards_and_loads_full_tool_details_lazily() {
    let store = ToolSearchIndexStore::open_in_memory().unwrap();
    let tools = vec![
        tool(
            "calendar.search",
            "Search calendar events by title, attendee, date or keyword",
            ActionClass::Read,
        ),
        tool(
            "github.issue_create",
            "Create a GitHub issue draft from a local summary",
            ActionClass::Draft,
        ),
    ];

    store.rebuild_from_tools(&tools).unwrap();
    let cards = store.search("standup calendar", 5).unwrap();

    assert_eq!(cards[0].tool_name, "calendar.search");
    assert_eq!(cards[0].provider_id, ProviderId::new("calendar"));
    assert_eq!(cards[0].schema_hash.len(), 16);
    assert!(
        !serde_json::to_value(&cards[0])
            .unwrap()
            .as_object()
            .unwrap()
            .contains_key("input_schema")
    );

    let detail = store
        .tool_detail(&ProviderId::new("calendar"), "calendar.search")
        .unwrap()
        .unwrap();
    assert_eq!(detail.input_schema["required"][0], "query");
}

#[test]
fn tool_index_deduplicates_provider_tool_rows_in_fts() {
    let store = ToolSearchIndexStore::open_in_memory().unwrap();
    let duplicate = tool(
        "calendar.search",
        "Search calendar events by title, attendee, date or keyword",
        ActionClass::Read,
    );

    store
        .rebuild_from_tools(&[duplicate.clone(), duplicate])
        .unwrap();
    let cards = store.search("calendar", 5).unwrap();

    assert_eq!(cards.len(), 1);
    assert_eq!(cards[0].tool_name, "calendar.search");
}

fn tool(name: &str, description: &str, action: ActionClass) -> CapabilityTool {
    CapabilityTool {
        name: name.to_string(),
        provider_id: ProviderId::new("calendar"),
        provider_kind: CapabilityProviderKind::Native,
        action,
        description: description.to_string(),
        privacy_domains: vec!["work".to_string()],
        sensitivity: "private".to_string(),
        input_schema: serde_json::json!({
            "type": "object",
            "required": ["query"],
            "properties": {"query": {"type": "string"}}
        }),
    }
}

fn _ids() -> (UserId, WorkspaceId) {
    (UserId::new("user"), WorkspaceId::new("workspace"))
}
