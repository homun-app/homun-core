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

/// Soglia di overlap coefficient (intersezione / min(|A|,|B|)) per decidere se
/// un gap fact è topicalamente correlato a un nuovo fatto positivo. Usiamo
/// overlap coefficient invece di jaccard perché i gap fact sono tipicamente
/// lunghi e verbose ("Non è ancora noto il titolo di ruolo…") mentre i fatti
/// positivi sono concisi ("L'utente lavora come senior developer"): la jaccard
/// penalizza il confronte breve↔lungo, l'overlap coefficient no.
const GAP_RETIRE_OVERLAP: f32 = 0.30;

/// Riconosce un "gap fact" — un fatto che asserisce l'ASSENZA o mancanza di
/// un'informazione ("non è noto", "still unknown", "non abbiamo", "not yet").
/// Il prompt di estrazione (`EXTRACTOR_BASE_SYSTEM`) incoraggia esplicitamente a
/// catturare questi NEGATIVES. Il problema: quando poi l'info diventa nota, il
/// gap fact resta attivo e contraddice il nuovo fatto, confondendo il modello
/// nel briefing (bug: "non ricorda che lavoro faccio").
///
/// Pattern multilingua (it/en). `text` viene normalizzato lowercase.
fn is_gap_fact(text: &str) -> bool {
    let low = text.to_lowercase();
    const MARKERS_IT: &[&str] = &[
        "non è ancora noto",
        "non è noto",
        "non è ancora",
        "non ancora",
        "non risulta",
        "non è chiaro",
        "non è specificato",
        "non è registrato",
        "non risulta registrato",
        "non è stato registrato",
        "non abbiamo",
        "non è stato",
        "non è stata",
        "non è stato possibile",
        "ancora non",
        "tuttora non",
        "in attesa di",
        "manca",
        "mancano",
        "sconosciuto",
        "ignoto",
        "non noto",
        "nessun titolo",
        "nessuna informazione",
        "senza precisarne",
        "non esplicit",
    ];
    const MARKERS_EN: &[&str] = &[
        "not yet known",
        "not known",
        "still unknown",
        "is unknown",
        "are unknown",
        "not specified",
        "not registered",
        "not clear",
        "not yet registered",
        "we don't have",
        "we do not have",
        "no information",
        "not yet available",
        "missing",
        "unspecified",
        "undetermined",
        "no record of",
        "not explicit",
        "awaiting confirmation",
        "waiting for confirmation",
    ];
    MARKERS_IT.iter().any(|m| low.contains(m)) || MARKERS_EN.iter().any(|m| low.contains(m))
}

/// Overlap coefficient = |A ∩ B| / min(|A|, |B|). A differenza della jaccard
/// (che divide per |A ∪ B|), questa metrica è robusta quando i due insiemi
/// hanno cardinalità molto diverse (caso tipico gap-verbose vs fatto-conciso).
fn overlap_coefficient(a: &std::collections::HashSet<String>, b: &std::collections::HashSet<String>) -> f32 {
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let inter = a.intersection(b).count() as f32;
    let min_size = a.len().min(b.len()) as f32;
    inter / min_size
}

