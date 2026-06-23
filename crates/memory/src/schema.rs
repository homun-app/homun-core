//! Universal memory schema: the shared vocabulary that write (extraction), read
//! (retrieval/graph) and UI all agree on, plus the first-class `Decision` shape
//! (the "why").
//!
//! Design: this is a TYPED LAYER over the generic primitives (`MemoryRecord`,
//! `MemoryEntity`, `MemoryRelation`) — it does NOT replace them. A decision is a
//! `MemoryRecord` with `memory_type = "decision"` whose `metadata` carries a
//! structured `DecisionDetails` (rationale + rejected alternatives + objective +
//! affected artifacts); supersession reuses `MemoryRecord.supersedes /
//! superseded_by`; graph edges reuse `MemoryRelation`. The point is to make the
//! "why" structured and queryable instead of free-floating in untyped JSON.

use crate::MemoryRef;
use crate::WorkspaceId;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// Reserved workspace id for the PERSONAL (global, cross-project) scope. Personal
/// memory is private and local; it is never bound to a single project.
pub const PERSONAL_WORKSPACE: &str = "__personal__";

/// Metadata key under which a record's `DecisionDetails` is stored, so other
/// metadata (source, thread_id, …) can coexist on the same record.
pub const DECISION_METADATA_KEY: &str = "decision";

/// Where a piece of memory lives. Resolves to the crate's `(user, workspace)`
/// scoping; the THREAD dimension is carried alongside the project workspace.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MemoryScope {
    /// Cross-project, private, durable knowledge (preferences, facts about you).
    Personal,
    /// Bound to a specific project/workspace.
    Project(WorkspaceId),
    /// Episodic memory of one conversation, kept under its project workspace.
    Thread { project: WorkspaceId, thread_id: String },
}

impl MemoryScope {
    /// The workspace id this scope maps onto (personal → the reserved workspace).
    pub fn workspace_id(&self) -> WorkspaceId {
        match self {
            MemoryScope::Personal => WorkspaceId::new(PERSONAL_WORKSPACE),
            MemoryScope::Project(workspace) => workspace.clone(),
            MemoryScope::Thread { project, .. } => project.clone(),
        }
    }

    /// True when this is the cross-project personal scope.
    pub fn is_personal(&self) -> bool {
        matches!(self, MemoryScope::Personal)
    }

    /// The thread id when this is a thread (episodic) scope.
    pub fn thread_id(&self) -> Option<&str> {
        match self {
            MemoryScope::Thread { thread_id, .. } => Some(thread_id.as_str()),
            _ => None,
        }
    }
}

/// `memory_type` vocabulary for `MemoryRecord` — the knowledge nodes that carry text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryKind {
    /// A choice + its rationale (the "why"). Structured via `DecisionDetails`.
    Decision,
    /// A goal being pursued (can be hierarchical via `metadata.parent_ref`).
    Objective,
    /// A durable fact (about the user, a person, a project…).
    Fact,
    /// A stable preference (how you like to work).
    Preference,
    /// Free-form note.
    Note,
}

/// `entity_type` vocabulary for `MemoryEntity` — the "things" the graph connects.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EntityKind {
    Person,
    Organization,
    Project,
    Tool,
    // Software lens
    File,
    Function,
    Class,
    Module,
    Test,
    // Generic lens
    Document,
    Asset,
}

/// `relation_type` vocabulary for `MemoryRelation` — the typed graph edges.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RelationKind {
    // Decision edges
    DecidedFor,   // decision -> objective
    Affects,      // decision -> artifact
    InformedBy,   // decision -> evidence
    AlternativeTo,
    Supersedes,   // mirrors MemoryRecord.supersedes for graph traversal
    RationaleFor, // rationale/evidence -> decision/objective
    Produced,     // tool/workflow/step -> artifact/outcome
    DerivedFrom,  // artifact/outcome -> source artifact/file/step
    // Software edges
    Calls,
    Imports,
    DependsOn,
    Implements,
    TestedBy,
    Fixes,
    // People / kinship
    PartnerOf,
    ChildOf,
    ParentOf,
    SiblingOf,
    WorksAs,
    // Generic
    RelatesTo,
    BelongsToProject,
    Mentions,
}

macro_rules! tag_enum {
    ($ty:ty { $($variant:ident => $tag:literal),+ $(,)? }) => {
        impl $ty {
            /// The canonical string tag stored in the DB.
            pub fn as_str(&self) -> &'static str {
                match self { $(<$ty>::$variant => $tag,)+ }
            }
            /// Parse a stored tag back to the typed kind (None if unknown).
            pub fn from_tag(tag: &str) -> Option<Self> {
                match tag { $($tag => Some(<$ty>::$variant),)+ _ => None }
            }
        }
    };
}

tag_enum!(MemoryKind {
    Decision => "decision",
    Objective => "objective",
    Fact => "fact",
    Preference => "preference",
    Note => "note",
});

tag_enum!(EntityKind {
    Person => "person",
    Organization => "organization",
    Project => "project",
    Tool => "tool",
    File => "file",
    Function => "function",
    Class => "class",
    Module => "module",
    Test => "test",
    Document => "document",
    Asset => "asset",
});

