# Project-Linked Memory Sources Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consentire a un progetto Homun di consultare, in sola lettura e con autorizzazioni esplicite, raccolte selezionate della memoria personale o di altri progetti, mantenendo provenienza, revoca immediata e pubblicazione approvata.

**Architecture:** La proprietà `(user_id, workspace_id)` e il `scope_mismatch` esistenti restano invariati. Un nuovo resolver produce fonti autorizzate; ogni fonte viene interrogata separatamente con una normale `MemoryAccessRequest` riferita allo scope sorgente, quindi gli hit strutturati vengono filtrati, fusi e budgetizzati. Grant, override, audit aggregato e proposte di pubblicazione vivono nel `memory.sqlite` canonico; gateway e desktop espongono gestione e trasparenza senza riusare `ProjectAccessGrant`.

**Tech Stack:** Rust 2024, rusqlite/SQLite + FTS5, indice vettoriale `usearch`/exact, Axum desktop gateway, React 19 + TypeScript, Electron, test Rust, UI contract e pre-release gate.

---

## Vincoli di esecuzione

- Eseguire l'implementazione in un worktree isolato con branch `fabio/project-linked-memory-sources`.
- Non toccare né aggiungere al commit `homun-tablet-full.png`, già non tracciato nel worktree principale.
- TDD per ogni task: test rosso, implementazione minima, test verde, commit dedicato.
- Nessun trailer `Co-Authored-By`.
- `HOMUN_MEMORY_SOURCES=off` deve mantenere il comportamento locale isolato.
- Non rimuovere `MemoryPolicyEngine::scope_mismatch` e non trasformare `MemoryAccessRequest` in una richiesta multi-workspace.
- Non riusare `ProjectAccessGrant`: il grant dei contatti può restringere l'accesso, mai creare nuove fonti.

## Mappa dei file

### Nuovi file

- `crates/memory/src/sources.rs` — tipi di grant, registro raccolte, policy effettiva, resolver e fingerprint.
- `crates/memory/src/publication.rs` — tipi e regole di stato delle proposte/link di pubblicazione.
- `crates/memory/tests/sources.rs` — raccolte, deny-wins, secret/Vault, resolver e non-transitività.
- `crates/memory/tests/source_grants.rs` — persistenza, revoca, scadenza e schema migration.
- `crates/memory/tests/multi_source_recall.rs` — filtro pre-candidatura, merge, precedenze e conflitti.
- `crates/memory/tests/publication.rs` — approvazione transazionale, duplicate check e rollback.
- `apps/desktop/src/components/MemorySourcesDialog.tsx` — gestione delle fonti del progetto.
- `apps/desktop/src/components/MemoryUsagePopover.tsx` — provenienza degli hit usati nel turno.
- `apps/desktop/src/components/MemoryPublicationDialog.tsx` — anteprima e approvazione della pubblicazione.

### File modificati

- `crates/memory/src/lib.rs` — esporta `sources` e `publication`.
- `crates/memory/src/store.rs` — schema v4, grant, override, audit aggregato, proposta e transazione di pubblicazione.
- `crates/memory/src/facade.rs` — boundary canonico per grant, resolver, recall filtrato e pubblicazione.
- `crates/memory/src/search.rs` — constraint di fonte applicabile prima della candidatura.
- `crates/memory/src/vector_index.rs` — indice derivato costruibile da soli embedding autorizzati.
- `crates/memory/src/recall.rs` — hit strutturati, recall per fonte, merge, conflitti e formattazione finale.
- `crates/memory/src/service.rs` — provenienza in `RecallHit` e fingerprint nel briefing cache contract.
- `crates/desktop-gateway/src/main.rs` — route, service multi-source, briefing grant-aware, audit/eventi e feature flag.
- `crates/engine/src/events.rs` — provenienza nel payload stream `recall`.
- `crates/task-runtime/src/types.rs` — `TurnEventKind::Recall` per il broker durevole.
- `apps/desktop/src/lib/coreBridge.ts` — tipi/API delle fonti, publication e payload recall esteso.
- `apps/desktop/src/types.ts` — ri-esporta le shape tipizzate senza duplicarle.
- `apps/desktop/src/components/Sidebar.tsx` — entry “Fonti di memoria” nel menu progetto.
- `apps/desktop/src/components/ChatView.tsx` — badge cliccabile e pannello “Memorie utilizzate”.
- `apps/desktop/src/styles.css` — dialog, card fonte, badge e popover.
- `apps/desktop/src/i18n/locales/it.json` e `en.json` — copy localizzato.
- `apps/desktop/scripts/check-ui-contract.mjs` — contratto statico delle nuove superfici.
- `docs/architecture/memory.md`, `docs/MEMORIA.md`, `docs/DEVELOPMENT.md`, `docs/roadmap.md` — stato reale e flag.

## Task 1: Dominio delle fonti e registro delle raccolte

**Files:**
- Create: `crates/memory/src/sources.rs`
- Create: `crates/memory/tests/sources.rs`
- Modify: `crates/memory/src/lib.rs`

- [ ] **Step 1: Scrivere il test rosso per raccolte, deny-wins e segreti**

```rust
use local_first_memory::{
    DataSensitivity, MemoryCollectionKey, MemoryGrantOverrideEffect, MemoryRecord,
    MemoryRef, MemoryRefKind, MemorySourceGrant, MemorySourcePolicy, MemoryStatus,
    PrivacyDomain, UserId, WorkspaceId,
};

fn record(memory_type: &str, sensitivity: DataSensitivity, metadata: serde_json::Value) -> MemoryRecord {
    let user = UserId::new("owner");
    let workspace = WorkspaceId::new("source");
    MemoryRecord {
        reference: MemoryRef::generated(MemoryRefKind::Memory, user.clone(), workspace.clone()),
        user_id: user,
        workspace_id: workspace,
        memory_type: memory_type.to_string(),
        text: "Prefers concise Italian replies".to_string(),
        aliases: vec![],
        language_hints: vec!["it".to_string()],
        confidence: 0.9,
        status: MemoryStatus::Confirmed,
        privacy_domain: PrivacyDomain::new("personal"),
        sensitivity,
        metadata,
        created_at: "unix:1.000000000".to_string(),
        updated_at: "unix:1.000000000".to_string(),
        last_seen_at: None,
        supersedes: vec![],
        superseded_by: None,
        correction_of: None,
    }
}

#[test]
fn preferences_collection_allows_only_preferences() {
    let preference = record("preference", DataSensitivity::Private, serde_json::json!({}));
    let fact = record("fact", DataSensitivity::Private, serde_json::json!({}));
    let policy = MemorySourcePolicy::for_collections(
        vec![MemoryCollectionKey::Preferences],
        DataSensitivity::Private,
    );
    assert!(policy.allows(&preference).is_allowed());
    assert_eq!(policy.allows(&fact).reason(), "collection_not_allowed");
}

#[test]
fn individual_deny_wins_and_secret_never_becomes_shareable() {
    let private = record("preference", DataSensitivity::Private, serde_json::json!({}));
    let secret = record("preference", DataSensitivity::Secret, serde_json::json!({}));
    let mut policy = MemorySourcePolicy::for_collections(
        vec![MemoryCollectionKey::Preferences],
        DataSensitivity::Secret,
    );
    policy.set_override(private.reference.clone(), MemoryGrantOverrideEffect::Deny);
    policy.set_override(secret.reference.clone(), MemoryGrantOverrideEffect::Allow);
    assert_eq!(policy.allows(&private).reason(), "memory_explicitly_denied");
    assert_eq!(policy.allows(&secret).reason(), "secret_never_shareable");
}
```

- [ ] **Step 2: Eseguire il test e verificare il rosso**

Run: `cargo test -p local-first-memory --test sources -- --nocapture`

Expected: FAIL perché `MemoryCollectionKey`, `MemorySourcePolicy` e i tipi grant non esistono.

- [ ] **Step 3: Implementare tipi e policy pura in `sources.rs`**