/// Gap retirement (ADR 0022 follow-up). Quando si apprende un fatto POSITIVO
/// nuovo, cerca fact confirmed che esprimono un GAP (assenza/mancanza) e hanno
/// overlap topicale (jaccard) con il nuovo fatto → li marca stale. Risolve il
/// bug in cui "Non è ancora noto il titolo di ruolo" resta attivo e contraddice
/// "L'utente lavora come senior developer".
///
/// Solo `fact`/`preference`/`open_loop` confirmed vengono ritirati (non
/// decisions/goals, che hanno semantica diversa). Gli open_loop che esprimono
/// un gap ("non è noto X") vanno chiusi quando il fatto positivo arriva.
/// Ritorna il numero di gap ritirati.
fn retire_contradicted_gaps(
    facade: &MemoryFacade,
    user_id: &UserId,
    workspace_id: &WorkspaceId,
    new_memory: &ExtractedMemory,
) -> usize {
    // Solo fatti positivi ritirano i gap (non un altro gap, non una preferenza
    // generica — serve un'asserzione concreta).
    if !matches!(new_memory.memory_type.as_str(), "fact" | "preference") {
        return 0;
    }
    if is_gap_fact(&new_memory.text) {
        return 0; // il nuovo fatto è esso stesso un gap: niente da ritirare
    }
    let new_tokens = dedup_tokens(&new_memory.text);
    if new_tokens.len() < 2 {
        return 0;
    }
    let existing = match facade.list_memories_for_ui(user_id, workspace_id) {
        Ok(items) => items,
        Err(_) => return 0,
    };
    let request = lifecycle_request(user_id, workspace_id);
    let mut retired = 0;
    for m in existing {
        // Ritira fact/preference/open_loop che esprimono un gap. Le open_loop
        // che dicono "non è noto il titolo" vanno chiuse quando il titolo arriva.
        if !matches!(m.memory_type.as_str(), "fact" | "preference" | "open_loop") {
            continue;
        }
        if !matches!(m.status, MemoryStatus::Confirmed | MemoryStatus::Candidate) {
            continue;
        }
        if !is_gap_fact(&m.text) {
            continue;
        }
        let gap_tokens = dedup_tokens(&m.text);
        if overlap_coefficient(&new_tokens, &gap_tokens) >= GAP_RETIRE_OVERLAP {
            if facade
                .mark_memory_stale(&request, &m.reference, "superseded by a positive fact")
                .is_ok()
            {
                retired += 1;
            }
        }
    }
    retired
}

/// Sweep retroattivo one-shot: scansiona tutti i gap fact confirmed in uno scope
/// e ritira quelli per cui esiste GIÀ un fatto positivo confirmed che li contraddice.
/// Serve per pulire i dati legacy creati prima del gap retirement (`retire_contradicted_gaps`).
///
/// Da chiamare all'avvio del gateway (una volta per scope) o via endpoint consolidate.
/// Ritorna il numero di gap ritirati. Idempotente: rieseguire non ritira nulla
/// (i gap già stale vengono saltati dal filtro status).
pub fn sweep_gap_facts(facade: &MemoryFacade, user: &UserId, workspace: &WorkspaceId) -> usize {
    let items = match facade.list_memories_for_ui(user, workspace) {
        Ok(items) => items,
        Err(_) => return 0,
    };
    // Partition: gap memories (candidates for retirement, incl. open_loops that
    // express a gap) vs positive facts (the contradictors).
    let gaps: Vec<&crate::MemoryRecord> = items
        .iter()
        .filter(|m| {
            matches!(m.memory_type.as_str(), "fact" | "preference" | "open_loop")
                && matches!(m.status, MemoryStatus::Confirmed | MemoryStatus::Candidate)
                && is_gap_fact(&m.text)
        })
        .collect();
    let positives: Vec<(&crate::MemoryRecord, std::collections::HashSet<String>)> = items
        .iter()
        .filter(|m| {
            matches!(m.memory_type.as_str(), "fact" | "preference")
                && matches!(m.status, MemoryStatus::Confirmed | MemoryStatus::Candidate)
                && !is_gap_fact(&m.text)
        })
        .map(|m| (m, dedup_tokens(&m.text)))
        .collect();
    if gaps.is_empty() || positives.is_empty() {
        return 0;
    }
    let request = crate::MemoryLifecycleRequest {
        actor_id: "gap-sweep".to_string(),
        user_id: user.clone(),
        workspace_id: workspace.clone(),
        purpose: "retroactive_gap_retirement".to_string(),
    };
    let mut retired = 0;
    for gap in gaps {
        let gap_tokens = dedup_tokens(&gap.text);
        // Un gap viene ritirato se ALMENO un fatto positivo ha overlap superiore alla soglia.
        let contradicted = positives.iter().any(|(_, pos_tokens)| {
            overlap_coefficient(pos_tokens, &gap_tokens) >= GAP_RETIRE_OVERLAP
        });
        if contradicted {
            if facade
                .mark_memory_stale(&request, &gap.reference, "retroactive gap sweep")
                .is_ok()
            {
                retired += 1;
            }
        }
    }
    retired
}

