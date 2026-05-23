use local_first_memory::{
    AccessDecisionKind, DataSensitivity, MemoryAccessRequest, MemoryPolicyEngine, MemoryRecord,
    MemoryRef, MemoryRefKind, MemoryStatus, PrivacyDomain, SQLiteMemoryStore, UserId, WorkspaceId,
    redact_json,
};

#[test]
fn policy_denies_domains_outside_request() {
    let request = request(vec!["work"], DataSensitivity::Private, false, false);
    let record = memory("personal", DataSensitivity::Private);

    let decision = MemoryPolicyEngine::default().decide_memory(&request, &record);

    assert_eq!(decision.kind, AccessDecisionKind::Deny);
    assert_eq!(decision.reasons, vec!["privacy_domain_not_allowed"]);
}

#[test]
fn policy_denies_sensitivity_above_request_limit() {
    let request = request(vec!["work"], DataSensitivity::Private, false, false);
    let record = memory("work", DataSensitivity::Secret);

    let decision = MemoryPolicyEngine::default().decide_memory(&request, &record);

    assert_eq!(decision.kind, AccessDecisionKind::Deny);
    assert_eq!(decision.reasons, vec!["sensitivity_above_request_limit"]);
}

#[test]
fn policy_redacts_when_raw_payload_is_not_allowed() {
    let request = request(vec!["work"], DataSensitivity::Private, false, false);
    let record = memory("work", DataSensitivity::Private);

    let decision = MemoryPolicyEngine::default().decide_memory(&request, &record);

    assert_eq!(decision.kind, AccessDecisionKind::Redact);
    assert_eq!(decision.reasons, vec!["raw_payload_not_allowed"]);
}

#[test]
fn policy_blocks_broad_export_without_permission() {
    let mut request = request(vec!["work"], DataSensitivity::Private, true, false);
    request.broad_query = true;

    let decision = MemoryPolicyEngine::default().decide_export(&request);

    assert_eq!(decision.kind, AccessDecisionKind::Deny);
    assert_eq!(decision.reasons, vec!["export_not_allowed"]);
}

#[test]
fn redaction_removes_secrets_recursively() {
    let redacted = redact_json(&serde_json::json!({
        "profile": {
            "api_key": "sk-secret",
            "nested": {"access_token": "token"}
        },
        "notes": "safe"
    }));

    assert_eq!(redacted["profile"]["api_key"], "[REDACTED]");
    assert_eq!(redacted["profile"]["nested"]["access_token"], "[REDACTED]");
    assert_eq!(redacted["notes"], "safe");
}

#[test]
fn store_audits_access_decisions() {
    let store = SQLiteMemoryStore::open_in_memory().unwrap();
    let request = request(vec!["work"], DataSensitivity::Private, false, false);
    let record = memory("work", DataSensitivity::Private);
    let decision = MemoryPolicyEngine::default().decide_memory(&request, &record);

    store.record_access_decision(&request, &decision).unwrap();

    assert_eq!(store.access_audit_count().unwrap(), 1);
}

fn request(
    domains: Vec<&str>,
    max_sensitivity: DataSensitivity,
    allow_raw_payload: bool,
    allow_export: bool,
) -> MemoryAccessRequest {
    MemoryAccessRequest {
        actor_id: "MemoryAgent".to_string(),
        user_id: UserId::new("user_1"),
        workspace_id: WorkspaceId::new("workspace_1"),
        purpose: "prepare context".to_string(),
        allowed_domains: domains.into_iter().map(PrivacyDomain::new).collect(),
        max_sensitivity,
        allow_raw_payload,
        allow_export,
        broad_query: false,
    }
}

fn memory(domain: &str, sensitivity: DataSensitivity) -> MemoryRecord {
    MemoryRecord {
        reference: MemoryRef::new(
            MemoryRefKind::Memory,
            UserId::new("user_1"),
            WorkspaceId::new("workspace_1"),
            "mem_1",
        ),
        user_id: UserId::new("user_1"),
        workspace_id: WorkspaceId::new("workspace_1"),
        memory_type: "preference".to_string(),
        text: "Fabio prefers Zed".to_string(),
        aliases: vec![],
        language_hints: vec!["en".to_string()],
        confidence: 0.8,
        status: MemoryStatus::Confirmed,
        privacy_domain: PrivacyDomain::new(domain),
        sensitivity,
        metadata: serde_json::json!({}),
    }
}