```rust
use crate::{contains_secret, DataSensitivity, MemoryRecord, MemoryRef, UserId, WorkspaceId};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryCollectionKey {
    Preferences,
    Profile,
    Knowledge,
    Decisions,
    Goals,
    Artifacts,
    Episodes,
}

impl MemoryCollectionKey {
    pub fn matches(self, memory: &MemoryRecord) -> bool {
        let personal_profile = memory.memory_type == "fact"
            && memory.metadata.get("scope").and_then(|v| v.as_str()) == Some("personal");
        match self {
            Self::Preferences => memory.memory_type == "preference",
            Self::Profile => personal_profile,
            Self::Knowledge => matches!(memory.memory_type.as_str(), "fact" | "note") && !personal_profile,
            Self::Decisions => memory.memory_type == "decision",
            Self::Goals => matches!(memory.memory_type.as_str(), "goal" | "objective" | "open_loop"),
            Self::Artifacts => memory.memory_type == "artifact",
            Self::Episodes => memory.memory_type == "episode",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryGrantOverrideEffect {
    Allow,
    Deny,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MemorySourceGrant {
    pub id: String,
    pub consumer_user_id: UserId,
    pub consumer_workspace_id: WorkspaceId,
    pub source_user_id: UserId,
    pub source_workspace_id: WorkspaceId,
    pub collections: BTreeSet<MemoryCollectionKey>,
    pub max_sensitivity: DataSensitivity,
    pub overrides: HashMap<MemoryRef, MemoryGrantOverrideEffect>,
    pub expires_at: Option<i64>,
    pub revoked_at: Option<i64>,
    pub policy_version: u64,
    pub created_by: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemorySourceDecision {
    allowed: bool,
    reason: &'static str,
}

impl MemorySourceDecision {
    pub fn allow() -> Self { Self { allowed: true, reason: "allowed" } }
    pub fn deny(reason: &'static str) -> Self { Self { allowed: false, reason } }
    pub fn is_allowed(&self) -> bool { self.allowed }
    pub fn reason(&self) -> &'static str { self.reason }
}

#[derive(Debug, Clone, PartialEq)]
pub struct MemorySourcePolicy {
    pub collections: BTreeSet<MemoryCollectionKey>,
    pub max_sensitivity: DataSensitivity,
    pub overrides: HashMap<MemoryRef, MemoryGrantOverrideEffect>,
}

impl MemorySourcePolicy {
    pub fn for_collections(
        collections: Vec<MemoryCollectionKey>,
        max_sensitivity: DataSensitivity,
    ) -> Self {
        Self { collections: collections.into_iter().collect(), max_sensitivity, overrides: HashMap::new() }
    }

    pub fn set_override(&mut self, reference: MemoryRef, effect: MemoryGrantOverrideEffect) {
        self.overrides.insert(reference, effect);
    }

    pub fn allows(&self, memory: &MemoryRecord) -> MemorySourceDecision {
        if memory.sensitivity == DataSensitivity::Secret {
            return MemorySourceDecision::deny("secret_never_shareable");
        }
        let sensitive_payload = serde_json::json!({ "text": memory.text.as_str(), "metadata": &memory.metadata });
        if contains_secret(&sensitive_payload) {
            return MemorySourceDecision::deny("vault_payload_never_shareable");
        }
        if memory.sensitivity > self.max_sensitivity {
            return MemorySourceDecision::deny("sensitivity_above_grant");
        }
        if self.overrides.get(&memory.reference) == Some(&MemoryGrantOverrideEffect::Deny) {
            return MemorySourceDecision::deny("memory_explicitly_denied");
        }
        let collection_allowed = self.collections.iter().any(|collection| collection.matches(memory));
        let individually_allowed = self.overrides.get(&memory.reference) == Some(&MemoryGrantOverrideEffect::Allow);
        if !collection_allowed && !individually_allowed {
            return MemorySourceDecision::deny("collection_not_allowed");
        }
        MemorySourceDecision::allow()
    }
}
```

In `lib.rs` aggiungere `mod sources;` e `pub use sources::*;`.

- [ ] **Step 4: Eseguire test mirato e crate completo**

Run: `cargo test -p local-first-memory --test sources -- --nocapture && cargo test -p local-first-memory --lib -- --nocapture`

Expected: PASS, nessuna regressione nei test del crate.

- [ ] **Step 5: Commit**

```bash
git add crates/memory/src/lib.rs crates/memory/src/sources.rs crates/memory/tests/sources.rs
git commit -m "feat(memory): define linked source policy"
```

## Task 2: Persistenza delle grant, override e schema v4

**Files:**
- Create: `crates/memory/tests/source_grants.rs`
- Modify: `crates/memory/src/store.rs`
- Modify: `crates/memory/src/facade.rs`

- [ ] **Step 1: Scrivere il test rosso di round-trip, revoca e default vuoto**

```rust
use local_first_memory::{
    DataSensitivity, MemoryCollectionKey, MemoryFacade, MemorySourceGrant,
    SQLiteMemoryStore, UserId, WorkspaceId,
};
use std::collections::{BTreeSet, HashMap};

fn grant() -> MemorySourceGrant {
    MemorySourceGrant {
        id: "grant-1".to_string(),
        consumer_user_id: UserId::new("owner"),
        consumer_workspace_id: WorkspaceId::new("project-a"),
        source_user_id: UserId::new("owner"),
        source_workspace_id: WorkspaceId::new("__personal__"),
        collections: BTreeSet::from([MemoryCollectionKey::Preferences]),
        max_sensitivity: DataSensitivity::Private,
        overrides: HashMap::new(),
        expires_at: None,
        revoked_at: None,
        policy_version: 1,
        created_by: "owner".to_string(),
        created_at: "unix:10.000000000".to_string(),
        updated_at: "unix:10.000000000".to_string(),
    }
}

#[test]
fn grant_round_trip_and_revoke_are_durable() {
    let facade = MemoryFacade::new(SQLiteMemoryStore::open_in_memory().unwrap());
    assert!(facade.list_memory_source_grants(&UserId::new("owner"), &WorkspaceId::new("project-a")).unwrap().is_empty());
    facade.upsert_memory_source_grant(&grant()).unwrap();
    let stored = facade.list_memory_source_grants(&UserId::new("owner"), &WorkspaceId::new("project-a")).unwrap();
    assert_eq!(stored, vec![grant()]);
    facade.revoke_memory_source_grant("grant-1", 20).unwrap();
    let revoked = facade.get_memory_source_grant("grant-1").unwrap().unwrap();
    assert_eq!(revoked.revoked_at, Some(20));
    assert_eq!(revoked.policy_version, 2);
}
```

- [ ] **Step 2: Verificare il rosso**

Run: `cargo test -p local-first-memory --test source_grants -- --nocapture`

Expected: FAIL perché facade e store non espongono i metodi delle grant.

- [ ] **Step 3: Aggiungere schema e indici**

Portare `SCHEMA_VERSION` da `3` a `4` e aggiungere in `SQLiteMemoryStore::init`:

```sql
create table if not exists memory_source_grants (
    id text primary key,
    consumer_user_id text not null,
    consumer_workspace_id text not null,
    source_user_id text not null,
    source_workspace_id text not null,
    max_sensitivity text not null,
    expires_at integer,
    revoked_at integer,
    policy_version integer not null,
    created_by text not null,
    created_at text not null,
    updated_at text not null
);
create index if not exists idx_memory_source_grants_consumer
    on memory_source_grants(consumer_user_id, consumer_workspace_id, revoked_at);

create table if not exists memory_source_grant_collections (
    grant_id text not null references memory_source_grants(id) on delete cascade,
    collection_key text not null,
    primary key(grant_id, collection_key)
);

create table if not exists memory_source_grant_overrides (
    grant_id text not null references memory_source_grants(id) on delete cascade,
    memory_ref text not null,
    effect text not null check(effect in ('allow', 'deny')),
    primary key(grant_id, memory_ref)
);
```

Aggiungere `DerefMut` a `ConnHandle` per usare transazioni rusqlite:

```rust
impl std::ops::DerefMut for ConnHandle<'_> {
    fn deref_mut(&mut self) -> &mut Connection {
        match self {
            ConnHandle::Guarded(guard) => guard,
        }
    }
}
```

- [ ] **Step 4: Implementare upsert/list/get/revoke nello store e wrapper facade**

L'upsert deve usare una transazione e sostituire atomicamente collections/override:

```rust
pub fn upsert_memory_source_grant(&self, grant: &MemorySourceGrant) -> Result<(), String> {
    let mut conn = self.write_conn();
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    tx.execute(
        "insert into memory_source_grants (
            id, consumer_user_id, consumer_workspace_id, source_user_id, source_workspace_id,
            max_sensitivity, expires_at, revoked_at, policy_version, created_by, created_at, updated_at
         ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
         on conflict(id) do update set
            max_sensitivity=excluded.max_sensitivity,
            expires_at=excluded.expires_at,
            revoked_at=excluded.revoked_at,
            policy_version=excluded.policy_version,
            updated_at=excluded.updated_at",
        rusqlite::params![
            grant.id,
            grant.consumer_user_id.as_str(),
            grant.consumer_workspace_id.as_str(),
            grant.source_user_id.as_str(),
            grant.source_workspace_id.as_str(),
            enum_name(&grant.max_sensitivity)?,
            grant.expires_at,
            grant.revoked_at,
            grant.policy_version as i64,
            grant.created_by,
            grant.created_at,
            grant.updated_at,
        ],
    ).map_err(|error| error.to_string())?;
    tx.execute("delete from memory_source_grant_collections where grant_id = ?1", [&grant.id])
        .map_err(|error| error.to_string())?;
    tx.execute("delete from memory_source_grant_overrides where grant_id = ?1", [&grant.id])
        .map_err(|error| error.to_string())?;
    for collection in &grant.collections {
        tx.execute(
            "insert into memory_source_grant_collections(grant_id, collection_key) values (?1, ?2)",
            (&grant.id, enum_name(collection)?),
        ).map_err(|error| error.to_string())?;
    }
    for (memory_ref, effect) in &grant.overrides {
        tx.execute(
            "insert into memory_source_grant_overrides(grant_id, memory_ref, effect) values (?1, ?2, ?3)",
            (&grant.id, memory_ref.to_string(), enum_name(effect)?),
        ).map_err(|error| error.to_string())?;
    }
    tx.commit().map_err(|error| error.to_string())
}
```

