use crate::{AgentId, SubagentResult};
use local_first_memory::{
    MemoryExtraction, MemoryExtractionSummary, MemoryFacade, RoutineInference,
    RoutineInferenceSummary, UserId, WorkspaceId,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MemoryAgentImport {
    pub memory_extraction: Option<MemoryExtraction>,
    pub routine_inference: Option<RoutineInference>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryAgentImportSummary {
    pub memories_imported: usize,
    pub entities_imported: usize,
    pub relations_imported: usize,
    pub routines_imported: usize,
}

pub struct MemoryAgentImporter<'a> {
    facade: &'a MemoryFacade,
}

impl<'a> MemoryAgentImporter<'a> {
    pub fn new(facade: &'a MemoryFacade) -> Self {
        Self { facade }
    }

    pub fn import_result(
        &self,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
        result: &SubagentResult,
    ) -> Result<MemoryAgentImportSummary, String> {
        if result.agent_id != AgentId::Memory {
            return Err("only MemoryAgent results can be imported into memory".to_string());
        }
        let payload: MemoryAgentImport =
            serde_json::from_value(result.output.clone()).map_err(|error| error.to_string())?;
        let memory_summary = match payload.memory_extraction {
            Some(extraction) => self
                .facade
                .apply_extraction(user_id, workspace_id, extraction)
                .map_err(String::from)?,
            None => empty_memory_summary(),
        };
        let routine_summary = match payload.routine_inference {
            Some(inference) => self
                .facade
                .apply_routine_inference(user_id, workspace_id, inference)
                .map_err(String::from)?,
            None => empty_routine_summary(),
        };
        Ok(MemoryAgentImportSummary {
            memories_imported: memory_summary.memories_imported,
            entities_imported: memory_summary.entities_imported,
            relations_imported: memory_summary.relations_imported,
            routines_imported: routine_summary.routines_imported,
        })
    }
}

fn empty_memory_summary() -> MemoryExtractionSummary {
    MemoryExtractionSummary {
        memories_imported: 0,
        entities_imported: 0,
        relations_imported: 0,
        evidence_links_imported: 0,
        memory_refs: vec![],
        entity_refs: vec![],
        relation_refs: vec![],
    }
}

fn empty_routine_summary() -> RoutineInferenceSummary {
    RoutineInferenceSummary {
        routines_imported: 0,
        routine_refs: vec![],
    }
}
