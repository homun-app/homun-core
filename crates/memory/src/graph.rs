use crate::{MemoryEntity, MemoryRef, MemoryRelation, SQLiteMemoryStore, UserId, WorkspaceId};

pub struct GraphMemory<'a> {
    store: &'a SQLiteMemoryStore,
}

impl<'a> GraphMemory<'a> {
    pub fn new(store: &'a SQLiteMemoryStore) -> Self {
        Self { store }
    }

    pub fn upsert_node(&self, entity: &MemoryEntity) -> Result<(), String> {
        self.store.upsert_entity(entity)
    }

    pub fn link(&self, relation: &MemoryRelation) -> Result<(), String> {
        self.store.upsert_relation(relation)
    }

    pub fn relations_from(
        &self,
        source_ref: &MemoryRef,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> Result<Vec<MemoryRelation>, String> {
        self.store.relations_for(source_ref, user_id, workspace_id)
    }
}
