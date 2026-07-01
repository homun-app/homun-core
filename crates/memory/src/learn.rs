//! ADR 0022 (Tappa 4) — apprendimento post-turno (learn), spostato dal gateway
//! monolite nel crate memoria.
//!
//! Estrae fatti/preferenze/decisioni/open-loops + grafo (entità/relazioni) da
//! uno scambio utente↔assistente, via LLM estrattore (`LlmClient`), e li persiste
//! nello scope corretto (personal vs project). Il prompt estrattore è spostato
//! fedelmente (byte-per-byte) dal gateway; il parsing JSON item-by-item è
//! resiliente come nell'originale.
//!
//! I dati gateway-only (nome del progetto corrente, per il prompt) sono passati
//! come argomento dal chiamante — il crate non legge il filesystem del gateway.

use crate::{
    BoxFuture, ExtractedEntity, ExtractedMemory, ExtractedRelation, MemoryExtraction, MemoryFacade,
    MemoryStatus, PERSONAL_WORKSPACE, PrivacyDomain, UserId, WorkspaceId,
    recall::{cosine, dedup_tokens, jaccard, DEDUP_JACCARD},
};

/// Etichetta di "record open-loop attivo", spostata fedelmente dal gateway
/// (`active_open_loop_record`). Usata per leggere gli open-loop noti (per il
/// prompt di closure) e per il routing.
pub fn active_open_loop_record(m: &crate::MemoryRecord) -> bool {
    m.memory_type == "open_loop"
        && matches!(
            m.status,
            MemoryStatus::Confirmed | MemoryStatus::Candidate
        )
}

/// Sostituisce i valori default mancanti in un item estratto. Spostato fedelmente
/// dal gateway (`fill_extraction_defaults`).
pub fn fill_extraction_defaults(item: &serde_json::Value) -> serde_json::Value {
    let mut value = item.clone();
    if value.get("confidence").and_then(|c| c.as_f64()).is_none() {
        value["confidence"] = serde_json::json!(0.5);
    }
    if value.get("privacy_domain").and_then(|s| s.as_str()).is_none() {
        value["privacy_domain"] = serde_json::json!("personal");
    }
    value
}

/// Rimuove i fences ```json ... ``` dal content del modello. Spostato fedelmente
/// dal gateway (`strip_json_fences`).
pub fn strip_json_fences(content: &str) -> &str {
    let trimmed = content.trim();
    if let Some(rest) = trimmed.strip_prefix("```json") {
        rest.trim_end_matches("```").trim()
    } else if let Some(rest) = trimmed.strip_prefix("```") {
        rest.trim_end_matches("```").trim()
    } else {
        trimmed
    }
}

