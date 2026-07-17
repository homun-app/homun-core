use local_first_memory::{
    DataSensitivity, MemoryFacade, MemoryPublicationDestination, MemoryPublicationStatus,
    MemoryPublicationStoreError, MemoryRecord, MemoryRef, MemoryRefKind, MemoryStatus,
    PrivacyDomain, SQLiteMemoryStore, UserId, WorkspaceId,
};
use rusqlite::Connection;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Barrier};

const OWNER: &str = "owner";
const PROJECT: &str = "project-a";

struct PublicationFixture {
    facade: MemoryFacade,
    owner: UserId,
    project: WorkspaceId,
}

impl PublicationFixture {
    fn new() -> Self {
        Self {
            facade: MemoryFacade::new(SQLiteMemoryStore::open_in_memory().unwrap()),
            owner: UserId::new(OWNER),
            project: WorkspaceId::new(PROJECT),
        }
    }

    fn project_destination(&self) -> MemoryPublicationDestination {
        MemoryPublicationDestination::new(self.owner.clone(), self.project.clone())
    }

    fn personal_destination(&self) -> MemoryPublicationDestination {
        MemoryPublicationDestination::personal(self.owner.clone())
    }

    fn insert_source_preference(&self, text: &str) -> MemoryRecord {
        let record = memory(&self.owner, &self.project, "preference", text);
        self.facade.upsert_memory(&record).unwrap();
        record
    }

    fn get_source(&self, reference: &MemoryRef) -> MemoryRecord {
        self.facade
            .get_memory_for_ui(reference, &self.owner, &self.project)
            .unwrap()
            .unwrap()
    }

    fn personal_memories(&self) -> Vec<MemoryRecord> {
        self.facade
            .list_memories_for_ui(&self.owner, &WorkspaceId::new("__personal__"))
            .unwrap()
    }
}

fn memory(user: &UserId, workspace: &WorkspaceId, kind: &str, text: &str) -> MemoryRecord {
    MemoryRecord {
        reference: MemoryRef::generated(MemoryRefKind::Memory, user.clone(), workspace.clone()),
        user_id: user.clone(),
        workspace_id: workspace.clone(),
        memory_type: kind.to_string(),
        text: text.to_string(),
        aliases: vec!["Italian preference".to_string()],
        language_hints: vec!["it".to_string()],
        confidence: 0.9,
        status: MemoryStatus::Confirmed,
        privacy_domain: PrivacyDomain::new("personal"),
        sensitivity: DataSensitivity::Private,
        metadata: serde_json::json!({"subject": "style"}),
        created_at: "unix:1.000000000".to_string(),
        updated_at: "unix:1.000000000".to_string(),
        last_seen_at: None,
        supersedes: vec![],
        superseded_by: None,
        correction_of: None,
    }
}

#[test]
fn approved_publication_creates_destination_and_marks_source_alias_atomically() {
    let fixture = PublicationFixture::new();
    let source = fixture.insert_source_preference("Prefers Italian");

    let proposal = fixture
        .facade
        .create_publication_proposal(&source, &fixture.personal_destination(), OWNER)
        .unwrap();
    let result = fixture
        .facade
        .approve_publication(&proposal.id, OWNER)
        .unwrap();

    assert_eq!(result.proposal.status, MemoryPublicationStatus::Approved);
    assert_eq!(result.destination.workspace_id.as_str(), "__personal__");
    assert_eq!(result.destination.text, "Prefers Italian");
    assert_eq!(result.destination.status, MemoryStatus::Confirmed);
    assert_eq!(
        result.destination.metadata["publication"]["source_ref"],
        serde_json::to_value(&source.reference).unwrap()
    );
    assert_eq!(
        fixture.get_source(&source.reference).metadata["published_alias"],
        true
    );
    assert_eq!(
        fixture
            .facade
            .get_publication_link(&source.reference)
            .unwrap()
            .unwrap()
            .destination_ref,
        result.destination.reference
    );
}

#[test]
fn rejected_publication_does_not_modify_either_scope() {
    let fixture = PublicationFixture::new();
    let source = fixture.insert_source_preference("Prefers Italian");
    let proposal = fixture
        .facade
        .create_publication_proposal(&source, &fixture.personal_destination(), OWNER)
        .unwrap();

    let rejected = fixture
        .facade
        .reject_publication(&proposal.id, OWNER)
        .unwrap();

    assert_eq!(rejected.status, MemoryPublicationStatus::Rejected);
    assert!(fixture.personal_memories().is_empty());
    assert!(
        fixture
            .get_source(&source.reference)
            .metadata
            .get("published_alias")
            .is_none()
    );
}