/// Persiste le memorie estratte in uno scope, deduplicando contro l'esistente per
/// overlap di contenuto (jaccard) e chiudendo open-loop. Spostato fedelmente
/// dal gateway (`persist_scope_memories`).
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
        // Gap retirement: se il nuovo fatto è positivo, ritira i gap fact
        // (assenza/mancanza) topicalamente correlati che ora risultano obsoleti.
        // Deve avvenire PRIMA della persistenza per evitare di ritirare il fatto
        // appena creato (che verrebbe dedup-persisted dopo).
        let _ = retire_contradicted_gaps(facade, user_id, workspace_id, &memory);
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
    // Auto-confirm medium+ confidence (low-risk). Soglia abbassata a 0.5 (era 0.6):
    // l'estrattore LLM a volte assegna confidence 0.5-0.6 a fatti validi, lasciandoli
    // invisibili (candidate) nel briefing. 0.5 li rende visibili subito.
    if confidence >= 0.5 {
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

// ──────────────────────────────────────────────────────────────────────────
// Orchestrazione learn (Step 2b)
// ──────────────────────────────────────────────────────────────────────────

/// Callback iniettate dal gateway per le parti di learn che restano gateway-side
/// per ora (grafo, episode, backfill embeddings). `None` = skip (test isolation).
/// Pattern = graph_context del recall.
pub struct LearnHooks<'a> {
    /// Persiste entità/relazioni nel grafo (personal + project). Firma speculare
    /// a `persist_graph` del gateway.
    pub persist_graph: Option<&'a (dyn Fn(&MemoryFacade, &UserId, &WorkspaceId, Vec<ExtractedEntity>, Vec<ExtractedRelation>, Option<&WorkspaceId>) + Sync)>,
    /// Memorizza l'episodio one-line (M4) nel thread scope.
    pub store_episode: Option<&'a (dyn Fn(&MemoryFacade, &UserId, &str, &str, &str) + Sync)>,
    /// Backfill embeddings incrementale (background). Firma: (facade, user, ws, batch).
    pub backfill_embeddings: Option<&'a (dyn Fn(&MemoryFacade, &UserId, &WorkspaceId, usize) + Sync)>,
}

/// Orchestrazione learn: gating salience → build prompt (con facade per known
/// loops/decisions) → LLM estrattore → parse JSON resiliente → routing scope
/// → persist memories (+ hooks opzionali per grafo/episode/backfill).
///
/// **Split in 3 fasi** (come il recall) per risolvere il Send-bound: il
/// `MutexGuard` della facade NON deve attraversare l'await della LLM call.
/// Il chiamante (gateway) orchesta: (1) [`prepare_learn_prompt`] sync sotto
/// lock → (2) LLM call off-lock via `LlmClient` → (3) [`persist_learn_extraction`]
/// sync sotto lock re-acquisito.
///
/// Lo scope è **argomento esplicito**: isolation by construction.

/// Fase 1 (sync, sotto lock): gating + build system prompt + exchange.
/// Ritorna `Some((system, user_content))` o `None` se skip (no-op).
pub fn prepare_learn_prompt(
    facade: &MemoryFacade,
    user: &UserId,
    active: &WorkspaceId,
    user_message: &str,
    assistant_message: &str,
    actions: &str,
    speaker: Option<&str>,
    prev_assistant: Option<&str>,
    project_name: Option<&str>,
) -> Option<(String, String)> {
    let is_confirmation = prev_assistant
        .is_some_and(|p| !p.trim().is_empty())
        && is_confirmation_reply(user_message);
    if actions.trim().is_empty() && !is_salient_exchange(user_message) && !is_confirmation {
        return None;
    }
    let system = build_extractor_system(facade, user, active, speaker, actions, project_name);
    let exchange = match speaker {
        Some(name) => {
            format!("MESSAGE from {name} (channel):\n{user_message}\n\nREPLY: {assistant_message}")
        }
        None => {
            let preface = match prev_assistant {
                Some(p) if is_confirmation && !p.trim().is_empty() => format!(
                    "ASSISTANT (previous turn — what the user is replying to): {}\n\n",
                    p.trim()
                ),
                _ => String::new(),
            };
            format!("{preface}USER: {user_message}\n\nASSISTANT: {assistant_message}")
        }
    };
    let user_content = if actions.trim().is_empty() {
        exchange
    } else {
        format!("{exchange}\n\nACTIONS PERFORMED this turn:\n{actions}")
    };
    Some((system, user_content))
}