/// Prompt di sistema base dell'estrattore memoria. Spostato fedelmente (byte-per-
/// byte) dal gateway (`learn_from_exchange`, `base_system`). NON modificarlo: è
/// sintonizzato sull'output del modello estrattore.
pub const EXTRACTOR_BASE_SYSTEM: &str = "You are a MEMORY extractor. From the last exchange extract DURABLE and REUSABLE \
knowledge: (1) facts and preferences about the USER (who they are, people in their life, how they \
prefer to work); (2) DECISIONS made during the work (technical or project choices) with the WHY \
and the rejected alternatives; (3) OPEN LOOPS — work left INCOMPLETE: an \"open_loop\" must describe \
the FULL situation (what is DONE, what is MISSING or does NOT exist yet, what BLOCKS it and WHY), so a \
fresh chat reconstructs the REAL state, not a cleaned subset (memory_type \"open_loop\"; ONLY for \
genuinely unfinished work, NEVER for done items); (4) SALIENT STATE & FINDINGS — INCLUDING NEGATIVES: \
what does NOT exist yet, was NOT found, or is blocked/missing (e.g. \"the Rossi quote is only a verbal \
draft, no file yet\"; \"the report file was not found\"). These ARE durable state — capture them (as a \
\"fact\" or folded into the open_loop), capturing the CONCLUSION/state, NOT the assistant's search \
process or its mistakes. Do NOT extract the transient chatter of the task, NOT general world facts, \
NOT the assistant's pure conversational replies. \
EPISTEMIC STATE — DISTINGUISH what is TRUE/HAPPENED/DECIDED from what is only ASKED, SEARCHED, \
HYPOTHETICAL or UNDER EVALUATION. A question, a price/options search, an \"if/maybe/I'm \
considering\" are NOT facts about the user's life: do NOT register them as accomplished (e.g. if the \
user ASKS for ferry prices, do NOT write \"has a planned trip\"). Register a plan/event as a fact \
ONLY if the user states it as real/confirmed (\"I booked\", \"I'm leaving\", \"my trip is\"). If an \
evaluation is still useful, phrase it cautiously (\"searched/considered …\"), low confidence, and \
set metadata.certainty: \"committed\" = confirmed/happened, \"considered\" = only searched/evaluated, \
\"intended\" = declared intention but not confirmed. \
CONFIRMATIONS/CORRECTIONS: if above there is an \"ASSISTANT (previous turn…)\" block, the user is \
REPLYING to what the assistant had hypothesized or asked. If they CONFIRM (\"yes\", \"exactly\", \
\"confirmed\") or CORRECT (\"no, it's a V9\"), that fact becomes REAL: register it as committed with \
high confidence (>=0.85), using the CORRECTED version if the user corrected. Confirmation turns a \
hypothesis into an acquired fact (e.g. assistant \"is your motorbike a Moto Guzzi V7 Stone?\" + user \
\"yes\" → committed fact \"The user owns a Moto Guzzi V7 Stone\"). \
FIDELITY (no hallucinations): register ONLY what is explicit in the exchange; do NOT deduce or \
embellish undeclared roles, transactions or relations — e.g. from \"I looked at an ad for a \
motorcycle accessory\" do NOT deduce \"is selling their motorbike\" nor \"X is interested in buying \
it\". If a role/relation/transaction is not stated in clear terms, do not write it. \
DO NOT REGISTER (it is noise, not durable memory): recurring tasks or reminders and schedules the \
user sets (they live in the task system, not in memory); service connections/integrations (e.g. \
\"Gmail connected\", \"connected X\"); operational or build details (installed libraries/dependencies, \
commands, file names) unless they are a real project DECISION with a why; and NEVER register as a \
memory a request to FORGET/delete something. Do not save as project memory facts that concern \
ANOTHER project or tool unrelated to the current work. \
Reply with valid JSON ONLY, \
nothing else:\n\
{\"memories\":[{\"memory_type\":\"fact|preference|decision|goal|open_loop\",\"text\":\"short sentence in 3rd person \
in the user's language\",\"sensitivity\":\"internal|private|confidential|secret\",\"confidence\":0.0-1.0,\
\"metadata\":{\"scope\":\"personal|project\",\"certainty\":\"committed|considered|intended\",\"decision\":{\"rationale\":\"the why\",\
\"alternatives\":[{\"option\":\"alternative\",\"rejected_because\":\"reason\"}]}}}],\
\"entities\":[{\"entity_type\":\"person|organization|place|event|project|tool|object|topic\",\"name\":\"Name\",\
\"canonical_key\":\"person:normalized-name\",\"aliases\":[\"short form\"],\
\"sensitivity\":\"internal|private\",\"privacy_domain\":\"personal\",\"metadata\":{\"scope\":\"personal|project\"}}],\
\"relations\":[{\"source_ref\":\"person:fabio\",\"relation_type\":\"child_of|parent_of|partner_of|sibling_of|works_as|possiede|relates_to\",\
\"target_ref\":\"person:sara\",\"sensitivity\":\"internal\",\"privacy_domain\":\"personal\"}],\
\"episode\":\"one-sentence summary of what was discussed or decided in this exchange\"}\n\
RULES: scope \"personal\" = applies everywhere (preferences, people, personal data); scope \"project\" \
= specific to the current project/work (technical decisions, files, choices). For memory_type \
\"decision\" metadata.decision is MANDATORY (rationale, and alternatives if cited) and the scope is \
usually \"project\". memory_type \"goal\" = an OBJECTIVE or DIRECTION of the project. If the user \
uses words like \"objective\", \"milestone\", \"we want it to\", \"it must stay/become\", \"the goal \
is\" referring to the project as a whole, emit memory_type=\"goal\" (scope \"project\") and NOT \
\"decision\". Clear difference: decision = a TECHNICAL choice already made with a why (e.g. \"chose \
JSON for persistence because human-readable\"); goal = the DIRECTION to keep (e.g. \"taskline must \
stay minimal, stdlib only, zero dependencies\" → goal, NOT decision). When in doubt between goal and \
decision for an EXPLICIT declared objective, choose goal. ENTITIES = the things cited, WELL TYPED: \
person = people; organization = companies, services, institutions (Trenitalia, Gmail, a bank); place \
= locations (cities, towns, addresses); event = trips, purchases, appointments, deadlines (e.g. \
\"Trip to Barcelona in September\"); project = work projects; tool = software, files, libraries \
(ALWAYS metadata.scope \"project\" — never personal entities); object = a GOOD the user OWNS \
(vehicle, device, house, personal instrument: e.g. \"Moto Guzzi V7 Stone 850 2021\") — metadata.scope \
\"personal\"; topic = recurring interests/subjects (e.g. \"tennis\"). canonical_key STABLE \
\"type:normalized-name\" (e.g. \"organization:trenitalia\", \"event:trip-barcelona-2026\"). entity \
metadata.scope: \"personal\" for people/places/events/organizations in the user's life, \"project\" \
for files/libraries/tools of the current work. For the USER themselves ALWAYS use canonical_key \
\"person:self\" (both in entities and relations), e.g. for \"I have a daughter Sara\": relation \
parent_of person:self → person:sara. \
POSSESSIONS: when the user declares or CONFIRMS owning a good (\"my motorbike\", \"I own a Moto Guzzi \
V7\", \"my car/house\"), emit THREE things together: (a) a committed fact \"The user owns <good>\"; \
(b) the good entity (entity_type \"object\", scope \"personal\"); (c) the relation possiede \
person:self → object:<good>. E.g. \"yes, it's my Moto Guzzi V7 Stone 850 2021\" → entity {object, \
\"Moto Guzzi V7 Stone 850 2021\", canonical_key \"object:moto-guzzi-v7-stone-850-2021\"} + relation \
{possiede, person:self → object:moto-guzzi-v7-stone-850-2021} + committed fact. \
RELATIONS = use the SAME canonical_key in source_ref/target_ref. Insert entities and relations ONLY \
if explicit, otherwise leave the arrays empty. sensitivity: PII (tax ID, address, health, documents) \
= \"secret\"; personal facts (children, partner, city) = \"private\"; preferences and decisions = \
\"internal\". confidence >=0.8 only if explicit and unambiguous. \"episode\" is ALWAYS a short \
sentence about the exchange (even if memories/entities/relations are empty). If there is nothing to \
remember: {\"memories\":[],\"entities\":[],\"relations\":[],\"episode\":\"…\"}. \
OPEN LOOP CLOSURE: if the exchange or ACTIONS PERFORMED explicitly prove an existing open loop is \
now complete, do NOT emit another open_loop. Emit the durable fact/decision/outcome and add \
metadata.closes_open_loop with a short copy/paraphrase of the existing open loop. Use this only for \
completion with evidence, never for partial progress.";