tag_enum!(RelationKind {
    DecidedFor => "decided_for",
    Affects => "affects",
    InformedBy => "informed_by",
    AlternativeTo => "alternative_to",
    Supersedes => "supersedes",
    RationaleFor => "rationale_for",
    Produced => "produced",
    DerivedFrom => "derived_from",
    Calls => "calls",
    Imports => "imports",
    DependsOn => "depends_on",
    Implements => "implements",
    TestedBy => "tested_by",
    Fixes => "fixes",
    PartnerOf => "partner_of",
    ChildOf => "child_of",
    ParentOf => "parent_of",
    SiblingOf => "sibling_of",
    WorksAs => "works_as",
    RelatesTo => "relates_to",
    BelongsToProject => "belongs_to_project",
    Mentions => "mentions",
});

/// One rejected alternative of a decision and WHY it was rejected — the part no
/// existing tool keeps, and the highest-value piece for not repeating mistakes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Alternative {
    pub option: String,
    pub rejected_because: String,
}

/// The structured "why" of a decision, stored in `MemoryRecord.metadata` under
/// [`DECISION_METADATA_KEY`]. The record's `text` stays the short human summary;
/// supersession stays on `MemoryRecord.supersedes / superseded_by`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct DecisionDetails {
    /// Why this was chosen.
    pub rationale: String,
    /// Alternatives considered and why each was rejected.
    #[serde(default)]
    pub alternatives: Vec<Alternative>,
    /// The objective this decision serves.
    #[serde(default)]
    pub objective_ref: Option<MemoryRef>,
    /// The artifacts (files/functions/assets) this decision affects.
    #[serde(default)]
    pub affects: Vec<MemoryRef>,
}

impl DecisionDetails {
    /// Serialize just the decision payload (for embedding under the metadata key).
    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }

    /// Read decision details back out of a record's full `metadata` object.
    pub fn from_record_metadata(metadata: &Value) -> Option<Self> {
        metadata
            .get(DECISION_METADATA_KEY)
            .and_then(|value| serde_json::from_value(value.clone()).ok())
    }

    /// Write/overwrite the decision payload into a record's `metadata`, preserving
    /// any other keys already present (source, thread_id, …).
    pub fn write_into(&self, metadata: &mut Value) {
        if !metadata.is_object() {
            *metadata = json!({});
        }
        metadata[DECISION_METADATA_KEY] = self.to_value();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{MemoryRefKind, UserId};

    fn sample_ref(key: &str) -> MemoryRef {
        MemoryRef::new(
            MemoryRefKind::Entity,
            UserId::new("u"),
            WorkspaceId::new("w"),
            key,
        )
    }

    #[test]
    fn personal_scope_maps_to_reserved_workspace() {
        assert_eq!(MemoryScope::Personal.workspace_id().as_str(), PERSONAL_WORKSPACE);
        assert!(MemoryScope::Personal.is_personal());
        let project = MemoryScope::Project(WorkspaceId::new("acme"));
        assert_eq!(project.workspace_id().as_str(), "acme");
        assert!(!project.is_personal());
    }

    #[test]
    fn thread_scope_keeps_project_workspace_and_thread_id() {
        let scope = MemoryScope::Thread {
            project: WorkspaceId::new("acme"),
            thread_id: "t-1".to_string(),
        };
        assert_eq!(scope.workspace_id().as_str(), "acme");
        assert_eq!(scope.thread_id(), Some("t-1"));
    }

    #[test]
    fn kind_tags_round_trip() {
        for kind in [
            MemoryKind::Decision,
            MemoryKind::Objective,
            MemoryKind::Fact,
            MemoryKind::Preference,
            MemoryKind::Note,
        ] {
            assert_eq!(MemoryKind::from_tag(kind.as_str()), Some(kind));
        }
        assert_eq!(EntityKind::from_tag("function"), Some(EntityKind::Function));
        assert_eq!(RelationKind::from_tag("decided_for"), Some(RelationKind::DecidedFor));
        assert_eq!(RelationKind::from_tag("rationale_for"), Some(RelationKind::RationaleFor));
        assert_eq!(RelationKind::from_tag("produced"), Some(RelationKind::Produced));
        assert_eq!(RelationKind::from_tag("derived_from"), Some(RelationKind::DerivedFrom));
        assert_eq!(RelationKind::from_tag("nope"), None);
    }

    #[test]
    fn decision_details_round_trip_through_record_metadata() {
        let details = DecisionDetails {
            rationale: "Webhook push avoids polling latency and rate limits.".to_string(),
            alternatives: vec![Alternative {
                option: "Polling the API".to_string(),
                rejected_because: "Adds latency and burns rate limits.".to_string(),
            }],
            objective_ref: Some(sample_ref("obj-billing")),
            affects: vec![sample_ref("file-invoices")],
        };

        // Coexists with unrelated metadata keys.
        let mut metadata = json!({ "source": "desktop_chat", "thread_id": "t-7" });
        details.write_into(&mut metadata);

        assert_eq!(metadata["source"], json!("desktop_chat"));
        let parsed = DecisionDetails::from_record_metadata(&metadata).expect("decision present");
        assert_eq!(parsed, details);
    }

    #[test]
    fn decision_details_absent_returns_none() {
        let metadata = json!({ "source": "x" });
        assert_eq!(DecisionDetails::from_record_metadata(&metadata), None);
    }
}