/// Fase 3 (sync, sotto lock re-acquisito): parse JSON resiliente + routing
/// scope + persist memories + hooks (grafo/episode/backfill). Spostato fedelmente
/// dal corpo di `learn_from_exchange` (post-LLM).
pub fn persist_learn_extraction(
    facade: &MemoryFacade,
    user: &UserId,
    active: &WorkspaceId,
    content: &str,
    thread_id: Option<&str>,
    hooks: LearnHooks<'_>,
) -> bool {
    let Ok(root) = serde_json::from_str::<serde_json::Value>(strip_json_fences(content)) else {
        return false;
    };
    let memories: Vec<ExtractedMemory> = root
        .get("memories")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|i| serde_json::from_value(fill_extraction_defaults(i)).ok())
                .collect()
        })
        .unwrap_or_default();
    let entities: Vec<ExtractedEntity> = root
        .get("entities")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|i| serde_json::from_value(fill_extraction_defaults(i)).ok())
                .collect()
        })
        .unwrap_or_default();
    let relations: Vec<ExtractedRelation> = root
        .get("relations")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|i| serde_json::from_value(fill_extraction_defaults(i)).ok())
                .collect()
        })
        .unwrap_or_default();
    let episode = root
        .get("episode")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let mut extraction = MemoryExtraction {
        memories,
        entities,
        relations,
    };
    let graph_entities = std::mem::take(&mut extraction.entities);
    let graph_relations = std::mem::take(&mut extraction.relations);
    extraction.memories.retain(|m| {
        matches!(
            m.memory_type.as_str(),
            "fact" | "preference" | "decision" | "goal" | "open_loop"
        )
    });
    // Anti-noise: scarta fact di stato di esecuzione del runtime ("Runtime plan
    // step completed: …", "Runtime plan state: …") — sono tracking transitorio,
    // non conoscenza durevole. Se persistiti, saturano il briefing budget (4000
    // char) e spingono fuori i fatti reali (bug: "non ricorda che lavoro faccio").
    extraction.memories.retain(|m| {
        let low = m.text.to_lowercase();
        !(low.starts_with("runtime plan step")
            || low.starts_with("runtime plan state")
            || low.starts_with("validation test:"))
    });
    if extraction.memories.is_empty()
        && graph_entities.is_empty()
        && graph_relations.is_empty()
        && episode.is_empty()
    {
        return false;
    }
    for memory in &mut extraction.memories {
        memory.privacy_domain = PrivacyDomain::new("personal");
        // ADR 0022 (Piano UI A5): provenance cross-chat — stampa il thread_id
        // d'origine sul record durevole, così la UI può mostrare "appreso in
        // chat 'X'". Solo se il thread è noto (chiamante gateway lo passa).
        if let Some(tid) = thread_id {
            if memory.metadata.get("thread_id").is_none() {
                memory.metadata["thread_id"] = serde_json::Value::String(tid.to_string());
            }
        }
    }
    let has_project = active.as_str() != PERSONAL_WORKSPACE;
    let mut personal_mems: Vec<ExtractedMemory> = Vec::new();
    let mut project_mems: Vec<ExtractedMemory> = Vec::new();
    for memory in extraction.memories {
        let scope = memory
            .metadata
            .get("scope")
            .and_then(|s| s.as_str())
            .unwrap_or("");
        let to_project = has_project
            && (scope == "project"
                || (scope.is_empty() && memory.memory_type.as_str() == "decision"));
        if to_project {
            project_mems.push(memory);
        } else {
            personal_mems.push(memory);
        }
    }
    persist_scope_memories(
        facade,
        user,
        &WorkspaceId::new(PERSONAL_WORKSPACE),
        personal_mems,
    );
    if has_project {
        persist_scope_memories(facade, user, active, project_mems);
    }
    if let Some(persist_graph) = hooks.persist_graph {
        persist_graph(
            facade,
            user,
            &WorkspaceId::new(PERSONAL_WORKSPACE),
            graph_entities,
            graph_relations,
            has_project.then_some(active),
        );
    }
    if let Some(store_episode) = hooks.store_episode {
        if let Some(tid) = thread_id {
            store_episode(facade, user, tid, &episode, active.as_str());
        }
    }
    if let Some(backfill) = hooks.backfill_embeddings {
        backfill(facade, user, &WorkspaceId::new(PERSONAL_WORKSPACE), 12);
        if has_project {
            backfill(facade, user, active, 12);
        }
    }
    // ADR 0022 (post-UI): promuovi i candidate vecchi (che hanno sopravvissuto
    // abbastanza turni senza reject) → diventano confirmed e visibili nel briefing.
    promote_aged_candidates(facade, user, &WorkspaceId::new(PERSONAL_WORKSPACE));
    if has_project {
        promote_aged_candidates(facade, user, active);
    }
    // Gap retirement retroattivo: dopo aver persistito nuovi fatti, ritira i
    // gap fact obsoleti in TUTTI gli scope toccati (non solo quello attivo,
    // perché il prompt personal può aver creato gap nello scope personale).
    sweep_gap_facts(facade, user, &WorkspaceId::new(PERSONAL_WORKSPACE));
    if has_project {
        sweep_gap_facts(facade, user, active);
    }
    true
}

