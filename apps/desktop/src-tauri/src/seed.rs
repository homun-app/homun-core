use crate::state::{DEFAULT_USER_ID, DEFAULT_WORKSPACE_ID};
use local_first_capabilities::{
    ActionClass, CachedCapabilityTool, CapabilityConnectionConfig, CapabilityProviderConfig,
    CapabilityProviderGrant, CapabilityProviderKind, CapabilityRegistryStore, ConnectionStatus,
    ManagedProviderMetadata, ProviderId, UserId as CapabilityUserId,
    WorkspaceId as CapabilityWorkspaceId,
};
use local_first_memory::{
    DataSensitivity, MemoryCreateRequest, MemoryFacade, MemoryLifecycleRequest, MemoryRef,
    MemoryRefKind, PrivacyDomain, UserId as MemoryUserId, WorkspaceId as MemoryWorkspaceId,
};
use local_first_task_runtime::{
    ApprovalGate, ResourceClass, ResourceRequirement, TaskPriority, TaskRecord, TaskRuntimeResult,
    TaskStatus, TaskStore, UserId as TaskUserId, WorkspaceId as TaskWorkspaceId,
};
use serde_json::json;

pub fn seed_tasks(store: &TaskStore) -> TaskRuntimeResult<()> {
    let user_id = TaskUserId::new(DEFAULT_USER_ID);
    let workspace_id = TaskWorkspaceId::new(DEFAULT_WORKSPACE_ID);

    let mut browser_task = TaskRecord::new(
        "task_browser_quote",
        user_id.clone(),
        workspace_id.clone(),
        "browser_automation",
        "Cercare disponibilita' treno Napoli-Milano",
        json!({
            "method": "browser.fill_and_extract",
            "params": { "target_id": "browser-session-local" }
        }),
    )
    .with_priority(TaskPriority::High)
    .with_resource(ResourceRequirement::new(ResourceClass::BrowserSession, 1));
    browser_task.status = TaskStatus::Running;
    browser_task.risk_level = "medium".to_string();
    store.insert_task(&browser_task)?;
    store.reserve_resources(&browser_task, "desktop-core")?;
    store.append_checkpoint(
        &browser_task.task_id,
        &user_id,
        &workspace_id,
        json!({
            "browser": {
                "method": "browser.fill_and_extract",
                "target_id": "browser-session-local",
                "raw_url": "redacted"
            }
        }),
        json!({
            "browser": {
                "method": "browser.fill_and_extract",
                "target_id": "browser-session-local",
                "snapshot": "redacted"
            }
        }),
    )?;

    let approval_task = TaskRecord::new(
        "task_acme_summary",
        user_id.clone(),
        workspace_id.clone(),
        "subagent.review",
        "Preparare riepilogo operativo e attendere conferma prima dell'invio",
        json!({ "channel": "team", "raw_payload": "redacted" }),
    )
    .with_priority(TaskPriority::Normal)
    .with_resource(ResourceRequirement::new(ResourceClass::LlmInference, 1));
    store.insert_task(&approval_task)?;
    ApprovalGate::new().request_approval(
        store,
        &approval_task.task_id,
        &user_id,
        &workspace_id,
        "send_summary",
        "medium",
        "local_or_user_approved_connector",
        "Serve conferma prima di inviare contenuti verso un canale esterno.",
    )?;

    let maintenance_task = TaskRecord::new(
        "task_memory_index",
        user_id,
        workspace_id,
        "memory_indexing",
        "Aggiornare indice memoria progetto",
        json!({ "scope": "workspace", "raw_payload": "redacted" }),
    )
    .with_priority(TaskPriority::Background)
    .with_resource(ResourceRequirement::new(ResourceClass::MemoryIndexing, 1));
    store.insert_task(&maintenance_task)?;

    Ok(())
}

pub fn seed_memories(facade: &MemoryFacade) -> Result<(), String> {
    let lifecycle = memory_lifecycle_request(DEFAULT_USER_ID, DEFAULT_WORKSPACE_ID);
    let work_memory = facade
        .create_memory_candidate(MemoryCreateRequest {
            request: lifecycle.clone(),
            memory_type: "preference".to_string(),
            text: "Fabio preferisce vedere task, stato git e prossima azione prima di iniziare lavoro tecnico.".to_string(),
            aliases: vec!["rituale avvio progetto".to_string()],
            language_hints: vec!["it".to_string()],
            confidence: 0.86,
            privacy_domain: PrivacyDomain::new("work"),
            sensitivity: DataSensitivity::Private,
            evidence_refs: vec![MemoryRef::new(
                MemoryRefKind::Event,
                MemoryUserId::new(DEFAULT_USER_ID),
                MemoryWorkspaceId::new(DEFAULT_WORKSPACE_ID),
                "desktop-event-session-start",
            )],
            metadata: json!({ "source": "desktop_seed", "raw_payload": "redacted" }),
        })
        .map_err(to_string_error)?;
    facade
        .confirm_memory(&lifecycle, &work_memory.reference, "seeded desktop bridge")
        .map_err(to_string_error)?;

    facade
        .create_memory_candidate(MemoryCreateRequest {
            request: lifecycle,
            memory_type: "routine".to_string(),
            text: "Possibile routine: preparare riepilogo mattutino dai task locali e dalle note progetto.".to_string(),
            aliases: vec!["morning briefing".to_string()],
            language_hints: vec!["it".to_string(), "en".to_string()],
            confidence: 0.72,
            privacy_domain: PrivacyDomain::new("work"),
            sensitivity: DataSensitivity::Private,
            evidence_refs: vec![],
            metadata: json!({ "source": "desktop_seed", "requires_review": true }),
        })
        .map_err(to_string_error)?;

    Ok(())
}