#[test]
fn published_source_cannot_create_a_second_publication_and_approve_is_idempotent() {
    let fixture = PublicationFixture::new();
    let source = fixture.insert_source_preference("Prefers Italian");
    let proposal = fixture
        .facade
        .create_publication_proposal(&source, &fixture.personal_destination(), OWNER)
        .unwrap();

    let first = fixture
        .facade
        .approve_publication(&proposal.id, OWNER)
        .unwrap();
    let repeated = fixture
        .facade
        .approve_publication(&proposal.id, OWNER)
        .unwrap();
    let duplicate =
        fixture
            .facade
            .create_publication_proposal(&source, &fixture.personal_destination(), OWNER);

    assert_eq!(repeated.destination.reference, first.destination.reference);
    assert_eq!(fixture.personal_memories().len(), 1);
    assert_eq!(
        duplicate.unwrap_err().as_str(),
        "publication_already_published"
    );
}

#[test]
fn compatible_destination_duplicate_is_reused_not_copied() {
    let fixture = PublicationFixture::new();
    let existing = memory(
        &fixture.owner,
        &WorkspaceId::new("__personal__"),
        "preference",
        "Prefers Italian",
    );
    fixture.facade.upsert_memory(&existing).unwrap();
    let source = fixture.insert_source_preference("Prefers Italian");

    let proposal = fixture
        .facade
        .create_publication_proposal(&source, &fixture.personal_destination(), OWNER)
        .unwrap();
    assert_eq!(proposal.duplicate_ref, Some(existing.reference.clone()));

    let result = fixture
        .facade
        .approve_publication(&proposal.id, OWNER)
        .unwrap();
    assert_eq!(result.destination.reference, existing.reference);
    assert_eq!(fixture.personal_memories().len(), 1);
}

#[test]
fn proposal_validates_owner_scope_tombstone_secret_vault_and_alias() {
    let fixture = PublicationFixture::new();
    let source = fixture.insert_source_preference("Prefers Italian");

    let cross_owner = MemoryPublicationDestination::personal(UserId::new("other"));
    assert_eq!(
        fixture
            .facade
            .create_publication_proposal(&source, &cross_owner, OWNER)
            .unwrap_err()
            .as_str(),
        "publication_scope_mismatch"
    );
    assert_eq!(
        fixture
            .facade
            .create_publication_proposal(&source, &fixture.personal_destination(), "other")
            .unwrap_err()
            .as_str(),
        "publication_actor_mismatch"
    );
    assert_eq!(
        fixture
            .facade
            .create_publication_proposal(&source, &fixture.project_destination(), OWNER)
            .unwrap_err()
            .as_str(),
        "publication_same_scope"
    );

    let mut secret = source.clone();
    secret.reference = MemoryRef::generated(
        MemoryRefKind::Memory,
        fixture.owner.clone(),
        fixture.project.clone(),
    );
    secret.sensitivity = DataSensitivity::Secret;
    fixture.facade.upsert_memory(&secret).unwrap();
    assert_eq!(
        fixture
            .facade
            .create_publication_proposal(&secret, &fixture.personal_destination(), OWNER)
            .unwrap_err()
            .as_str(),
        "secret_never_shareable"
    );

    let mut vault = source.clone();
    vault.reference = MemoryRef::generated(
        MemoryRefKind::Memory,
        fixture.owner.clone(),
        fixture.project.clone(),
    );
    vault.text = "password: never-share".to_string();
    fixture.facade.upsert_memory(&vault).unwrap();
    assert_eq!(
        fixture
            .facade
            .create_publication_proposal(&vault, &fixture.personal_destination(), OWNER)
            .unwrap_err()
            .as_str(),
        "vault_payload_never_shareable"
    );

    fixture
        .facade
        .tombstone_ref(&source.reference, &fixture.owner, &fixture.project, "test")
        .unwrap();
    assert_eq!(
        fixture
            .facade
            .create_publication_proposal(&source, &fixture.personal_destination(), OWNER)
            .unwrap_err()
            .as_str(),
        "publication_source_not_found"
    );
}

#[test]
fn approval_revalidates_source_and_rejection_is_terminal() {
    let fixture = PublicationFixture::new();
    let source = fixture.insert_source_preference("Prefers Italian");
    let proposal = fixture
        .facade
        .create_publication_proposal(&source, &fixture.personal_destination(), OWNER)
        .unwrap();

    fixture
        .facade
        .tombstone_ref(
            &source.reference,
            &fixture.owner,
            &fixture.project,
            "before approval",
        )
        .unwrap();
    assert_eq!(
        fixture
            .facade
            .approve_publication(&proposal.id, OWNER)
            .unwrap_err()
            .as_str(),
        "publication_source_not_found"
    );
    assert!(fixture.personal_memories().is_empty());

    let source = fixture.insert_source_preference("Different preference");
    let proposal = fixture
        .facade
        .create_publication_proposal(&source, &fixture.personal_destination(), OWNER)
        .unwrap();
    fixture
        .facade
        .reject_publication(&proposal.id, OWNER)
        .unwrap();
    assert_eq!(
        fixture
            .facade
            .approve_publication(&proposal.id, OWNER)
            .unwrap_err()
            .as_str(),
        "publication_not_pending"
    );
}