// I predicati di salience/confirmation sono piccoli e pure; li definiamo qui
// (spostati fedelmente dal gateway) così learn_on_facade è self-contained.
// NB: il gateway ha ancora le sue copie (usate altrove); verranno rimosse nello
// Step 5.

/// `is_salient_exchange` spostato fedelmente dal gateway.
pub fn is_salient_exchange(user_message: &str) -> bool {
    let trimmed = user_message.trim();
    if trimmed.is_empty() {
        return false;
    }
    // Standalone choice-card / short replies non sono salient (non estraiamo).
    if is_confirmation_reply(trimmed) {
        return false;
    }
    trimmed.chars().count() >= 12
}

/// `is_confirmation_reply` spostato fedelmente dal gateway.
pub fn is_confirmation_reply(user_message: &str) -> bool {
    let normalized = user_message.trim().to_lowercase();
    matches!(
        normalized.as_str(),
        "ok" | "okay" | "va bene" | "procedi" | "conferma" | "confermato" | "annulla"
            | "cancella" | "stop" | "cambio idea" | "non salvare" | "salva" | "sì"
            | "si" | "yes" | "no" | "esatto" | "giusto" | "corretto" | "certo" | "d'accordo"
    )
}

/// ADR 0022 (post-UI): promotion automatica dei candidate. Un record `candidate`
/// che sopravvive abbastanza a lungo (soglia temporale) senza essere rejectato
/// viene promosso a `confirmed` — così i fatti estratti con confidence bassa
/// (sotto la soglia di auto-confirm) diventano visibili nel briefing dopo un po',
/// invece di restare invisibili per sempre.
///
/// Chiamata in coda a `persist_learn_extraction` per ogni scope toccato. Soglia
/// default: 10 minuti (knob `HOMUN_CANDIDATE_PROMOTE_MINS`).
pub fn promote_aged_candidates(facade: &MemoryFacade, user: &UserId, workspace: &WorkspaceId) -> usize {
    let promote_after_secs: i64 = std::env::var("HOMUN_CANDIDATE_PROMOTE_MINS")
        .ok()
        .and_then(|v| v.trim().parse::<i64>().ok())
        .filter(|v| *v > 0)
        .unwrap_or(10)
        * 60;
    let now_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let items = match facade.list_memories_for_ui(user, workspace) {
        Ok(items) => items,
        Err(_) => return 0,
    };
    let request = crate::MemoryLifecycleRequest {
        actor_id: "auto-promote".to_string(),
        user_id: user.clone(),
        workspace_id: workspace.clone(),
        purpose: "promote_aged".to_string(),
    };
    let mut promoted = 0;
    for m in items {
        if m.status != crate::MemoryStatus::Candidate {
            continue;
        }
        // Età del candidate dal created_at (unix:<secs> o <secs>).
        let created_secs = m
            .created_at
            .strip_prefix("unix:")
            .unwrap_or(&m.created_at)
            .split('.')
            .next()
            .and_then(|p| p.parse::<i64>().ok())
            .unwrap_or(now_secs);
        if now_secs - created_secs >= promote_after_secs {
            if facade
                .confirm_memory(&request, &m.reference, "auto-promoted (aged candidate)")
                .is_ok()
            {
                promoted += 1;
            }
        }
    }
    promoted
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{MemoryFacade, SQLiteMemoryStore};

    /// LLM mock che ritorna un JSON estratto fisso (una preferenza personale).
    /// Deterministico, no HTTP. L'end-to-end async (learn_on_facade) si testa nel
    /// gateway (che ha tokio); qui testiamo i building block sync.
    struct MockExtractor;
    impl crate::LlmClient for MockExtractor {
        fn chat<'a>(&'a self, _system: &'a str, _user: &'a str) -> BoxFuture<'a, Option<String>> {
            Box::pin(async move {
                Some(
                    r#"{"memories":[{"memory_type":"preference","text":"Prefers replies in Italian","sensitivity":"internal","confidence":0.9,"metadata":{"scope":"personal","certainty":"committed"}}],"entities":[],"relations":[],"episode":"The user stated a language preference."}"#
                        .to_string(),
                )
            })
        }
    }

    #[test]
    fn mock_extractor_compiles_and_is_send_sync() {
        // Verifica che il mock impl LlmClient ed è Send+Sync (richiesto dal trait).
        fn assert_send_sync<T: Send + Sync>(_: &T) {}
        let mock = MockExtractor;
        assert_send_sync(&mock);
    }

    #[test]
    fn salience_and_confirmation_predicates_are_sound() {
        assert!(is_salient_exchange("Qual è la decisione sul database?"));
        assert!(!is_salient_exchange("ok"));
        assert!(!is_salient_exchange(""));
        assert!(is_confirmation_reply("ok"));
        assert!(is_confirmation_reply("Sì"));
        assert!(!is_confirmation_reply("una frase lunga e non di conferma"));
    }

    #[test]
    fn strip_json_fences_handles_wrapped_and_bare() {
        assert_eq!(strip_json_fences("```json\n{\"a\":1}\n```"), "{\"a\":1}");
        assert_eq!(strip_json_fences("```\n{\"a\":1}\n```"), "{\"a\":1}");
        assert_eq!(strip_json_fences("{\"a\":1}"), "{\"a\":1}");
    }

    #[test]
    fn persist_scope_memories_dedups_against_existing() {
        let facade = MemoryFacade::new(SQLiteMemoryStore::open_in_memory().unwrap());
        let user = UserId::new("dedup-user");
        let ws = WorkspaceId::new(PERSONAL_WORKSPACE);
        // Pre-existing memory.
        let existing = ExtractedMemory {
            memory_type: "fact".into(),
            text: "The user owns a Moto Guzzi V7 Stone".into(),
            aliases: vec![],
            language_hints: vec![],
            confidence: 0.9,
            privacy_domain: PrivacyDomain::new("personal"),
            sensitivity: crate::DataSensitivity::Public,
            metadata: serde_json::json!({"scope": "personal"}),
            evidence_refs: vec![],
        };
        persist_scope_memories(&facade, &user, &ws, vec![existing.clone()]);
        let count_after_first = facade.list_memories_for_ui(&user, &ws).unwrap().len();
        assert_eq!(count_after_first, 1);
        // Re-persist the SAME memory (paraphrase, high jaccard) → dedup, no new row.
        let paraphrase = ExtractedMemory {
            text: "The user owns a Moto Guzzi V7 Stone".into(),
            ..existing
        };
        persist_scope_memories(&facade, &user, &ws, vec![paraphrase]);
        let count_after_dup = facade.list_memories_for_ui(&user, &ws).unwrap().len();
        assert_eq!(count_after_dup, 1, "paraphrase ad alta jaccard dedupplicata");
    }

    #[test]
    fn is_gap_fact_detects_negative_assertions_multilang() {
        // Italian gap facts.
        assert!(is_gap_fact("Non è ancora noto il titolo di ruolo professionale"));
        assert!(is_gap_fact("Il nome dell'azienda è sconosciuto"));
        assert!(is_gap_fact("Non risulta alcuna informazione sul progetto"));
        assert!(is_gap_fact("manca la data di consegna"));
        // English gap facts.
        assert!(is_gap_fact("The role is still unknown"));
        assert!(is_gap_fact("No information about the deadline"));
        assert!(is_gap_fact("not yet available"));
        // Positive facts must NOT match.
        assert!(!is_gap_fact("L'utente lavora come senior developer"));
        assert!(!is_gap_fact("The user owns a Moto Guzzi V7 Stone"));
        assert!(!is_gap_fact("Prefers replies in Italian"));
    }

    #[test]
    fn gap_retirement_retires_contradictory_gap_on_positive_fact() {
        let facade = MemoryFacade::new(SQLiteMemoryStore::open_in_memory().unwrap());
        let user = UserId::new("gap-user");
        let ws = WorkspaceId::new(PERSONAL_WORKSPACE);
        // Pre-existing gap fact (the bug: stays active and contradicts the truth).
        let gap = ExtractedMemory {
            memory_type: "fact".into(),
            text: "Non è ancora noto il titolo di ruolo professionale dell'utente né \
                   l'azienda per cui lavora"
                .into(),
            aliases: vec![],
            language_hints: vec![],
            confidence: 0.9,
            privacy_domain: PrivacyDomain::new("personal"),
            sensitivity: crate::DataSensitivity::Public,
            metadata: serde_json::json!({"scope": "personal"}),
            evidence_refs: vec![],
        };
        persist_scope_memories(&facade, &user, &ws, vec![gap]);
        let confirmed_count = facade.list_memories_for_ui(&user, &ws).unwrap().len();
        assert_eq!(confirmed_count, 1, "gap fact persistito come confirmed");
        // Now learn the positive fact that contradicts the gap.
        let positive = ExtractedMemory {
            memory_type: "fact".into(),
            text: "L'utente lavora come senior developer".into(),
            aliases: vec![],
            language_hints: vec![],
            confidence: 1.0,
            privacy_domain: PrivacyDomain::new("personal"),
            sensitivity: crate::DataSensitivity::Public,
            metadata: serde_json::json!({"scope": "personal"}),
            evidence_refs: vec![],
        };
        persist_scope_memories(&facade, &user, &ws, vec![positive]);
        let items = facade.list_memories_for_ui(&user, &ws).unwrap();
        // The positive fact must be present and confirmed...
        let has_positive = items.iter().any(|m| {
            m.status == MemoryStatus::Confirmed && m.text.contains("senior developer")
        });
        assert!(has_positive, "il fatto positivo è confirmed");
        // ...and the gap fact must be RETIRED (stale), not confirmed/candidate.
        // list_memories_for_ui include gli stale (filtra solo tombstoned/deleted),
        // quindi possiamo ispezionare lo status direttamente.
        let raw = facade.list_memories_for_ui(&user, &ws).unwrap();
        let gap_record = raw
            .iter()
            .find(|m| m.text.contains("Non è ancora noto"))
            .expect("il gap fact è ancora nel DB (stale, non cancellato)");
        assert_eq!(
            gap_record.status,
            MemoryStatus::Stale,
            "il gap fact contraddetto è stato ritirato (stale)"
        );
    }

    #[test]
    fn gap_retirement_does_not_retire_unrelated_gap() {
        let facade = MemoryFacade::new(SQLiteMemoryStore::open_in_memory().unwrap());
        let user = UserId::new("gap-unrelated");
        let ws = WorkspaceId::new(PERSONAL_WORKSPACE);
        // Unrelated gap fact about a different topic.
        let gap = ExtractedMemory {
            memory_type: "fact".into(),
            text: "Non è noto il colore preferito dell'utente".into(),
            aliases: vec![],
            language_hints: vec![],
            confidence: 0.8,
            privacy_domain: PrivacyDomain::new("personal"),
            sensitivity: crate::DataSensitivity::Public,
            metadata: serde_json::json!({"scope": "personal"}),
            evidence_refs: vec![],
        };
        persist_scope_memories(&facade, &user, &ws, vec![gap]);
        // Positive fact about a different topic (job, not color).
        let positive = ExtractedMemory {
            memory_type: "fact".into(),
            text: "L'utente lavora come senior developer".into(),
            aliases: vec![],
            language_hints: vec![],
            confidence: 1.0,
            privacy_domain: PrivacyDomain::new("personal"),
            sensitivity: crate::DataSensitivity::Public,
            metadata: serde_json::json!({"scope": "personal"}),
            evidence_refs: vec![],
        };
        persist_scope_memories(&facade, &user, &ws, vec![positive]);
        let raw = facade.list_memories_for_ui(&user, &ws).unwrap();
        let gap_record = raw
            .iter()
            .find(|m| m.text.contains("colore preferito"))
            .expect("unrelated gap fact presente");
        // Unrelated gap must remain confirmed (jaccard too low).
        assert_eq!(
            gap_record.status,
            MemoryStatus::Confirmed,
            "un gap non correlato topicamente non viene ritirato"
        );
    }
}