I metodi `list_memory_source_grants`, `get_memory_source_grant` e
`revoke_memory_source_grant` devono usare un unico mapper `memory_source_grant_from_row`
e caricare collections/override per id. La revoca esegue:

```sql
update memory_source_grants
set revoked_at = ?2, policy_version = policy_version + 1, updated_at = ?3
where id = ?1 and revoked_at is null
```

Il facade espone gli stessi quattro metodi senza accesso diretto allo store.

- [ ] **Step 5: Eseguire test e commit**

Run: `cargo test -p local-first-memory --test source_grants -- --nocapture && cargo test -p local-first-memory -- --nocapture`

Expected: PASS; `schema_version()` restituisce `4`.

```bash
git add crates/memory/src/store.rs crates/memory/src/facade.rs crates/memory/tests/source_grants.rs
git commit -m "feat(memory): persist linked source grants"
```

## Task 3: Resolver fail-closed e fingerprint di policy

**Files:**
- Modify: `crates/memory/src/sources.rs`
- Modify: `crates/memory/src/facade.rs`
- Modify: `crates/memory/tests/sources.rs`

- [ ] **Step 1: Aggiungere test rosso per fonte locale, scadenza e non-transitività**

```rust
#[test]
fn resolver_returns_local_plus_direct_active_sources_only() {
    let consumer_user = UserId::new("owner");
    let consumer = WorkspaceId::new("project-a");
    let direct = MemorySourceGrant {
        id: "direct".to_string(),
        consumer_user_id: consumer_user.clone(),
        consumer_workspace_id: consumer.clone(),
        source_user_id: consumer_user.clone(),
        source_workspace_id: WorkspaceId::new("project-b"),
        collections: BTreeSet::from([MemoryCollectionKey::Decisions]),
        max_sensitivity: DataSensitivity::Private,
        overrides: HashMap::new(),
        expires_at: None,
        revoked_at: None,
        policy_version: 1,
        created_by: "owner".to_string(),
        created_at: "unix:1.000000000".to_string(),
        updated_at: "unix:1.000000000".to_string(),
    };
    let transitive = MemorySourceGrant {
        id: "transitive".to_string(),
        consumer_workspace_id: WorkspaceId::new("project-b"),
        source_workspace_id: WorkspaceId::new("project-c"),
        ..direct.clone()
    };
    let resolved = resolve_memory_sources(&consumer_user, &consumer, &[direct, transitive], 100).unwrap();
    assert_eq!(resolved.len(), 2);
    assert!(resolved[0].grant_id.is_none());
    assert_eq!(resolved[1].source_workspace_id.as_str(), "project-b");
}
```

- [ ] **Step 2: Verificare il rosso**

Run: `cargo test -p local-first-memory --test sources resolver_returns -- --nocapture`

Expected: FAIL perché resolver e fonte autorizzata non esistono.

- [ ] **Step 3: Implementare resolver e fingerprint**

```rust
#[derive(Debug, Clone, PartialEq)]
pub struct AuthorizedMemorySource {
    pub source_user_id: UserId,
    pub source_workspace_id: WorkspaceId,
    pub source_label: String,
    pub grant_id: Option<String>,
    pub policy: Option<MemorySourcePolicy>,
    pub policy_version: u64,
}

pub fn resolve_memory_sources(
    consumer_user: &UserId,
    consumer_workspace: &WorkspaceId,
    grants: &[MemorySourceGrant],
    now_unix: i64,
) -> Result<Vec<AuthorizedMemorySource>, String> {
    let mut sources = vec![AuthorizedMemorySource {
        source_user_id: consumer_user.clone(),
        source_workspace_id: consumer_workspace.clone(),
        source_label: consumer_workspace.as_str().to_string(),
        grant_id: None,
        policy: None,
        policy_version: 0,
    }];
    for grant in grants.iter().filter(|grant| {
        grant.consumer_user_id == *consumer_user
            && grant.consumer_workspace_id == *consumer_workspace
    }) {
        if grant.source_user_id != *consumer_user {
            return Err("cross_user_source_not_supported".to_string());
        }
        if grant.revoked_at.is_some() || grant.expires_at.is_some_and(|expiry| expiry <= now_unix) {
            continue;
        }
        if grant.source_workspace_id == *consumer_workspace {
            return Err("source_equals_consumer".to_string());
        }
        sources.push(AuthorizedMemorySource {
            source_user_id: grant.source_user_id.clone(),
            source_workspace_id: grant.source_workspace_id.clone(),
            source_label: if grant.source_workspace_id.as_str() == "__personal__" {
                "Personal".to_string()
            } else {
                grant.source_workspace_id.as_str().to_string()
            },
            grant_id: Some(grant.id.clone()),
            policy: Some(MemorySourcePolicy {
                collections: grant.collections.clone(),
                max_sensitivity: grant.max_sensitivity,
                overrides: grant.overrides.clone(),
            }),
            policy_version: grant.policy_version,
        });
    }
    sources.sort_by(|a, b| a.grant_id.is_some().cmp(&b.grant_id.is_some()).then_with(|| a.source_workspace_id.as_str().cmp(b.source_workspace_id.as_str())));
    Ok(sources)
}
```

Aggiungere `memory_source_policy_fingerprint(sources: &[AuthorizedMemorySource]) -> u64`
usando `sha2::Sha256` su source id, grant id, version e collections ordinate; usare i primi
8 byte del digest come `u64`.

- [ ] **Step 4: Esporre il resolver dal facade e verificare**

`MemoryFacade::resolve_memory_sources(user, workspace, now_unix)` carica soltanto le grant
del consumer e chiama la funzione pura. Nessun accesso alle grant delle source.

Run: `cargo test -p local-first-memory --test sources -- --nocapture && cargo test -p local-first-memory --test source_grants -- --nocapture`

Expected: PASS, inclusi grant scaduti/revocati esclusi e project C non transitivo.

- [ ] **Step 5: Commit**

```bash
git add crates/memory/src/sources.rs crates/memory/src/facade.rs crates/memory/tests/sources.rs
git commit -m "feat(memory): resolve authorized memory sources"
```

## Task 4: API gateway e bridge desktop per gestire le grant

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs`
- Modify: `apps/desktop/src/lib/coreBridge.ts`

- [ ] **Step 1: Scrivere test gateway rossi sui request validator**

Nel modulo test di `main.rs` aggiungere:

```rust
#[test]
fn memory_source_input_rejects_self_source_and_unknown_collection() {
    let self_source = super::MemorySourceUpsertRequest {
        source_workspace_id: "project-a".to_string(),
        collections: vec!["preferences".to_string()],
        max_sensitivity: "private".to_string(),
        expires_at: None,
        overrides: vec![],
    };
    assert_eq!(super::validate_memory_source_input("project-a", &self_source).unwrap_err(), "source_equals_consumer");
    let bad_collection = super::MemorySourceUpsertRequest {
        source_workspace_id: "project-b".to_string(),
        collections: vec!["everything".to_string()],
        max_sensitivity: "private".to_string(),
        expires_at: None,
        overrides: vec![],
    };
    assert_eq!(super::validate_memory_source_input("project-a", &bad_collection).unwrap_err(), "collection_not_allowed");
}
```

- [ ] **Step 2: Verificare il rosso**

Run: `cargo test -p local-first-desktop-gateway memory_source_input_ -- --nocapture`

Expected: FAIL perché request e validator non esistono.

- [ ] **Step 3: Aggiungere route e handler owner-only**

Aggiungere route distinte da `/access`:

```rust
.route(
    "/api/workspaces/{workspace_id}/memory-sources",
    get(memory_sources_list),
)
.route(
    "/api/workspaces/{workspace_id}/memory-sources/upsert",
    post(memory_sources_upsert),
)
.route(
    "/api/workspaces/{workspace_id}/memory-sources/{grant_id}/revoke",
    post(memory_sources_revoke),
)
.route(
    "/api/workspaces/{workspace_id}/memory-sources/candidates",
    get(memory_source_candidates),
)
```

Gli handler devono:

1. derivare `consumer_user_id` da `gateway_memory_user_id()`;
2. verificare consumer e source contro lo snapshot workspace server-side, ammettendo
   `__personal__` come source riservata;
3. convertire collection/sensitivity con enum tipizzati;
4. validare ogni override caricando il record nello scope sorgente;
5. incrementare `policy_version` su update;
6. restituire `MemorySourceGrantView` senza testo di memoria.

`memory_source_candidates` accetta `source_workspace_id`, rivalida owner/source e restituisce
solo `ref`, summary redatto, type, collection e sensitivity dei record non-Secret. Serve al
controllo avanzato per singola memoria; non è una search libera e non accetta scope arbitrari.

La lista non elimina una grant se il workspace sorgente non esiste più: restituisce una
source non disponibile, la esclude dal resolver gateway e permette soltanto la revoca.

La funzione di flag iniziale è:

```rust
fn memory_sources_flag(value: Option<&str>) -> bool {
    matches!(value.map(str::trim), Some("1") | Some("on") | Some("ON") | Some("On"))
}

