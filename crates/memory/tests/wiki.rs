use local_first_memory::{
    DataSensitivity, MemoryRef, MemoryRefKind, PrivacyDomain, SQLiteMemoryStore, UserId,
    WikiFileStore, WikiPage, WorkspaceId,
};
use std::fs;

#[test]
fn wiki_store_writes_markdown_with_frontmatter_refs() {
    let root = std::env::temp_dir().join(format!("memory-wiki-{}", uuid::Uuid::new_v4()));
    let store = SQLiteMemoryStore::open_in_memory().unwrap();
    let wiki = WikiFileStore::new(&root);
    let page = page("Projects/Acme.md", "Acme", "Project summary");

    wiki.write_page(&store, &page).unwrap();

    let markdown = fs::read_to_string(root.join("Projects/Acme.md")).unwrap();
    assert!(markdown.contains("memory_ref: wiki:local:user_1:workspace_1:Projects/Acme.md"));
    assert!(markdown.contains("linked_refs:"));
    assert!(markdown.contains("Project summary"));
    assert_eq!(
        store
            .get_wiki_page(&page.reference, &page.user_id, &page.workspace_id)
            .unwrap(),
        Some(page)
    );
}

#[test]
fn wiki_store_rejects_raw_secret_content() {
    let root = std::env::temp_dir().join(format!("memory-wiki-{}", uuid::Uuid::new_v4()));
    let store = SQLiteMemoryStore::open_in_memory().unwrap();
    let wiki = WikiFileStore::new(&root);
    let page = page("Secrets.md", "Secrets", "api key: sk-secret");

    let error = wiki.write_page(&store, &page).unwrap_err();

    assert_eq!(error, "wiki page contains raw secret content");
}

fn page(path: &str, title: &str, body: &str) -> WikiPage {
    WikiPage {
        reference: MemoryRef::new(
            MemoryRefKind::Wiki,
            UserId::new("user_1"),
            WorkspaceId::new("workspace_1"),
            path,
        ),
        user_id: UserId::new("user_1"),
        workspace_id: WorkspaceId::new("workspace_1"),
        path: path.to_string(),
        title: title.to_string(),
        body: body.to_string(),
        linked_refs: vec![MemoryRef::new(
            MemoryRefKind::Entity,
            UserId::new("user_1"),
            WorkspaceId::new("workspace_1"),
            "project:acme",
        )],
        privacy_domain: PrivacyDomain::new("work"),
        sensitivity: DataSensitivity::Private,
    }
}
