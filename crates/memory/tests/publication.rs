use local_first_memory::{
    AuthorizedMemorySource, DataSensitivity, MemoryCollectionKey, MemoryFacade,
    MemoryPublicationCandidate, MemoryPublicationDestination, MemoryPublicationReasonCode,
    MemoryPublicationResolution, MemoryPublicationStatus, MemoryPublicationStoreError,
    MemoryRecord, MemoryRef, MemoryRefKind, MemoryStatus, PrivacyDomain, SQLiteMemoryStore, UserId,
    WorkspaceId, recall_source_on_facade,
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
        result.destination.metadata["publication_source_ref"],
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
fn published_destination_exposes_structural_publication_link_to_recall_dedup() {
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
    let personal = AuthorizedMemorySource {
        source_user_id: fixture.owner.clone(),
        source_workspace_id: WorkspaceId::new("__personal__"),
        source_label: "Personal memory".to_string(),
        grant_id: None,
        policy: None,
        policy_version: 0,
    };
    let pack =
        recall_source_on_facade(&fixture.facade, &personal, "Prefers Italian", &[], None).unwrap();
    let hit = pack
        .hits
        .iter()
        .find(|hit| hit.memory_ref == result.destination.reference.to_string())
        .expect(&format!("missing destination hit: {:?}", pack.hits));
    assert_eq!(
        hit.publication_link,
        Some(serde_json::to_string(&source.reference).unwrap())
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
    assert_eq!(
        proposal.reason_code,
        MemoryPublicationReasonCode::PublicationDuplicateCompatible
    );
    assert_eq!(
        fixture
            .facade
            .approve_publication(&proposal.id, OWNER)
            .unwrap_err()
            .as_str(),
        "publication_conflict"
    );
    fixture
        .facade
        .set_publication_resolution(
            &proposal.id,
            OWNER,
            MemoryPublicationResolution::UpdateExisting {
                destination_ref: existing.reference.clone(),
            },
        )
        .unwrap();

    let result = fixture
        .facade
        .approve_publication(&proposal.id, OWNER)
        .unwrap();
    assert_eq!(result.destination.reference, existing.reference);
    assert_eq!(fixture.personal_memories().len(), 1);
}

#[test]
fn incompatible_same_subject_requires_explicit_create_new_and_records_conflict() {
    let fixture = PublicationFixture::new();
    let mut existing = memory(
        &fixture.owner,
        &WorkspaceId::new("__personal__"),
        "preference",
        "Prefers terse replies",
    );
    existing.metadata = serde_json::json!({"subject_key": "reply_style"});
    fixture.facade.upsert_memory(&existing).unwrap();
    let mut source = fixture.insert_source_preference("Prefers Italian");
    source.metadata = serde_json::json!({"subject_key": "reply_style"});
    fixture.facade.upsert_memory(&source).unwrap();

    let proposal = fixture
        .facade
        .create_publication_proposal(&source, &fixture.personal_destination(), OWNER)
        .unwrap();
    assert_eq!(
        proposal.reason_code,
        MemoryPublicationReasonCode::PublicationConflict
    );
    assert_eq!(
        fixture
            .facade
            .approve_publication(&proposal.id, OWNER)
            .unwrap_err()
            .as_str(),
        "publication_conflict"
    );

    fixture
        .facade
        .set_publication_resolution(&proposal.id, OWNER, MemoryPublicationResolution::CreateNew)
        .unwrap();
    let result = fixture
        .facade
        .approve_publication(&proposal.id, OWNER)
        .unwrap();
    assert_ne!(result.destination.reference, existing.reference);
    assert_eq!(fixture.personal_memories().len(), 2);
}

#[test]
fn stale_or_invalid_update_existing_resolution_fails_closed() {
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

    let wrong = MemoryRef::generated(
        MemoryRefKind::Memory,
        fixture.owner.clone(),
        WorkspaceId::new("__personal__"),
    );
    assert_eq!(
        fixture
            .facade
            .set_publication_resolution(
                &proposal.id,
                OWNER,
                MemoryPublicationResolution::UpdateExisting {
                    destination_ref: wrong,
                },
            )
            .unwrap_err()
            .as_str(),
        "publication_conflict"
    );
    fixture
        .facade
        .set_publication_resolution(
            &proposal.id,
            OWNER,
            MemoryPublicationResolution::UpdateExisting {
                destination_ref: existing.reference.clone(),
            },
        )
        .unwrap();
    let mut changed = existing.clone();
    changed.text = "Changed after selection".to_string();
    fixture.facade.upsert_memory(&changed).unwrap();
    assert_eq!(
        fixture
            .facade
            .approve_publication(&proposal.id, OWNER)
            .unwrap_err()
            .as_str(),
        "publication_conflict"
    );
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

#[test]
fn legacy_publication_rows_are_backfilled_to_valid_typed_states() {
    let path = unique_db_path("legacy-publications");
    let owner = UserId::new(OWNER);
    let source = MemoryRef::generated(
        MemoryRefKind::Memory,
        owner.clone(),
        WorkspaceId::new(PROJECT),
    );
    let duplicate = MemoryRef::generated(
        MemoryRefKind::Memory,
        owner.clone(),
        WorkspaceId::new("__personal__"),
    );
    let connection = Connection::open(&path).unwrap();
    connection
        .execute_batch(
            "create table memory_publication_proposals (
                id text primary key,
                source_ref_json text not null,
                source_user_id text not null,
                source_workspace_id text not null,
                destination_user_id text not null,
                destination_workspace_id text not null,
                proposed_text text not null,
                proposed_memory_type text not null,
                proposed_privacy_domain text not null,
                proposed_sensitivity text not null,
                duplicate_ref_json text,
                status text not null,
                proposed_by text not null,
                decided_by text,
                created_at text not null,
                updated_at text not null
            );
            create table memory_publication_links (
                source_ref_json text primary key,
                destination_ref_json text not null,
                approved_by text not null,
                created_at text not null
            );",
        )
        .unwrap();
    for (id, status, decided_by, memory_type, duplicate_ref) in [
        ("approved", "approved", Some(OWNER), "preference", None),
        ("rejected", "rejected", Some(OWNER), "preference", None),
        ("failed", "failed", Some(OWNER), "preference", None),
        (
            "pending-duplicate",
            "pending",
            None,
            "preference",
            Some(duplicate.clone()),
        ),
        ("pending", "pending", None, "note", None),
        ("pending-fact", "pending", None, "fact", None),
        ("pending-preference", "pending", None, "preference", None),
        ("pending-goal", "pending", None, "goal", None),
        ("pending-artifact", "pending", None, "artifact", None),
        ("pending-episode", "pending", None, "episode", None),
        (
            "pending-unknown",
            "pending",
            None,
            "unknown_legacy_type",
            None,
        ),
    ] {
        connection
            .execute(
                "insert into memory_publication_proposals(
                    id, source_ref_json, source_user_id, source_workspace_id,
                    destination_user_id, destination_workspace_id, proposed_text,
                    proposed_memory_type, proposed_privacy_domain, proposed_sensitivity,
                    duplicate_ref_json, status, proposed_by, decided_by, created_at, updated_at
                 ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
                rusqlite::params![
                    id,
                    serde_json::to_string(&source).unwrap(),
                    OWNER,
                    PROJECT,
                    OWNER,
                    "__personal__",
                    "Prefers Italian",
                    memory_type,
                    "personal",
                    "private",
                    duplicate_ref.map(|reference| serde_json::to_string(&reference).unwrap()),
                    status,
                    OWNER,
                    decided_by,
                    "unix:1.000000000",
                    "unix:1.000000000",
                ],
            )
            .unwrap();
    }
    connection
        .execute(
            "insert into memory_publication_proposals(
                id, source_ref_json, source_user_id, source_workspace_id,
                destination_user_id, destination_workspace_id, proposed_text,
                proposed_memory_type, proposed_privacy_domain, proposed_sensitivity,
                duplicate_ref_json, status, proposed_by, decided_by, created_at, updated_at
             ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
            rusqlite::params![
                "pending-corrupt",
                serde_json::to_string(&source).unwrap(),
                OWNER,
                PROJECT,
                OWNER,
                "__personal__",
                "Prefers Italian",
                "preference",
                "personal",
                "private",
                "{corrupt-legacy-ref",
                "pending",
                OWNER,
                Option::<&str>::None,
                "unix:1.000000000",
                "unix:1.000000000",
            ],
        )
        .unwrap();
    drop(connection);

    let facade = MemoryFacade::new(SQLiteMemoryStore::open(&path).unwrap());
    assert_eq!(
        facade
            .get_publication_proposal("approved")
            .unwrap()
            .unwrap()
            .reason_code,
        MemoryPublicationReasonCode::Approved
    );
    assert_eq!(
        facade
            .get_publication_proposal("rejected")
            .unwrap()
            .unwrap()
            .reason_code,
        MemoryPublicationReasonCode::Rejected
    );
    let failed = facade.get_publication_proposal("failed").unwrap().unwrap();
    assert_eq!(
        failed.reason_code,
        MemoryPublicationReasonCode::PublicationFailed
    );
    assert_eq!(failed.failure_reason.as_deref(), Some("legacy_failure"));
    let pending_duplicate = facade
        .get_publication_proposal("pending-duplicate")
        .unwrap()
        .unwrap();
    assert_eq!(
        pending_duplicate.candidate,
        Some(MemoryPublicationCandidate::CompatibleDuplicate {
            destination_ref: duplicate,
        })
    );
    assert_eq!(
        pending_duplicate.reason_code,
        MemoryPublicationReasonCode::PublicationDuplicateCompatible
    );
    assert_eq!(
        facade
            .get_publication_proposal("pending")
            .unwrap()
            .unwrap()
            .reason_code,
        MemoryPublicationReasonCode::Pending
    );
    assert!(facade.get_publication_proposal("pending-corrupt").is_err());
    assert!(facade.get_publication_proposal("pending-fact").is_err());
    assert!(facade.get_publication_proposal("pending-unknown").is_err());
    for (id, expected_collection) in [
        ("pending-preference", MemoryCollectionKey::Preferences),
        ("pending-goal", MemoryCollectionKey::Goals),
        ("pending-artifact", MemoryCollectionKey::Artifacts),
        ("pending-episode", MemoryCollectionKey::Episodes),
    ] {
        assert_eq!(
            facade
                .get_publication_proposal(id)
                .unwrap()
                .unwrap()
                .proposed_collection,
            expected_collection,
        );
    }

    let mut conflict_source = memory(
        &owner,
        &WorkspaceId::new(PROJECT),
        "preference",
        "Prefers Italian",
    );
    conflict_source.metadata = serde_json::json!({"subject_key": "reply_language"});
    facade.upsert_memory(&conflict_source).unwrap();
    let mut conflicting_destination = memory(
        &owner,
        &WorkspaceId::new("__personal__"),
        "preference",
        "Prefers English",
    );
    conflicting_destination.metadata = serde_json::json!({"subject_key": "reply_language"});
    facade.upsert_memory(&conflicting_destination).unwrap();
    let conflict = facade
        .create_publication_proposal(
            &conflict_source,
            &MemoryPublicationDestination::personal(owner.clone()),
            OWNER,
        )
        .unwrap();
    assert_eq!(
        conflict.reason_code,
        MemoryPublicationReasonCode::PublicationConflict
    );
    assert_eq!(
        facade
            .approve_publication(&conflict.id, OWNER)
            .unwrap_err()
            .as_str(),
        "publication_conflict"
    );
    facade
        .set_publication_resolution(&conflict.id, OWNER, MemoryPublicationResolution::CreateNew)
        .unwrap();
    facade.approve_publication(&conflict.id, OWNER).unwrap();
    drop(facade);
    remove_sqlite_files(&path);
}