fn memory_sources_enabled() -> bool {
    memory_sources_flag(std::env::var("HOMUN_MEMORY_SOURCES").ok().as_deref())
}
```

Con flag off, le mutazioni restituiscono `memory_sources_disabled`; la lista restituisce
solo la source locale implicita.

- [ ] **Step 4: Tipizzare il bridge desktop**

```ts
export type MemoryCollectionKey =
  | "preferences"
  | "profile"
  | "knowledge"
  | "decisions"
  | "goals"
  | "artifacts"
  | "episodes";

export interface MemorySourceGrantView {
  id: string | null;
  source_workspace_id: string;
  source_label: string;
  source_available: boolean;
  local: boolean;
  read_only: boolean;
  collections: MemoryCollectionKey[];
  max_sensitivity: "public" | "internal" | "private" | "confidential";
  expires_at?: number | null;
  revoked_at?: number | null;
  policy_version: number;
  last_used_at?: number | null;
}

export interface MemorySourceUpsertInput {
  source_workspace_id: string;
  collections: MemoryCollectionKey[];
  max_sensitivity: MemorySourceGrantView["max_sensitivity"];
  expires_at?: number | null;
  overrides: Array<{ memory_ref: string; effect: "allow" | "deny" }>;
}

export interface MemorySourceCandidateView {
  ref: string;
  summary: string;
  type: string;
  collection: MemoryCollectionKey;
  sensitivity: MemorySourceGrantView["max_sensitivity"];
}
```

Aggiungere `memorySources`, `memorySourceCandidates`, `upsertMemorySource` e
`revokeMemorySource` a `coreBridge` con gli URL delle route sopra.

- [ ] **Step 5: Verificare e commit**

Run: `cargo test -p local-first-desktop-gateway memory_source_ -- --nocapture && (cd apps/desktop && npm run typecheck)`

Expected: PASS.

```bash
git add crates/desktop-gateway/src/main.rs apps/desktop/src/lib/coreBridge.ts
git commit -m "feat(memory): expose memory source grant APIs"
```

## Task 5: Recall strutturato e filtro prima della candidatura

**Files:**
- Modify: `crates/memory/src/service.rs`
- Modify: `crates/memory/src/search.rs`
- Modify: `crates/memory/src/recall.rs`
- Modify: `crates/memory/src/facade.rs`
- Modify: `crates/memory/src/vector_index.rs`
- Create: `crates/memory/tests/multi_source_recall.rs`

- [ ] **Step 1: Scrivere il test rosso per hit autorizzati e provenienza**

```rust
#[test]
fn source_recall_never_returns_denied_or_secret_candidates() {
    let fixture = RecallFixture::new();
    let allowed = fixture.insert("preference", "Prefers concise answers", DataSensitivity::Private);
    fixture.insert("fact", "Private family detail", DataSensitivity::Private);
    fixture.insert("preference", "API key secret", DataSensitivity::Secret);
    let policy = MemorySourcePolicy::for_collections(
        vec![MemoryCollectionKey::Preferences],
        DataSensitivity::Private,
    );
    let pack = recall_source_on_facade(
        &fixture.facade,
        &fixture.source(),
        &policy,
        "How should replies be written?",
        &fixture.query_vector(),
        None,
    ).unwrap();
    assert_eq!(pack.hits.len(), 1);
    assert_eq!(pack.hits[0].memory_ref, allowed.to_string());
    assert_eq!(pack.hits[0].source_workspace_id.as_str(), "source");
}
```

`RecallFixture` deve creare `MemoryFacade::open_in_memory`, inserire record ed embedding
deterministici e restituire una `AuthorizedMemorySource` con `grant_id = Some("grant-1")`.

- [ ] **Step 2: Verificare il rosso**

Run: `cargo test -p local-first-memory --test multi_source_recall source_recall_ -- --nocapture`

Expected: FAIL perché `RecallHit` non porta provenienza e non esiste recall per source.

- [ ] **Step 3: Estendere `RecallHit` e aggiungere constraint tipizzato**

```rust
#[derive(Debug, Clone, PartialEq)]
pub struct RecallHit {
    pub memory_ref: String,
    pub text: String,
    pub score: f32,
    pub kind: String,
    pub source_user_id: UserId,
    pub source_workspace_id: WorkspaceId,
    pub source_label: String,
    pub collection: MemoryCollectionKey,
    pub grant_id: Option<String>,
    pub sensitivity: DataSensitivity,
    pub status: MemoryStatus,
    pub updated_at: String,
    pub subject_key: Option<String>,
    pub conflict: bool,
}
```

Il `subject_key` deriva esclusivamente da `metadata.subject_key`,
`metadata.canonical_key` o da una relazione canonica già presente; non va inferito dal
testo libero.

Aggiungere il costruttore usato dai task successivi:

```rust
impl RecallPack {
    pub fn from_hits(query: String, scope: MemoryScope, hits: Vec<RecallHit>) -> Self {
        let block = format_recall_hits(&hits);
        Self { query, scope, hits, block }
    }
}

fn format_recall_hits(hits: &[RecallHit]) -> Option<String> {
    if hits.is_empty() {
        return None;
    }
    let lines = hits.iter().map(|hit| {
        let conflict = if hit.conflict { " [conflict]" } else { "" };
        format!("- [source: {}] {}{}", hit.source_label, hit.text, conflict)
    }).collect::<Vec<_>>();
    Some(format!("RELEVANT MEMORY:\n{}", lines.join("\n")))
}
```

In `search.rs` aggiungere la request seguente; non cambiare la shape pubblica legacy di
`MemorySearchRequest`:

```rust
#[derive(Debug, Clone, PartialEq)]
pub struct AuthorizedMemorySearchRequest {
    pub access: MemoryAccessRequest,
    pub source_policy: Option<MemorySourcePolicy>,
    pub query: String,
    pub statuses: Vec<MemoryStatus>,
    pub memory_types: Vec<String>,
    pub limit: usize,
    pub offset: usize,
}
```

Il facade filtra il record con `policy.allows` prima di inserirlo nel vettore `allowed`.
`recall_source_on_facade` costruisce sempre la richiesta base con lo scope della source,
così la policy esistente continua a vedere un match esatto:

```rust
let access = MemoryAccessRequest {
    actor_id: "chat_rag".to_string(),
    user_id: source.source_user_id.clone(),
    workspace_id: source.source_workspace_id.clone(),
    purpose: "chat_context".to_string(),
    allowed_domains: vec![
        PrivacyDomain::new("personal"),
        PrivacyDomain::new("work"),
        PrivacyDomain::new("general"),
    ],
    max_sensitivity: source.policy.as_ref()
        .map(|policy| policy.max_sensitivity)
        .unwrap_or(DataSensitivity::Private),
    allow_raw_payload: false,
    allow_export: true,
    broad_query: false,
};
```

- [ ] **Step 4: Costruire l'indice vettoriale soltanto da embedding autorizzati**

Aggiungere al facade:

```rust
pub fn search_authorized_embeddings(
    &self,
    source: &AuthorizedMemorySource,
    query: &[f32],
    limit: usize,
) -> MemoryResult<Vec<VectorHit>> {
    let records = self.store.list_memories(&source.source_user_id, &source.source_workspace_id)?;
    let allowed_refs: std::collections::HashSet<MemoryRef> = records
        .into_iter()
        .filter(|memory| source.policy.as_ref().is_none_or(|policy| policy.allows(memory).is_allowed()))
        .filter(|memory| !memory.metadata.get("published_alias").and_then(|value| value.as_bool()).unwrap_or(false))
        .map(|memory| memory.reference)
        .collect();
    let embeddings = self.store.list_embeddings(&source.source_user_id, &source.source_workspace_id)?
        .into_iter()
        .filter(|(reference, _)| allowed_refs.contains(reference));
    let index = crate::MemoryVectorIndexCache::from_embeddings(embeddings)?;
    crate::MemoryVectorIndex::search(&index, query, limit)
}
```

Prima versione corretta prima dell'ottimizzazione: nessun embedding non autorizzato entra
nell'indice derivato della query. Nel Task 6 la cache userà source generation + policy
fingerprint; non riusare l'indice scoped completo esistente per le grant.

Implementare `recall_source_on_facade` riusando scoring RRF e restituendo
`MemoryResult<RecallPack>` con `hits` strutturati e `block` formato da quegli stessi hit.

- [ ] **Step 5: Verificare compatibilità e commit**

Run: `cargo test -p local-first-memory --test multi_source_recall -- --nocapture && cargo test -p local-first-memory recall -- --nocapture`

Expected: PASS; i test legacy del blocco testuale restano verdi.

```bash
git add crates/memory/src/service.rs crates/memory/src/search.rs crates/memory/src/recall.rs crates/memory/src/facade.rs crates/memory/src/vector_index.rs crates/memory/tests/multi_source_recall.rs
git commit -m "feat(memory): return policy-filtered recall hits"
```

## Task 6: Coordinatore multi-source, merge, conflitti e audit aggregato

**Files:**
- Modify: `crates/memory/src/recall.rs`
- Modify: `crates/memory/src/store.rs`
- Modify: `crates/memory/src/facade.rs`
- Modify: `crates/memory/tests/multi_source_recall.rs`

- [ ] **Step 1: Scrivere test rossi per precedenze e non-transitività**

```rust
#[test]
fn merge_prefers_local_decision_and_personal_preference_without_hiding_conflict() {
    let local_decision = hit("project-a", None, "decision", "Launch in September", 0.80);
    let linked_decision = hit("project-b", Some("grant-b"), "decision", "Launch in June", 0.95);
    let local_preference = hit("project-a", None, "preference", "Use English", 0.90);
    let personal_preference = hit("__personal__", Some("grant-p"), "preference", "Use Italian", 0.70);
    let merged = merge_recall_hits(
        WorkspaceId::new("project-a"),
        vec![local_decision, linked_decision, local_preference, personal_preference],
        10,
    );
    assert_eq!(merged[0].text, "Launch in September");
    assert!(merged.iter().any(|item| item.text == "Launch in June" && item.conflict));
    assert!(merged.iter().position(|item| item.text == "Use Italian").unwrap()
        < merged.iter().position(|item| item.text == "Use English").unwrap());
}