pub fn seed_capabilities(store: &CapabilityRegistryStore) -> Result<Vec<String>, String> {
    let user_id = CapabilityUserId::new(DEFAULT_USER_ID);
    let workspace_id = CapabilityWorkspaceId::new(DEFAULT_WORKSPACE_ID);
    let provider_ids = vec![
        "browser".to_string(),
        "local-computer".to_string(),
        "mcp.github".to_string(),
        "managed.gmail".to_string(),
    ];

    let providers = vec![
        CapabilityProviderConfig::new(
            ProviderId::new("browser"),
            CapabilityProviderKind::Browser,
            "Il mio browser".to_string(),
            true,
        ),
        CapabilityProviderConfig::new(
            ProviderId::new("local-computer"),
            CapabilityProviderKind::Native,
            "Computer locale".to_string(),
            true,
        ),
        CapabilityProviderConfig::new(
            ProviderId::new("mcp.github"),
            CapabilityProviderKind::Mcp,
            "GitHub MCP".to_string(),
            true,
        ),
        CapabilityProviderConfig::new(
            ProviderId::new("managed.gmail"),
            CapabilityProviderKind::Managed,
            "Gmail via managed provider".to_string(),
            false,
        )
        .with_managed_metadata(ManagedProviderMetadata {
            provider_name: "Composio".to_string(),
            data_boundary: local_first_capabilities::DataBoundary::ManagedCloud,
            auth_mode: "oauth".to_string(),
            data_categories: vec!["email".to_string(), "contacts".to_string()],
            retention_notes: Some("Disabilitato finche' non approvato dall'utente.".to_string()),
        }),
    ];
    for provider in providers {
        store
            .upsert_provider_config(&provider)
            .map_err(to_string_error)?;
    }

    for provider_id in ["browser", "local-computer", "mcp.github"] {
        store
            .upsert_provider_grant(
                &CapabilityProviderGrant::new(
                    ProviderId::new(provider_id),
                    user_id.clone(),
                    workspace_id.clone(),
                )
                .with_privacy_domains(vec!["work".to_string(), "browser".to_string()])
                .with_allowed_actions(vec![ActionClass::Read, ActionClass::Draft])
                .with_max_autonomy_level(2),
            )
            .map_err(to_string_error)?;
    }
    store
        .upsert_provider_grant(
            &CapabilityProviderGrant::new(
                ProviderId::new("managed.gmail"),
                user_id.clone(),
                workspace_id.clone(),
            )
            .disabled()
            .with_allow_managed_cloud(false),
        )
        .map_err(to_string_error)?;

    let browser_connection = CapabilityConnectionConfig::new(
        "conn_browser_local",
        ProviderId::new("browser"),
        user_id.clone(),
        workspace_id.clone(),
        "Browser locale",
        "local-profile",
    )
    .with_privacy_domains(vec!["browser".to_string(), "work".to_string()])
    .with_metadata(json!({ "profile": "assistant", "secrets": "redacted" }));
    store
        .upsert_connection_config(&browser_connection)
        .map_err(to_string_error)?;

    let mut gmail_connection = CapabilityConnectionConfig::new(
        "conn_gmail_managed",
        ProviderId::new("managed.gmail"),
        user_id,
        workspace_id,
        "Gmail",
        "oauth:not-configured",
    )
    .with_privacy_domains(vec!["work".to_string()])
    .with_metadata(json!({ "auth": "not_configured" }));
    gmail_connection.status = ConnectionStatus::Disabled;
    store
        .upsert_connection_config(&gmail_connection)
        .map_err(to_string_error)?;

    let tools = vec![
        CachedCapabilityTool::new(
            ProviderId::new("browser"),
            "browser.snapshot",
            CapabilityProviderKind::Browser,
            ActionClass::Read,
            "Legge una snapshot redatta della pagina corrente.",
            vec!["browser".to_string()],
            "private",
            json!({ "type": "object" }),
        ),
        CachedCapabilityTool::new(
            ProviderId::new("local-computer"),
            "shell.run_readonly",
            CapabilityProviderKind::Native,
            ActionClass::Read,
            "Esegue comandi locali read-only con audit.",
            vec!["work".to_string()],
            "private",
            json!({ "type": "object" }),
        ),
        CachedCapabilityTool::new(
            ProviderId::new("mcp.github"),
            "github.search",
            CapabilityProviderKind::Mcp,
            ActionClass::Read,
            "Cerca issue, repository e pull request tramite MCP.",
            vec!["work".to_string()],
            "internal",
            json!({ "type": "object" }),
        ),
    ];
    for tool in tools {
        store.upsert_cached_tool(&tool).map_err(to_string_error)?;
    }

    Ok(provider_ids)
}

fn memory_lifecycle_request(user_id: &str, workspace_id: &str) -> MemoryLifecycleRequest {
    MemoryLifecycleRequest {
        actor_id: "desktop-ui".to_string(),
        user_id: MemoryUserId::new(user_id),
        workspace_id: MemoryWorkspaceId::new(workspace_id),
        purpose: "desktop bridge seed".to_string(),
    }
}

fn to_string_error(error: impl std::fmt::Display) -> String {
    error.to_string()
}