#[test]
fn forced_commit_failure_rolls_back_destination_alias_and_link() {
    let path = unique_db_path("rollback");
    let facade = MemoryFacade::new(SQLiteMemoryStore::open(&path).unwrap());
    let owner = UserId::new(OWNER);
    let project = WorkspaceId::new(PROJECT);
    let source = memory(&owner, &project, "preference", "Prefers Italian");
    facade.upsert_memory(&source).unwrap();
    let proposal = facade
        .create_publication_proposal(
            &source,
            &MemoryPublicationDestination::personal(owner.clone()),
            OWNER,
        )
        .unwrap();

    Connection::open(&path)
        .unwrap()
        .execute_batch(
            "create trigger fail_publication_before_status
             before update of status on memory_publication_proposals
             when new.status = 'approved'
             begin select raise(abort, 'forced publication failure'); end;",
        )
        .unwrap();

    let result = facade.approve_publication(&proposal.id, OWNER);
    assert!(result.is_err());
    assert!(
        facade
            .list_memories_for_ui(&owner, &WorkspaceId::new("__personal__"))
            .unwrap()
            .is_empty()
    );
    assert!(
        facade
            .get_memory_for_ui(&source.reference, &owner, &project)
            .unwrap()
            .unwrap()
            .metadata
            .get("published_alias")
            .is_none()
    );
    assert!(
        facade
            .get_publication_link(&source.reference)
            .unwrap()
            .is_none()
    );
    assert_eq!(
        facade
            .get_publication_proposal(&proposal.id)
            .unwrap()
            .unwrap()
            .status,
        MemoryPublicationStatus::Failed
    );
    drop(facade);
    remove_sqlite_files(&path);
}

#[test]
fn concurrent_approvals_produce_one_canonical_destination_and_link() {
    let facade = Arc::new(MemoryFacade::new(
        SQLiteMemoryStore::open_in_memory().unwrap(),
    ));
    let owner = UserId::new(OWNER);
    let project = WorkspaceId::new(PROJECT);
    let source = memory(&owner, &project, "preference", "Prefers Italian");
    facade.upsert_memory(&source).unwrap();
    let proposal = facade
        .create_publication_proposal(
            &source,
            &MemoryPublicationDestination::personal(owner.clone()),
            OWNER,
        )
        .unwrap();
    let barrier = Arc::new(Barrier::new(3));
    let mut joins = Vec::new();
    for _ in 0..2 {
        let facade = Arc::clone(&facade);
        let barrier = Arc::clone(&barrier);
        let id = proposal.id.clone();
        joins.push(std::thread::spawn(move || {
            barrier.wait();
            facade.approve_publication(&id, OWNER)
        }));
    }
    barrier.wait();
    let results = joins
        .into_iter()
        .map(|join| join.join().unwrap())
        .collect::<Vec<_>>();
    assert!(results.iter().all(Result::is_ok), "{results:?}");
    assert_eq!(
        facade
            .list_memories_for_ui(&owner, &WorkspaceId::new("__personal__"))
            .unwrap()
            .len(),
        1
    );
    assert!(
        facade
            .get_publication_link(&source.reference)
            .unwrap()
            .is_some()
    );
}

fn unique_db_path(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "local-first-memory-publication-{label}-{}.sqlite",
        uuid::Uuid::new_v4()
    ))
}

fn remove_sqlite_files(path: &Path) {
    let _ = std::fs::remove_file(path);
    let _ = std::fs::remove_file(format!("{}-wal", path.display()));
    let _ = std::fs::remove_file(format!("{}-shm", path.display()));
}

#[test]
fn schema_v4_open_remains_compatible() {
    let path = unique_db_path("schema-v4");
    let store = SQLiteMemoryStore::open(&path).unwrap();
    assert_eq!(store.schema_version().unwrap(), 4);
    drop(store);
    let reopened = SQLiteMemoryStore::open(&path).unwrap();
    assert_eq!(reopened.schema_version().unwrap(), 4);
    remove_sqlite_files(&path);
}

#[test]
fn store_rejects_cross_owner_or_thread_publication_proposals() {
    let fixture = PublicationFixture::new();
    let source = fixture.insert_source_preference("Prefers Italian");
    let proposal = fixture
        .facade
        .create_publication_proposal(&source, &fixture.personal_destination(), OWNER)
        .unwrap();
    let store = SQLiteMemoryStore::open_in_memory().unwrap();

    let mut cross_owner = proposal.clone();
    cross_owner.id = uuid::Uuid::new_v4().to_string();
    cross_owner.destination_user_id = UserId::new("other");
    assert!(matches!(
        store.create_memory_publication_proposal(&cross_owner),
        Err(MemoryPublicationStoreError::Validation(_))
    ));

    let mut thread_destination = proposal;
    thread_destination.id = uuid::Uuid::new_v4().to_string();
    thread_destination.destination_workspace_id = WorkspaceId::new("__threads__");
    assert!(matches!(
        store.create_memory_publication_proposal(&thread_destination),
        Err(MemoryPublicationStoreError::Validation(_))
    ));
}