#[test]
fn source_failure_degrades_to_local_hits() {
    let fixture = MultiSourceFixture::with_failing_linked_source();
    let pack = fixture.recall("What did this project decide?").unwrap();
    assert!(pack.hits.iter().any(|hit| hit.source_workspace_id.as_str() == "project-a"));
    assert!(pack.degraded_sources.iter().any(|(source, _)| source.as_str() == "project-b"));
}
```

L'helper `hit` assegna `subject_key = Some("launch_date")` alle due decisioni e
`subject_key = Some("reply_language")` alle due preferenze. Senza chiave/evidenza comune,
il merge non inventa un conflitto.

- [ ] **Step 2: Verificare il rosso**

Run: `cargo test -p local-first-memory --test multi_source_recall merge_prefers_ -- --nocapture`

Expected: FAIL perché merge e conflitto non esistono.

- [ ] **Step 3: Implementare coordinamento e budget**

Aggiungere un intent router deterministico che vede solo la query e il catalogo, non i
contenuti delle source:

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryRecallIntent {
    pub collections: std::collections::BTreeSet<MemoryCollectionKey>,
}

pub fn memory_recall_intent(query: &str) -> MemoryRecallIntent {
    let lower = query.to_lowercase();
    let mut collections = std::collections::BTreeSet::from([
        MemoryCollectionKey::Knowledge,
        MemoryCollectionKey::Decisions,
    ]);
    if ["prefer", "stile", "lingua", "language", "tone", "come vuoi"]
        .iter().any(|term| lower.contains(term))
    {
        collections.insert(MemoryCollectionKey::Preferences);
    }
    if ["chi sono", "profilo", "lavoro", "my ", "mio ", "mia "]
        .iter().any(|term| lower.contains(term))
    {
        collections.insert(MemoryCollectionKey::Profile);
    }
    if ["obiettivo", "goal", "todo", "aperto", "manca"]
        .iter().any(|term| lower.contains(term))
    {
        collections.insert(MemoryCollectionKey::Goals);
    }
    if ["file", "document", "presentazione", "artifact", "deliverable"]
        .iter().any(|term| lower.contains(term))
    {
        collections.insert(MemoryCollectionKey::Artifacts);
    }
    if ["prima", "scorsa", "discusso", "ricordi", "previous"]
        .iter().any(|term| lower.contains(term))
    {
        collections.insert(MemoryCollectionKey::Episodes);
    }
    MemoryRecallIntent { collections }
}
```

Testare almeno query preferenza, decisione, obiettivo, artefatto ed episodio. Una source
collegata viene interrogata soltanto se le sue collections intersecano l'intent oppure
contiene un override individuale `Allow`; la source locale resta sempre eleggibile.

Aggiungere quindi il coordinatore:

```rust
pub fn recall_authorized_sources_on_facade(
    facade: &MemoryFacade,
    user: &UserId,
    consumer_workspace: &WorkspaceId,
    query: &str,
    query_vec: &[f32],
    now_unix: i64,
    graph_context: Option<&(dyn Fn(&MemoryFacade, &UserId, &WorkspaceId, &str) -> Option<String> + Sync)>,
) -> MemoryResult<RecallPack> {
    let sources = facade.resolve_memory_sources(user, consumer_workspace, now_unix)?;
    let intent = memory_recall_intent(query);
    let mut hits = Vec::new();
    let mut degraded_sources = Vec::new();
    for source in &sources {
        if let Some(policy) = &source.policy {
            let has_individual_allow = policy.overrides.values().any(|effect| *effect == MemoryGrantOverrideEffect::Allow);
            if policy.collections.is_disjoint(&intent.collections) && !has_individual_allow {
                continue;
            }
        }
        let policy = source.policy.clone().unwrap_or_else(|| MemorySourcePolicy::for_collections(
            vec![
                MemoryCollectionKey::Preferences,
                MemoryCollectionKey::Profile,
                MemoryCollectionKey::Knowledge,
                MemoryCollectionKey::Decisions,
                MemoryCollectionKey::Goals,
                MemoryCollectionKey::Artifacts,
                MemoryCollectionKey::Episodes,
            ],
            DataSensitivity::Private,
        ));
        match recall_source_on_facade(facade, source, &policy, query, query_vec, graph_context) {
            Ok(pack) => hits.extend(pack.hits),
            Err(error) if source.grant_id.is_some() => {
                degraded_sources.push((source.source_workspace_id.clone(), error.to_string()));
            }
            Err(error) => return Err(error),
        }
    }
    let hits = merge_recall_hits(consumer_workspace.clone(), hits, 10);
    let scope = if consumer_workspace.as_str() == PERSONAL_WORKSPACE {
        MemoryScope::Personal
    } else {
        MemoryScope::Project(consumer_workspace.clone())
    };
    Ok(RecallPack::from_hits_and_degraded(query.to_string(), scope, hits, degraded_sources))
}
```

Estendere `RecallPack` con `degraded_sources: Vec<(WorkspaceId, String)>`; il blocco prompt
non include gli errori tecnici, mentre trace e audit ricevono reason code redatti. Aggiornare
`from_block` e `from_hits` impostando `degraded_sources: Vec::new()`.

```rust
impl RecallPack {
    pub fn from_hits_and_degraded(
        query: String,
        scope: MemoryScope,
        hits: Vec<RecallHit>,
        degraded_sources: Vec<(WorkspaceId, String)>,
    ) -> Self {
        let block = format_recall_hits(&hits);
        Self { query, scope, hits, block, degraded_sources }
    }
}
```

`merge_recall_hits` deve deduplicare per ref/testo normalizzato/publication link, marcare
conflitto soltanto quando due hit hanno stesso `kind` e stesso `subject_key` esplicito ma
testo normalizzato differente, applicare precedenza semantica e riservare almeno 4 slot
alla source locale quando disponibili. Il formato prompt deve
includere `[source: <label>]` per ogni hit e una sezione `CONFLICTING MEMORY` separata.

Subito prima di formattare/iniettare, ricalcolare il `policy_fingerprint`: se differisce da
quello risolto all'inizio, scartare tutti gli hit collegati e rifare il merge con la sola
source locale. Questo chiude la revoca concorrente tra ricerca e iniezione.

Sostituire la ricostruzione per-query dell'indice autorizzato del Task 5 con una cache
derivata nel facade, separata dall'indice completo:

```rust
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct AuthorizedVectorIndexKey {
    source_user_id: String,
    source_workspace_id: String,
    policy_fingerprint: u64,
    source_generation: u64,
}
```

`MemoryFacade` mantiene `authorized_vector_indexes: Mutex<HashMap<AuthorizedVectorIndexKey,
MemoryVectorIndexCache>>`. Il key usa la generation già incrementata dagli upsert; una
grant modificata/revocata o una source mutata non può colpire la vecchia cache. Limitare la
map a 64 entry eliminando deterministicamente la entry con generation minore quando si
supera il limite.

- [ ] **Step 4: Aggiungere audit aggregato source-level**

Schema:

```sql
create table if not exists memory_source_access_events (
    id text primary key,
    consumer_user_id text not null,
    consumer_workspace_id text not null,
    source_workspace_id text not null,
    grant_id text,
    policy_version integer not null,
    turn_id text,
    outcome text not null,
    reason text not null,
    candidate_count integer not null,
    injected_refs_json text not null,
    created_at integer not null
);
create index if not exists idx_memory_source_access_consumer
    on memory_source_access_events(consumer_user_id, consumer_workspace_id, created_at);
```

Registrare un evento per source dopo il merge, senza query né testo. Esporre
`last_memory_source_access(grant_id)` per la card UI. Un errore di audit non allarga la
policy e viene tracciato come degradazione.

- [ ] **Step 5: Verificare e commit**

Run: `cargo test -p local-first-memory --test multi_source_recall -- --nocapture && cargo test -p local-first-memory -- --nocapture`

Expected: PASS, inclusi budget locale, conflitti e audit senza testo.

```bash
git add crates/memory/src/recall.rs crates/memory/src/store.rs crates/memory/src/facade.rs crates/memory/tests/multi_source_recall.rs
git commit -m "feat(memory): coordinate authorized recall sources"
```