/// Costruisce il system prompt completo (base + varianti speaker/actions/project/
/// known-decisions/known-open-loops). Spostato fedelmente dal gateway. I dati
/// gateway-only (`project_name`, known loops/decisions) sono forniti dal chiamante.
pub fn build_extractor_system(
    facade: &MemoryFacade,
    user: &UserId,
    active: &WorkspaceId,
    speaker: Option<&str>,
    actions: &str,
    project_name: Option<&str>,
) -> String {
    let base_system = EXTRACTOR_BASE_SYSTEM;
    // Channel mode.
    let system = match speaker {
        Some(name) => format!(
            "{base_system}\n\nIMPORTANT: this message comes from the CONTACT «{name}» via a \
messaging channel, NOT from the user. Attribute facts to «{name}» (canonical_key \
person:<normalized-name>); use person:self ONLY if the message explicitly talks about the user. \
ALSO capture plans, future events, trips, appointments, commitments and news (work, health, \
family, life) of the contact, with the time frame if indicated — these are NOT 'transient content', \
they should be remembered."
        ),
        None => base_system.to_string(),
    };
    // Generic decision capture (actions).
    let system = if actions.trim().is_empty() {
        system
    } else {
        format!(
            "{system}\n\nIf you find 'ACTIONS PERFORMED' below, extract the corresponding DECISIONS \
(memory_type \"decision\", scope \"project\"): WHAT was done and WHY, including the why in the 'text' \
sentence (e.g. «Modified the ACME quote because the client asked for a 10% discount»). Applies to \
ANY domain — code, documents, data — not only technical. metadata.decision with rationale and \
affects (the touched objects: file, document, contact…)."
        )
    };
    // Current project name (scope discipline).
    let system = if let Some(name) = project_name {
        format!(
            "{system}\n\nCURRENT PROJECT: «{name}». Tag scope=\"project\" ONLY for facts or \
decisions that concern THIS project. If the user talks about ANOTHER unrelated project/tool, do NOT \
save it as memory of this project: use scope \"personal\" if it is a durable fact about the user, \
otherwise do not save it."
        )
    } else {
        system
    };
    // Source-suppression: known decisions (solo in project).
    let known_decisions = if active.as_str() == PERSONAL_WORKSPACE {
        String::new()
    } else {
        facade
            .list_memories_for_ui(user, active)
            .map(|memories| {
                memories
                    .into_iter()
                    .filter(|m| {
                        m.memory_type == "decision"
                            && matches!(
                                m.status,
                                MemoryStatus::Confirmed | MemoryStatus::Candidate
                            )
                    })
                    .take(40)
                    .map(|m| {
                        format!(
                            "- {}",
                            m.text
                                .lines()
                                .next()
                                .unwrap_or(&m.text)
                                .chars()
                                .take(110)
                                .collect::<String>()
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default()
    };
    let system = if known_decisions.trim().is_empty() {
        system
    } else {
        format!(
            "{system}\n\nDECISIONS ALREADY IN MEMORY (do NOT re-register them: extract ONLY NEW or \
substantially updated decisions relative to these):\n{known_decisions}"
        )
    };
    // Known open loops (personal + project).
    let mut loop_lines = Vec::new();
    for (label, workspace) in [
        ("personal", WorkspaceId::new(PERSONAL_WORKSPACE)),
        ("project", active.clone()),
    ] {
        if label == "project" && workspace.as_str() == PERSONAL_WORKSPACE {
            continue;
        }
        for memory in facade
            .list_memories_for_ui(user, &workspace)
            .unwrap_or_default()
            .into_iter()
            .filter(active_open_loop_record)
            .take(8)
        {
            loop_lines.push(format!("- ({label}) {}", memory.text.trim().replace('\n', " ")));
        }
    }
    let known_open_loops = loop_lines.join("\n");
    if known_open_loops.trim().is_empty() {
        system
    } else {
        format!(
            "{system}\n\nOPEN LOOPS ALREADY IN MEMORY. If this exchange/ACTIONS explicitly complete \
one of these, set metadata.scope to the matching scope and metadata.closes_open_loop to the matching \
loop text/paraphrase:\n{known_open_loops}"
        )
    }
}

/// Persiste le memorie estratte in uno scope, deduplicando contro l'esistente per
/// overlap di contenuto (jaccard) e chiudendo open-loop. Spostato fedelmente dal
/// gateway (`persist_scope_memories`).
pub fn persist_scope_memories(
    facade: &MemoryFacade,
    user_id: &UserId,
    workspace_id: &WorkspaceId,
    mut memories: Vec<ExtractedMemory>,
) {
    if memories.is_empty() {
        return;
    }
    let closure_targets: Vec<String> = memories
        .iter()
        .filter(|memory| memory.memory_type != "open_loop")
        .flat_map(open_loop_closure_targets)
        .collect();
    // Dedup against the FULL set of existing memories by content overlap.
    let existing: Vec<(String, std::collections::HashSet<String>)> = facade
        .list_memories_for_ui(user_id, workspace_id)
        .map(|mems| {
            mems.into_iter()
                .map(|m| (m.text.clone(), dedup_tokens(&m.text)))
                .collect()
        })
        .unwrap_or_default();
    memories.retain(|new_memory| {
        let new_tokens = dedup_tokens(&new_memory.text);
        existing.iter().all(|(existing_text, existing_tokens)| {
            // Same-type + high jaccard = skip (already stored).
            let same_text = existing_text.trim() == new_memory.text.trim();
            !(same_text || jaccard(&new_tokens, existing_tokens) >= DEDUP_JACCARD)
        })
    });
    if memories.is_empty() {
        return;
    }
    for memory in memories {
        // Open-loop closure: if this memory closes an existing loop, mark it stale.
        if !closure_targets.is_empty() {
            let new_tokens = dedup_tokens(&memory.text);
            if let Ok(existing) = facade.list_memories_for_ui(user_id, workspace_id) {
                for m in existing {
                    if active_open_loop_record(&m) {
                        let target_tokens = dedup_tokens(&m.text);
                        if jaccard(&new_tokens, &target_tokens) >= 0.4 {
                            let _ = facade.mark_memory_stale(
                                &lifecycle_request(user_id, workspace_id),
                                &m.reference,
                                "closed by a later exchange",
                            );
                        }
                    }
                }
            }
        }
        let _ = create_or_update(facade, user_id, workspace_id, &memory);
    }
}

/// Costruisce una `MemoryLifecycleRequest` per lo scope. Helper privato.
fn lifecycle_request(
    user_id: &UserId,
    workspace_id: &WorkspaceId,
) -> crate::MemoryLifecycleRequest {
    crate::MemoryLifecycleRequest {
        actor_id: "memory-learn".to_string(),
        user_id: user_id.clone(),
        workspace_id: workspace_id.clone(),
        purpose: "extraction".to_string(),
    }
}

/// Crea/aggiorna una memoria estratta (auto-confirm low-risk). Spostato fedelmente.
fn create_or_update(
    facade: &MemoryFacade,
    user_id: &UserId,
    workspace_id: &WorkspaceId,
    memory: &ExtractedMemory,
) -> Result<(), String> {
    let request = lifecycle_request(user_id, workspace_id);
    let confidence = memory.confidence.clamp(0.0, 1.0);
    let create = crate::MemoryCreateRequest {
        request: request.clone(),
        memory_type: memory.memory_type.clone(),
        text: memory.text.clone(),
        aliases: memory.aliases.clone(),
        language_hints: memory.language_hints.clone(),
        confidence,
        privacy_domain: memory.privacy_domain.clone(),
        sensitivity: memory.sensitivity,
        metadata: memory.metadata.clone(),
        evidence_refs: Vec::new(),
    };
    let record = facade
        .create_memory_candidate(create)
        .map_err(|e| e.to_string())?;
    // Auto-confirm medium+ confidence (low-risk).
    if confidence >= 0.6 {
        let _ = facade.confirm_memory(&request, &record.reference, "auto-confirm learn");
    }
    Ok(())
}

/// Open-loop closure targets (paraphrase tokens di una memoria che potrebbe
/// chiudere un loop). Spostato fedelmente dal gateway (`open_loop_closure_targets`).
pub fn open_loop_closure_targets(memory: &ExtractedMemory) -> Vec<String> {
    memory
        .metadata
        .get("closes_open_loop")
        .and_then(|v| v.as_str())
        .into_iter()
        .map(|s| s.to_string())
        .collect()
}

// `cosine` è re-exportato sopra per i consumer futuri (semantic dedup in persist).
#[allow(dead_code)]
fn _cosine_link(a: &[f32], b: &[f32]) -> f32 {
    cosine(a, b)
}

// TODO(Tappa 4 step 2 completare): persist_graph + store_episode + l'orchestrazione
// learn_on_facade (chiamata LlmClient + build_extractor_system + parse + routing +
// persist). Per ora i building block sono nel crate; l'orchestrazione completa e il
// wiring del gateway verranno nel prossimo sub-commit (verifica+test ad ogni step).
