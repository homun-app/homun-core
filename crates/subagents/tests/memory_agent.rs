use local_first_memory::{MemoryFacade, SQLiteMemoryStore, UserId, WorkspaceId};
use local_first_subagents::{
    AgentAudit, AgentId, MemoryAgentImport, MemoryAgentImporter, SubagentResult, SubagentStatus,
    TokenMetrics,
};

#[test]
fn memory_agent_imports_extraction_and_routine_inference_through_facade() {
    let facade = MemoryFacade::new(SQLiteMemoryStore::open_in_memory().unwrap());
    let importer = MemoryAgentImporter::new(&facade);
    let result = memory_agent_result();

    let summary = importer
        .import_result(
            &UserId::new("user_1"),
            &WorkspaceId::new("workspace_1"),
            &result,
        )
        .unwrap();

    assert_eq!(summary.memories_imported, 1);
    assert_eq!(summary.routines_imported, 1);
    assert_eq!(facade.access_audit_count().unwrap(), 0);
}

#[test]
fn memory_agent_import_rejects_non_memory_agent_results() {
    let facade = MemoryFacade::new(SQLiteMemoryStore::open_in_memory().unwrap());
    let importer = MemoryAgentImporter::new(&facade);
    let mut result = memory_agent_result();
    result.agent_id = AgentId::Planner;

    let error = importer
        .import_result(
            &UserId::new("user_1"),
            &WorkspaceId::new("workspace_1"),
            &result,
        )
        .unwrap_err();

    assert_eq!(
        error,
        "only MemoryAgent results can be imported into memory"
    );
}

fn memory_agent_result() -> SubagentResult {
    SubagentResult {
        task_id: "memory.task".to_string(),
        agent_id: AgentId::Memory,
        status: SubagentStatus::Succeeded,
        output: serde_json::to_value(MemoryAgentImport {
            memory_extraction: Some(
                serde_json::from_value(serde_json::json!({
                    "memories": [{
                        "memory_type": "preference",
                        "text": "Fabio prefers Zed",
                        "privacy_domain": "work",
                        "sensitivity": "private",
                        "metadata": {}
                    }]
                }))
                .unwrap(),
            ),
            routine_inference: Some(
                serde_json::from_value(serde_json::json!({
                    "routines": [{
                        "name": "Morning startup",
                        "intent": "Open project workspace",
                        "privacy_domain": "work",
                        "sensitivity": "private",
                        "metadata": {}
                    }]
                }))
                .unwrap(),
            ),
        })
        .unwrap(),
        errors: vec![],
        metrics: TokenMetrics::zero(),
        audit: AgentAudit {
            model: "local-model".to_string(),
            contract: "MemoryAgentImport".to_string(),
            started_at: "unix:1".to_string(),
            finished_at: "unix:2".to_string(),
        },
    }
}