## Task 7: Wiring gateway, briefing grant-aware e cache revocabile

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs`
- Modify: `crates/memory/src/service.rs`

- [ ] **Step 1: Scrivere test rossi per briefing senza grant e con sole preferenze**

```rust
#[test]
fn project_briefing_requires_personal_preferences_grant() {
    let state = test_app_state_with_personal_preference("Prefers Italian");
    set_memory_workspace("project-a");
    let (personal, project) = gather_profile_memory_with_options(&state, true);
    assert!(personal.is_empty());
    assert!(project.is_empty());
    insert_preferences_grant(&state, "project-a");
    let (personal, _) = gather_profile_memory_with_options(&state, true);
    assert_eq!(personal, vec!["Prefers Italian".to_string()]);
}

#[test]
fn revoking_grant_changes_briefing_fingerprint() {
    let state = test_app_state_with_preferences_grant("project-a");
    let before = memory_briefing_fingerprint(&state, "project-a");
    revoke_preferences_grant(&state, "project-a");
    let after = memory_briefing_fingerprint(&state, "project-a");
    assert_ne!(before, after);
}

#[test]
fn contact_memory_deny_cannot_use_linked_sources() {
    let state = test_app_state_with_preferences_grant("project-a");
    let perimeter = contact_policy_with_project_memory(false);
    let pack = recall_for_contact_policy(&state, "project-a", &perimeter, "Which language?");
    assert!(pack.hits.is_empty());
}
```

- [ ] **Step 2: Verificare il rosso**

Run: `cargo test -p local-first-desktop-gateway project_briefing_requires_ -- --nocapture && cargo test -p local-first-desktop-gateway revoking_grant_changes_ -- --nocapture && cargo test -p local-first-desktop-gateway contact_memory_deny_ -- --nocapture`

Expected: FAIL: oggi le preferenze personali entrano implicitamente e la cache ignora la grant.

- [ ] **Step 3: Instradare service ON e OFF sul coordinatore comune**

In `InProcessMemoryRecallService::recall` sostituire la chiamata single-scope con
`recall_authorized_sources_on_facade`. Nel path `HOMUN_MEMORY_SERVICE=off` usare la stessa
funzione dopo `embed_query`; non mantenere due merge differenti.

Instradare anche il tool esplicito `recall_memory` sul coordinatore quando il turno è in un
progetto. I check `contact_only` e `can_see_contacts/can_use_project_memory` restano prima
del resolver: un contatto negato non può usare il tool per raggiungere una source collegata.
Nello scope Personale il tool continua a consultare soltanto Personale.

La funzione deve rispettare `memory_sources_enabled()`:

```rust
let pack = if memory_sources_enabled() {
    local_first_memory::recall_authorized_sources_on_facade(
        facade,
        &user,
        &workspace,
        query,
        &query_vec,
        unix_now_secs(),
        graph_context,
    )
} else {
    local_first_memory::recall_single_scope_pack(
        facade,
        &user,
        &workspace,
        query,
        &query_vec,
        graph_context,
    )
};
```

- [ ] **Step 4: Rendere briefing e cache grant-aware**

`gather_profile_memory_with_options` legge personale soltanto se il resolver trova una
source `__personal__` con collection `Preferences`. Non deve leggere profile/fact always-on.

Estendere `CachedBriefing`:

```rust
pub struct CachedBriefing {
    pub generation: u64,
    pub source_fingerprint: u64,
    pub prompt_fingerprint: u64,
    pub pack_sans_recent_work: BriefingPack,
}
```

`BriefingCache::get` richiede uguaglianza dei tre valori. Il fingerprint combina
`policy_fingerprint` e `briefing_generation` delle source usate. Revoca, scadenza o update
di una source producono cache miss al turno successivo.

- [ ] **Step 5: Verificare parità e commit**

Run: `cargo test -p local-first-desktop-gateway project_briefing_ -- --nocapture && cargo test -p local-first-desktop-gateway memory_service_ -- --nocapture`

Expected: PASS sia con service off sia con service on.

```bash
git add crates/desktop-gateway/src/main.rs crates/memory/src/service.rs
git commit -m "feat(memory): gate personal briefing by source grant"
```

## Task 8: Provenienza nel turno e pannello “Memorie utilizzate”

**Files:**
- Modify: `crates/engine/src/events.rs`
- Modify: `crates/task-runtime/src/types.rs`
- Modify: `crates/desktop-gateway/src/main.rs`
- Modify: `apps/desktop/src/lib/coreBridge.ts`
- Create: `apps/desktop/src/components/MemoryUsagePopover.tsx`
- Modify: `apps/desktop/src/components/ChatView.tsx`
- Modify: `apps/desktop/src/styles.css`

- [ ] **Step 1: Scrivere test rossi sul payload stream e fanout broker**

```rust
#[test]
fn recall_stream_hit_serializes_source_provenance() {
    let hit = RecallStreamHit {
        r#ref: "memory:owner:project-a:1".to_string(),
        text: "Launch in September".to_string(),
        score: 0.91,
        kind: "decision".to_string(),
        source_workspace_id: "project-a".to_string(),
        source_label: "Homun roadmap".to_string(),
        collection: "decisions".to_string(),
        grant_id: None,
        conflict: false,
    };
    let value = serde_json::to_value(hit).unwrap();
    assert_eq!(value["source_workspace_id"], "project-a");
    assert_eq!(value["collection"], "decisions");
}
```

Nel gateway aggiungere un test che `fanout_turn_event` mappi `type=recall` su
`TurnEventKind::Recall` mantenendo il payload.

- [ ] **Step 2: Verificare il rosso**

Run: `cargo test -p local-first-engine recall_stream_hit_ -- --nocapture && cargo test -p local-first-desktop-gateway fanout_recall_ -- --nocapture`

Expected: FAIL per campi/variant mancanti.

- [ ] **Step 3: Estendere contratti Rust e TypeScript**

In `RecallStreamHit` e `RecallHitPayload` aggiungere gli stessi campi:

```ts
export interface RecallHitPayload {
  ref: string;
  text: string;
  score: number;
  type: string;
  source_workspace_id: string;
  source_label: string;
  collection: MemoryCollectionKey;
  grant_id?: string | null;
  conflict: boolean;
}
```

Aggiungere `Recall` a `TurnEventKind`, al suo `as_str`, al parser e al fanout. Quando il RAG
automatico produce hit, emettere lo stesso evento `GenerateStreamEvent::Recall` già usato
dal tool esplicito, prima della prima delta del modello. Persistire l'event part con la
risposta. Prima dell'emissione il gateway sostituisce il fallback `source_label` del crate
con il nome corrente del workspace ricavato dallo snapshot server-side; `__personal__`
diventa la label localizzata “Personale/Personal”.

- [ ] **Step 4: Rendere il badge cliccabile e mostrare il popover**

`MemoryUsagePopover` riceve `RecallHitPayload[]`, raggruppa per `source_label` e rende:

```tsx
<section className="memory-usage-popover" role="dialog" aria-label={t("chat.memoryUsageTitle")}>
  <header>
    <strong>{t("chat.memoryUsageTitle")}</strong>
    <span>{t("chat.memoryUsageCount", { count: hits.length })}</span>
  </header>
  {groups.map((group) => (
    <article key={group.workspaceId} className="memory-usage-source">
      <h4>{group.label}</h4>
      {group.hits.map((hit) => (
        <div key={`${group.workspaceId}:${hit.ref}`} className="memory-usage-hit">
          <span>{hit.text}</span>
          <small>{hit.collection}{hit.conflict ? ` · ${t("chat.memoryConflict")}` : ""}</small>
        </div>
      ))}
    </article>
  ))}
