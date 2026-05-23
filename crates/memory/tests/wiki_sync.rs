use local_first_memory::{
    DataSensitivity, MemoryFacade, MemoryLifecycleRequest, MemoryRecord, MemoryRef, MemoryRefKind,
    MemoryStatus, MemoryWikiProjection, PrivacyDomain, SQLiteMemoryStore, UserId, WikiFileStore,
    WikiPage, WorkspaceId,
};
use std::path::PathBuf;

#[test]
fn wiki_markdown_change_becomes_candidate_correction() {
    let facade = MemoryFacade::new(SQLiteMemoryStore::open_in_memory().unwrap());
    let wiki = WikiFileStore::new(unique_dir());
    let memory = confirmed_memory();
    facade.upsert_memory(&memory).unwrap();
    let page = wiki_page(memory.reference.clone(), "Fabio prefers Zed");
    facade
        .project_to_wiki(&wiki, &MemoryWikiProjection { page: page.clone() })
        .unwrap();
    let markdown = markdown_for(&page, "Fabio prefers Zed for Rust work");

    let report = facade
        .import_wiki_correction(&request(), &markdown)
        .unwrap();

    assert_eq!(report.created_candidates, 1);
    assert_eq!(report.unchanged, 0);
    let candidate = facade
        .get_memory_for_ui(&report.candidate_refs[0], &memory.user_id, &memory.workspace_id)
        .unwrap()
        .unwrap();
    assert_eq!(candidate.status, MemoryStatus::Candidate);
    assert_eq!(candidate.correction_of, Some(memory.reference));
    assert_eq!(candidate.text, "Fabio prefers Zed for Rust work");
}

#[test]
fn unchanged_wiki_markdown_does_not_create_candidate() {
    let facade = MemoryFacade::new(SQLiteMemoryStore::open_in_memory().unwrap());
    let memory = confirmed_memory();
    facade.upsert_memory(&memory).unwrap();
    let page = wiki_page(memory.reference, "Fabio prefers Zed");
    facade.record_wiki_page_for_ui(&page).unwrap();

    let report = facade
        .import_wiki_correction(&request(), &markdown_for(&page, "Fabio prefers Zed"))
        .unwrap();

    assert_eq!(report.created_candidates, 0);
    assert_eq!(report.unchanged, 1);
    assert!(report.candidate_refs.is_empty());
}

#[test]
fn wiki_correction_rejects_secret_body() {
    let facade = MemoryFacade::new(SQLiteMemoryStore::open_in_memory().unwrap());
    let memory = confirmed_memory();
    let page = wiki_page(memory.reference, "Fabio prefers Zed");
    let markdown = markdown_for(&page, "api_key = sk-secret");

    let error = facade.import_wiki_correction(&request(), &markdown).unwrap_err();

    assert_eq!(error, "wiki correction contains raw secret content");
}

fn confirmed_memory() -> MemoryRecord {
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
        confidence: 0.9,
        status: MemoryStatus::Confirmed,
        privacy_domain: PrivacyDomain::new("work"),
        sensitivity: DataSensitivity::Private,
        metadata: serde_json::json!({}),
        created_at: "2026-05-23T08:00:00Z".to_string(),
        updated_at: "2026-05-23T08:00:00Z".to_string(),
        last_seen_at: None,
        supersedes: vec![],
        superseded_by: None,
        correction_of: None,
    }
}

fn wiki_page(memory_ref: MemoryRef, body: &str) -> WikiPage {
    WikiPage {
        reference: MemoryRef::new(
            MemoryRefKind::Wiki,
            UserId::new("user_1"),
            WorkspaceId::new("workspace_1"),
            "Projects/Acme.md",
        ),
        user_id: UserId::new("user_1"),
        workspace_id: WorkspaceId::new("workspace_1"),
        path: "Projects/Acme.md".to_string(),
        title: "Acme".to_string(),
        body: body.to_string(),
        linked_refs: vec![memory_ref],
        privacy_domain: PrivacyDomain::new("work"),
        sensitivity: DataSensitivity::Private,
    }
}

fn markdown_for(page: &WikiPage, body: &str) -> String {
    format!(
        "---\nmemory_ref: {}\nuser_id: {}\nworkspace_id: {}\ntype: wiki_page\nprivacy_domain: {}\nsensitivity: private\nlinked_refs:\n  - {}\n---\n\n# {}\n\n{}\n",
        page.reference,
        page.user_id.as_str(),
        page.workspace_id.as_str(),
        page.privacy_domain.as_str(),
        page.linked_refs[0],
        page.title,
        body
    )
}

fn request() -> MemoryLifecycleRequest {
    MemoryLifecycleRequest {
        actor_id: "wiki-sync".to_string(),
        user_id: UserId::new("user_1"),
        workspace_id: WorkspaceId::new("workspace_1"),
        purpose: "wiki correction sync".to_string(),
    }
}

fn unique_dir() -> PathBuf {
    std::env::temp_dir().join(format!("local-first-memory-wiki-{}", uuid::Uuid::new_v4()))
}
