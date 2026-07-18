use crate::{MemoryRecord, MemoryRef, MemoryRefKind, MemoryStatus};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashSet;

pub const MEMORY_EVOLUTION_METADATA_KEY: &str = "evolution";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryEvolutionKind {
    Independent,
    Duplicate,
    Updates,
    Extends,
    Derives,
    Conflict,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MemoryEvolutionMetadata {
    pub kind: MemoryEvolutionKind,
    #[serde(default)]
    pub target_refs: Vec<MemoryRef>,
    #[serde(default)]
    pub valid_from: Option<i64>,
    #[serde(default)]
    pub valid_until: Option<i64>,
    #[serde(default)]
    pub last_confirmed_at: Option<i64>,
    #[serde(default = "default_reinforcement_count")]
    pub reinforcement_count: u64,
    #[serde(default)]
    pub classifier: String,
    #[serde(default)]
    pub classifier_confidence: f64,
}

fn default_reinforcement_count() -> u64 {
    1
}

#[derive(Debug, Clone, PartialEq)]
pub struct MemoryEvolutionProposal {
    pub request_id: String,
    pub record: MemoryRecord,
    pub evolution: MemoryEvolutionMetadata,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MemoryEvolutionResult {
    pub record: MemoryRecord,
    pub kind: MemoryEvolutionKind,
    pub affected_refs: Vec<MemoryRef>,
    pub created: bool,
}

pub fn validate_memory_evolution_metadata(
    evolution: &MemoryEvolutionMetadata,
) -> Result<(), String> {
    if evolution.reinforcement_count == 0 {
        return Err("memory evolution reinforcement_count must be positive".to_string());
    }
    if !evolution.classifier_confidence.is_finite()
        || !(0.0..=1.0).contains(&evolution.classifier_confidence)
    {
        return Err(
            "memory evolution classifier_confidence must be between zero and one".to_string(),
        );
    }
    if let (Some(valid_from), Some(valid_until)) = (evolution.valid_from, evolution.valid_until) {
        if valid_until <= valid_from {
            return Err("memory evolution valid_until must be later than valid_from".to_string());
        }
    }
    let mut unique = HashSet::new();
    if evolution
        .target_refs
        .iter()
        .any(|reference| reference.kind != MemoryRefKind::Memory || !unique.insert(reference))
    {
        return Err("memory evolution target refs must be unique memory refs".to_string());
    }
    match evolution.kind {
        MemoryEvolutionKind::Independent if !evolution.target_refs.is_empty() => {
            return Err("independent memory evolution cannot declare targets".to_string());
        }
        MemoryEvolutionKind::Independent => {}
        _ if evolution.target_refs.is_empty() => {
            return Err("memory evolution kind requires at least one target".to_string());
        }
        _ => {}
    }
    Ok(())
}

pub fn write_memory_evolution_metadata(
    metadata: &mut Value,
    evolution: &MemoryEvolutionMetadata,
) -> Result<(), String> {
    validate_memory_evolution_metadata(evolution)?;
    if !metadata.is_object() {
        *metadata = json!({});
    }
    metadata[MEMORY_EVOLUTION_METADATA_KEY] =
        serde_json::to_value(evolution).map_err(|error| error.to_string())?;
    Ok(())
}

pub fn memory_evolution_metadata(
    metadata: &Value,
) -> Result<Option<MemoryEvolutionMetadata>, String> {
    let Some(value) = metadata.get(MEMORY_EVOLUTION_METADATA_KEY) else {
        return Ok(None);
    };
    let evolution = serde_json::from_value(value.clone()).map_err(|error| error.to_string())?;
    validate_memory_evolution_metadata(&evolution)?;
    Ok(Some(evolution))
}

pub fn memory_is_current_at(record: &MemoryRecord, now_unix: i64, allow_candidate: bool) -> bool {
    let active_status = record.status == MemoryStatus::Confirmed
        || (allow_candidate && record.status == MemoryStatus::Candidate);
    if !active_status || record.superseded_by.is_some() {
        return false;
    }
    match memory_evolution_metadata(&record.metadata) {
        Ok(Some(evolution)) => evolution
            .valid_until
            .is_none_or(|valid_until| valid_until > now_unix),
        Ok(None) => true,
        Err(_) => false,
    }
}

pub fn prepare_memory_evolution_record(
    proposal: &MemoryEvolutionProposal,
    targets: &[MemoryRecord],
) -> Result<MemoryRecord, String> {
    if proposal.request_id.trim().is_empty() {
        return Err("memory evolution request id cannot be empty".to_string());
    }
    if proposal.record.reference.kind != MemoryRefKind::Memory {
        return Err("memory evolution record must use a memory ref".to_string());
    }
    validate_memory_evolution_metadata(&proposal.evolution)?;

    let target_by_ref = targets
        .iter()
        .map(|target| (&target.reference, target))
        .collect::<std::collections::HashMap<_, _>>();
    for reference in &proposal.evolution.target_refs {
        let target = target_by_ref
            .get(reference)
            .ok_or_else(|| "memory evolution target is unavailable".to_string())?;
        if target.user_id != proposal.record.user_id
            || target.workspace_id != proposal.record.workspace_id
            || reference.user_id != proposal.record.user_id
            || reference.workspace_id != proposal.record.workspace_id
        {
            return Err("memory evolution target is outside the record scope".to_string());
        }
        if !matches!(
            target.status,
            MemoryStatus::Candidate | MemoryStatus::Confirmed
        ) || target.superseded_by.is_some()
        {
            return Err("memory evolution target is not active".to_string());
        }
    }

    let mut record = proposal.record.clone();
    write_memory_evolution_metadata(&mut record.metadata, &proposal.evolution)?;
    if proposal.evolution.kind == MemoryEvolutionKind::Derives {
        record.status = MemoryStatus::Candidate;
    }
    if proposal.evolution.kind == MemoryEvolutionKind::Updates {
        record.supersedes = proposal.evolution.target_refs.clone();
    }
    Ok(record)
}