</section>
```

Il badge diventa un `<button>`; il tooltip non deve più contenere tutto il testo. Aggiungere
chiusura su Escape/click esterno e stili theme-token only.

- [ ] **Step 5: Verificare e commit**

Run: `cargo test -p local-first-engine -- --nocapture && cargo test -p local-first-task-runtime -- --nocapture && cargo test -p local-first-desktop-gateway fanout_recall_ -- --nocapture && (cd apps/desktop && npm run typecheck)`

Expected: PASS.

```bash
git add crates/engine/src/events.rs crates/task-runtime/src/types.rs crates/desktop-gateway/src/main.rs apps/desktop/src/lib/coreBridge.ts apps/desktop/src/components/MemoryUsagePopover.tsx apps/desktop/src/components/ChatView.tsx apps/desktop/src/styles.css
git commit -m "feat(memory): surface recall provenance in chat"
```

## Task 9: UI “Fonti di memoria” nel progetto

**Files:**
- Create: `apps/desktop/src/components/MemorySourcesDialog.tsx`
- Modify: `apps/desktop/src/components/Sidebar.tsx`
- Modify: `apps/desktop/src/styles.css`
- Modify: `apps/desktop/src/i18n/locales/it.json`
- Modify: `apps/desktop/src/i18n/locales/en.json`
- Modify: `apps/desktop/scripts/check-ui-contract.mjs`

- [ ] **Step 1: Aggiungere prima il contratto UI rosso**

```js
assertContains("src/components/Sidebar.tsx", "MemorySourcesDialog", "project menu must open memory sources separately from Project Access");
assertContains("src/components/MemorySourcesDialog.tsx", "Read only", "linked sources must state read-only access");
assertContains("src/components/MemorySourcesDialog.tsx", "coreBridge.upsertMemorySource", "memory source grants must persist through the typed bridge");
assertContains("src/components/MemorySourcesDialog.tsx", "coreBridge.revokeMemorySource", "memory sources must support immediate revocation");
assertNotContains("src/components/ProjectAccessDialog.tsx", "MemorySourcesDialog", "contact access must not own source grants");
```

- [ ] **Step 2: Verificare il rosso**

Run: `(cd apps/desktop && npm run test:ui-contract)`

Expected: FAIL perché dialog e wiring non esistono.

- [ ] **Step 3: Implementare il dialog a due livelli**

Il dialog carica `coreBridge.memorySources(workspace.id)` e mostra:

- card fissa della memoria locale;
- card delle grant con collections, sensitivity, scadenza e ultima consultazione;
- card disabilitata “Fonte non disponibile” per grant dangling, con sola azione di revoca;
- bottone “Collega una memoria”;
- form source → collections → advanced overrides → riepilogo → conferma;
- revoca con copy esplicita su cache, risposte passate e record pubblicati.

Lo stato minimo del form è:

```tsx
const [sourceWorkspaceId, setSourceWorkspaceId] = useState("__personal__");
const [collections, setCollections] = useState<MemoryCollectionKey[]>(["preferences"]);
const [maxSensitivity, setMaxSensitivity] = useState<MemorySourceGrantView["max_sensitivity"]>("private");
const [expiresAt, setExpiresAt] = useState<number | null>(null);
const [overrides, setOverrides] = useState<MemorySourceUpsertInput["overrides"]>([]);
```

Nessuna checkbox parte selezionata finché l'utente non sceglie una source. Dopo la scelta
di `__personal__`, la UI può proporre `preferences`, ma richiede comunque un click esplicito
prima del riepilogo; per gli altri progetti non preseleziona raccolte. Il riepilogo deve
precedere il salvataggio e dire chiaramente che l'accesso è in sola lettura. Il controllo
avanzato carica `coreBridge.memorySourceCandidates` e persiste solo ref/effect selezionati.

- [ ] **Step 4: Collegare Sidebar, copy e stili**

In `Sidebar.tsx` aggiungere stato `memorySourcesProject`, menu item separato da “Manage
access” e render del dialog. Usare icona `Database` o `Brain`, non `Shield`, per non
confondere i due perimetri.

Aggiungere chiavi `memorySources.*` in italiano e inglese. Gli stili possono condividere
layout base del project access dialog, ma devono avere classi `memory-sources-*` e token di
tema; nessun colore hardcoded bianco.

Copy minimo italiano:

```json
{
  "memorySources": {
    "title": "Fonti di memoria",
    "local": "Memoria del progetto",
    "localAccess": "Accesso completo · Sempre attiva",
    "empty": "Nessuna fonte collegata",
    "connect": "Collega una memoria",
    "readOnly": "Sola lettura",
    "review": "Rivedi autorizzazione",
    "revoke": "Revoca accesso",
    "revokeWarning": "I richiami futuri saranno bloccati subito. Le memorie già pubblicate resteranno nella destinazione."
  }
}
```

L'inglese usa le chiavi identiche con “Memory sources”, “Project memory”, “Read only”,
“Review access” e “Revoke access”.

- [ ] **Step 5: Verificare e commit**

Run: `(cd apps/desktop && npm run test:ui-contract && npm run typecheck && npm run build)`

Expected: PASS.

```bash
git add apps/desktop/src/components/MemorySourcesDialog.tsx apps/desktop/src/components/Sidebar.tsx apps/desktop/src/styles.css apps/desktop/src/i18n/locales/it.json apps/desktop/src/i18n/locales/en.json apps/desktop/scripts/check-ui-contract.mjs
git commit -m "feat(memory): add project memory sources UI"
```

## Task 10: Modello e transazione di pubblicazione

**Files:**
- Create: `crates/memory/src/publication.rs`
- Create: `crates/memory/tests/publication.rs`
- Modify: `crates/memory/src/lib.rs`
- Modify: `crates/memory/src/store.rs`
- Modify: `crates/memory/src/facade.rs`

- [ ] **Step 1: Scrivere test rossi approve/reject/rollback**

```rust
#[test]
fn approved_publication_creates_destination_and_marks_source_alias_atomically() {
    let fixture = PublicationFixture::new();
    let source = fixture.insert_source_preference("Prefers Italian");
    let proposal = fixture.facade.create_publication_proposal(
        &source,
        &fixture.personal_scope(),
        "owner",
    ).unwrap();
    let result = fixture.facade.approve_publication(&proposal.id, "owner").unwrap();
    assert_eq!(result.destination.workspace_id.as_str(), "__personal__");
    assert_eq!(result.destination.text, "Prefers Italian");
    let source_after = fixture.get(&source.reference, &fixture.project_scope());
    assert_eq!(source_after.metadata["published_alias"], true);
    assert_eq!(fixture.facade.get_publication_link(&source.reference).unwrap().unwrap().destination_ref, result.destination.reference);
}

#[test]
fn rejected_publication_does_not_modify_either_scope() {
    let fixture = PublicationFixture::new();
    let source = fixture.insert_source_preference("Prefers Italian");
    let proposal = fixture.facade.create_publication_proposal(&source, &fixture.personal_scope(), "owner").unwrap();
    fixture.facade.reject_publication(&proposal.id, "owner").unwrap();
    assert!(fixture.list_personal().is_empty());
    assert!(fixture.get(&source.reference, &fixture.project_scope()).metadata.get("published_alias").is_none());
}
```

- [ ] **Step 2: Verificare il rosso**

Run: `cargo test -p local-first-memory --test publication -- --nocapture`

Expected: FAIL perché il dominio publication non esiste.

- [ ] **Step 3: Definire tipi e schema**

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryPublicationStatus { Pending, Approved, Rejected, Failed }

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MemoryPublicationProposal {
    pub id: String,
    pub source_ref: MemoryRef,
    pub source_user_id: UserId,
    pub source_workspace_id: WorkspaceId,
    pub destination_user_id: UserId,
    pub destination_workspace_id: WorkspaceId,
    pub proposed_text: String,
    pub proposed_memory_type: String,
    pub proposed_privacy_domain: PrivacyDomain,
    pub proposed_sensitivity: DataSensitivity,
    pub duplicate_ref: Option<MemoryRef>,
    pub status: MemoryPublicationStatus,
    pub proposed_by: String,
    pub decided_by: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MemoryPublicationLink {
    pub source_ref: MemoryRef,
    pub destination_ref: MemoryRef,
    pub approved_by: String,
    pub created_at: String,
}
```

Aggiungere tabelle `memory_publication_proposals` e `memory_publication_links`; il payload
della proposta è locale e redatto prima della persistenza.

- [ ] **Step 4: Implementare approvazione transazionale**

Prima di aprire la transazione il facade:

1. ricarica proposal/source;
2. richiede `Pending` e stesso owner;
3. blocca `Secret` e `contains_secret`;
4. ricalcola duplicati nella destinazione.

Il record di destinazione creato da un'approvazione ha `MemoryStatus::Confirmed`, perché la
decisione dell'utente è già la conferma esplicita.

Lo store esegue con una sola `rusqlite::Transaction`:

```rust
pub fn commit_publication(
    &self,
    proposal: &MemoryPublicationProposal,
    destination: &MemoryRecord,
    source_with_alias: &MemoryRecord,
    link: &MemoryPublicationLink,
) -> Result<(), String> {
    let mut conn = self.write_conn();
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    upsert_memory_on(&tx, destination)?;
    upsert_memory_on(&tx, source_with_alias)?;
    tx.execute(
        "insert into memory_publication_links(source_ref, destination_ref, approved_by, created_at) values (?1, ?2, ?3, ?4)",
        (link.source_ref.to_string(), link.destination_ref.to_string(), &link.approved_by, &link.created_at),
    ).map_err(|error| error.to_string())?;
    tx.execute(
        "update memory_publication_proposals set status='approved', decided_by=?2, updated_at=?3 where id=?1 and status='pending'",
        (&proposal.id, link.approved_by.as_str(), link.created_at.as_str()),
    ).map_err(|error| error.to_string())?;
    tx.commit().map_err(|error| error.to_string())
}
```

Estrarre `upsert_memory_on(conn, memory)` dall'attuale `upsert_memory` per evitare lock
ricorsivi. In caso di duplicate compatibile, `destination` è l'update esplicito scelto;
in caso di conflitto, `approve_publication` restituisce `publication_conflict` finché
l'utente non seleziona create-new o update-existing nella proposta.

- [ ] **Step 5: Verificare e commit**

Run: `cargo test -p local-first-memory --test publication -- --nocapture && cargo test -p local-first-memory -- --nocapture`

Expected: PASS, compreso un test con errore forzato prima del commit che lascia zero link e zero alias.

```bash
git add crates/memory/src/publication.rs crates/memory/src/lib.rs crates/memory/src/store.rs crates/memory/src/facade.rs crates/memory/tests/publication.rs
git commit -m "feat(memory): add approved memory publication"
```

## Task 11: API e dialog di approvazione della pubblicazione

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs`
- Modify: `apps/desktop/src/lib/coreBridge.ts`
- Create: `apps/desktop/src/components/MemoryPublicationDialog.tsx`
- Modify: `apps/desktop/src/components/MemoryUsagePopover.tsx`
- Modify: `apps/desktop/src/styles.css`
- Modify: `apps/desktop/src/i18n/locales/it.json`
- Modify: `apps/desktop/src/i18n/locales/en.json`
- Modify: `apps/desktop/scripts/check-ui-contract.mjs`

- [ ] **Step 1: Aggiungere contratto UI rosso e test gateway**

```js
assertContains("src/components/MemoryPublicationDialog.tsx", "proposed_text", "publication must preview exact text before approval");
assertContains("src/components/MemoryPublicationDialog.tsx", "coreBridge.approveMemoryPublication", "publication must require explicit approval");
assertContains("src/components/MemoryPublicationDialog.tsx", "coreBridge.rejectMemoryPublication", "publication must support rejection without writes");
```

Nel gateway testare che una proposta `Secret` restituisca `secret_never_shareable` e che
un approvatore diverso dall'owner restituisca `publication_actor_mismatch`.

- [ ] **Step 2: Verificare il rosso**

Run: `cargo test -p local-first-desktop-gateway memory_publication_ -- --nocapture && (cd apps/desktop && npm run test:ui-contract)`

Expected: FAIL.

- [ ] **Step 3: Esporre route e bridge**

Route:

```rust
.route("/api/memory/publications", post(memory_publication_create))
.route("/api/memory/publications/{proposal_id}", get(memory_publication_get))
.route("/api/memory/publications/{proposal_id}/approve", post(memory_publication_approve))
.route("/api/memory/publications/{proposal_id}/reject", post(memory_publication_reject))
```

Il create accetta source ref, source workspace e destination workspace; testo/tipo/domain/
sensitivity arrivano dal record server-side e possono essere modificati solo tramite una
request `MemoryPublicationEditInput` validata e redatta.

Il bridge espone `createMemoryPublication`, `memoryPublication`,
`approveMemoryPublication` e `rejectMemoryPublication` con tipi derivati dal contratto Rust.

- [ ] **Step 4: Implementare anteprima e azione dal pannello memoria**

Nel `MemoryUsagePopover`, per memorie locali aggiungere “Pubblica…”; il dialog mostra:

- testo modificabile;
- tipo/raccolta;
- destinazione;
- sensibilità;
- duplicate/conflict card;
- conseguenza: destinazione canonica, source alias, nessuna sincronizzazione.

Il bottone approva resta disabilitato finché l'utente non seleziona la destinazione e non
conferma la checkbox:

```tsx
<label className="memory-publication-confirm">
  <input
    type="checkbox"
    checked={confirmed}
    onChange={(event) => setConfirmed(event.target.checked)}
  />
  <span>{t("memoryPublication.canonicalConfirmation")}</span>
</label>
```

Copy minimo italiano:

```json
{
  "memoryPublication": {
    "title": "Pubblica in un'altra memoria",
    "destination": "Destinazione",
    "duplicate": "Esiste già una memoria simile",
    "conflict": "La destinazione contiene una versione incompatibile",
    "canonicalConfirmation": "Confermo che la memoria destinataria diventerà la versione canonica e che non verrà sincronizzata automaticamente.",
    "approve": "Pubblica memoria",
    "reject": "Annulla proposta"
  }
}
```

Dopo successo, chiudere il dialog e ricaricare il pannello; dopo reject, nessuna mutation
di memoria deve essere riflessa localmente.

- [ ] **Step 5: Verificare e commit**

Run: `cargo test -p local-first-desktop-gateway memory_publication_ -- --nocapture && (cd apps/desktop && npm run test:ui-contract && npm run build)`

Expected: PASS.

```bash
git add crates/desktop-gateway/src/main.rs apps/desktop/src/lib/coreBridge.ts apps/desktop/src/components/MemoryPublicationDialog.tsx apps/desktop/src/components/MemoryUsagePopover.tsx apps/desktop/src/styles.css apps/desktop/src/i18n/locales/it.json apps/desktop/src/i18n/locales/en.json apps/desktop/scripts/check-ui-contract.mjs
git commit -m "feat(memory): add publication approval UI"
```

## Task 12: Migrazione controllata, documentazione e prova end-to-end

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs`
- Modify: `docs/architecture/memory.md`
- Modify: `docs/MEMORIA.md`
- Modify: `docs/DEVELOPMENT.md`
- Modify: `docs/roadmap.md`

- [ ] **Step 1: Scrivere test del flag e della migrazione comportamentale**

```rust
#[test]
fn memory_sources_flag_defaults_off_until_live_gate() {
    assert!(!super::memory_sources_flag(None));
    assert!(super::memory_sources_flag(Some("on")));
    assert!(!super::memory_sources_flag(Some("off")));
}

#[test]
fn no_grants_are_created_for_existing_projects() {
    let facade = MemoryFacade::new(SQLiteMemoryStore::open_in_memory().unwrap());
    let grants = facade.list_memory_source_grants(&UserId::new("owner"), &WorkspaceId::new("legacy-project")).unwrap();
    assert!(grants.is_empty());
}
```

- [ ] **Step 2: Eseguire tutti i gate automatici con flag off**

Run:

```bash
cargo test -p local-first-memory -- --nocapture
cargo test -p local-first-engine -- --nocapture
cargo test -p local-first-task-runtime -- --nocapture
cargo test -p local-first-desktop-gateway -- --nocapture
cd apps/desktop && npm run test:ui-contract && npm run test:electron && npm run build
```

Expected: tutti PASS; senza flag il runtime continua a usare solo lo scope locale.

- [ ] **Step 3: Eseguire smoke reale con flag on**

Avviare il desktop gateway e l'app con `HOMUN_MEMORY_SOURCES=on`. Preparare tre scope nello
stesso DB:

1. Personale: preferenza “Rispondi in italiano” e fatto privato non autorizzato.
2. Progetto A: decisione “Lancio a settembre”.
3. Progetto B: decisione “Lancio a giugno” e grant da A alle sole decisioni di B.

Verificare dalla UI:

- A senza grant personale non riceve la preferenza;
- grant `preferences` fa comparire solo la preferenza;
- il fatto personale non appare in candidati, prompt, evento o popover;
- A vede la decisione di B con source B e mantiene settembre come precedenza locale;
- revocare entrambe le grant elimina gli hit nel turno immediatamente successivo;
- un contatto con `can_use_project_memory=false` non vede né memoria locale né fonti collegate;
- eliminare temporaneamente la source B mostra la grant come non disponibile senza fallback;
- pubblicare una preferenza da A a Personale crea il canonico e l'alias, senza sync;
- riavvio app conserva grant, revoca, audit e publication link.

Salvare una trace redatta del test in un file temporaneo fuori dal repository; non
committare contenuti di memoria reali.

- [ ] **Step 4: Flip default-on con escape hatch e aggiornare documenti**

Solo dopo smoke verde, sostituire il parser del flag con:

```rust
fn memory_sources_flag(value: Option<&str>) -> bool {
    !matches!(value.map(str::trim), Some("0") | Some("off") | Some("OFF") | Some("Off"))
}
```

Aggiornare nello stesso commit il test del flag:

```rust
#[test]
fn memory_sources_flag_defaults_on_after_live_gate() {
    assert!(super::memory_sources_flag(None));
    assert!(super::memory_sources_flag(Some("on")));
    assert!(!super::memory_sources_flag(Some("off")));
}
```

Aggiornare i documenti con:

- stato schema v4 e nuove tabelle;
- personal preferences ora grant-aware nei progetti;
- `HOMUN_MEMORY_SOURCES=off` come escape hatch;
- separazione da Project Access;
- provenienza UI, revoca e publishing;
- risultato e data dello smoke reale;
- roadmap slice completata soltanto se il runtime installabile è stato verificato.

- [ ] **Step 5: Eseguire pre-release gate e commit finale**

Run: `python3 scripts/pre_release_gate.py`

Expected: `ALL GREEN`.

Run: `git status --short`

Expected: solo i file documentali/flag intenzionali della task; nessun artefatto, trace,
database o `homun-tablet-full.png` staged.

```bash
git add crates/desktop-gateway/src/main.rs docs/architecture/memory.md docs/MEMORIA.md docs/DEVELOPMENT.md docs/roadmap.md
git commit -m "feat(memory): enable authorized project memory sources"
```

## Definition of Done

- Nessun progetto vede memoria personale o di altri progetti senza grant attiva.
- `scope_mismatch` resta operativo e testato.
- `Secret`, Vault payload, sensibilità sopra il limite e deny individuali non entrano
  nell'indice autorizzato, nel prompt, nell'evento stream o nell'audit.
- Nessun accesso transitivo.
- Service ON/OFF condividono lo stesso coordinatore quando la feature è attiva.
- Revoca/scadenza invalidano cache e briefing prima del turno successivo.
- Ogni hit usato ha provenance completa e visibile nella UI.
- Project Access restringe ma non amplia le fonti del progetto.
- Pubblicazione crea una destinazione canonica soltanto dopo approvazione e usa una
  transazione senza scritture parziali.
- Test Rust, UI contract, Electron tests, build e pre-release gate sono verdi.
- Documentazione durevole aggiornata e nessun push/deploy eseguito senza richiesta.
