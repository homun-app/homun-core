//! ADR 0022 (Tappa 4, step F2+F3) — ricostruttori wiki + dedup open-loop +
//! consolidazione (reflection), spostati dal gateway monolite nel crate memoria.
//!
//! Tutte le funzioni sono **pure-facade** (leggono/scrivono via `MemoryFacade`),
//! senza dipendenze HTTP/LLM/filesystem-gateway. La `consolidate_scope` originale
//! (monolitica, con `await` sotto lock) è **split in 3 fasi Send-safe** (come
//! recall/learn/backfill): il `MutexGuard` NON attraversa l'await della LLM call.
//! Il chiamante (gateway) orchesta: (1) [`consolidate_prepare`] sync sotto lock →
//! (2) LLM curatore off-lock via `LlmClient` → (3) [`consolidate_apply`] sync
//! sotto lock re-acquisito.
//!
//! La dedizione al filtro `active_open_loop_record` (versione completa del
//! gateway con filtro `runtime_plan`/`superseded_by`/testo-vuoto) è locale: il
//! crate ha una copia parziale in `learn.rs` (usata solo dal prompt estrattore);
//! i ricostruttori wiki hanno bisogno di quella completa.

use std::collections::{BTreeSet, HashMap, HashSet};

use crate::{
    cosine, dedup_tokens, jaccard, MemoryFacade, MemoryLifecycleRequest, MemoryRef, MemoryRefKind,
    PERSONAL_WORKSPACE, PrivacyDomain, DataSensitivity, UserId, WikiPage, WorkspaceId,
    recall::DEDUP_JACCARD, embedding::DEDUP_COSINE, THREADS_WORKSPACE, memory_is_current_at,
};

fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or_default()
}

/// Predicato "record open-loop ATTIVO" — versione completa (spostata fedelmente
/// dal gateway `active_open_loop_record`). Differisce dalla copia parziale in
/// `learn.rs` perché filtra anche `superseded_by`, testo vuoto e `runtime_plan`
/// (i runtime-plan sono control-flow dell'harness, non open-loop generici).
fn active_open_loop_record(memory: &crate::MemoryRecord, now_unix: i64) -> bool {
    memory.memory_type == "open_loop"
        && memory_is_current_at(memory, now_unix, true)
        && !memory.text.trim().is_empty()
        // Runtime plans are harness-owned control-flow state. They are resumed
        // only through the per-thread runtime-plan loader; injecting them as
        // generic open loops lets unrelated threads contaminate a fresh prompt.
        && memory.metadata.get("source").and_then(|v| v.as_str()) != Some("runtime_plan")
}

/// Un titolo wiki leggibile dalla prima riga non vuota di un testo. Spostato
/// fedelmente dal gateway (`wiki_title_from_text`).
pub fn wiki_title_from_text(text: &str) -> String {
    let first = text
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("Nota");
    let trimmed = first.trim();
    if trimmed.chars().count() <= 60 {
        trimmed.to_string()
    } else {
        format!("{}…", trimmed.chars().take(57).collect::<String>())
    }
}

/// Costruisce il body della pagina "Stato lavori" dagli open-loop. Spostato
/// fedelmente dal gateway (`status_wiki_body_from_open_loops`).
pub fn status_wiki_body_from_open_loops(
    open_loops: &[(MemoryRef, String)],
) -> (String, Vec<MemoryRef>) {
    let mut loops: Vec<(MemoryRef, String)> = open_loops
        .iter()
        .filter_map(|(reference, text)| {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some((reference.clone(), trimmed.to_string()))
            }
        })
        .collect();
    loops.sort_by_key(|(_, text)| std::cmp::Reverse(text.chars().count()));
    let mut kept_tokens: Vec<HashSet<String>> = Vec::new();
    loops.retain(|(_, text)| {
        let tokens = dedup_tokens(text);
        if kept_tokens
            .iter()
            .any(|existing| jaccard(&tokens, existing) >= DEDUP_JACCARD)
        {
            false
        } else {
            kept_tokens.push(tokens);
            true
        }
    });

    let mut body = String::from(
        "# Stato lavori\n\n> Pagina generata dagli open loop della memoria. \
Editabile a mano: le correzioni rientrano nello store strutturato tramite re-ingest.\n\n",
    );
    if loops.is_empty() {
        body.push_str("## Loop aperti\n\n_Nessun loop aperto registrato._\n");
        return (body, Vec::new());
    }

    body.push_str("## Loop aperti\n\n");
    let mut linked_refs = Vec::new();
    for (idx, (reference, text)) in loops.iter().enumerate() {
        linked_refs.push(reference.clone());
        let title = wiki_title_from_text(text);
        body.push_str(&format!("### {}. {title}\n\n", idx + 1));
        body.push_str("- Stato: aperto\n");
        body.push_str(&format!("- Memoria: `{}`\n\n", reference));
        body.push_str(text);
        body.push_str("\n\n");
    }
    (body, linked_refs)
}

/// Wiki projection (markdown face of the memory): regenerate the project's "Decisioni"
/// page from the confirmed decisions and persist it to SQL (wiki_pages). The structured
/// rows stay canonical; this is the readable, human-editable projection (the hybrid
/// model). Idempotent — one page per workspace, rebuilt in place. Skipped if the user
/// edited the page by hand (their version wins until they regenerate). Spostato
/// fedelmente dal gateway.
pub fn rebuild_decisions_wiki(
    facade: &MemoryFacade,
    user_id: &UserId,
    workspace: &WorkspaceId,
    is_edited: &dyn Fn(&WorkspaceId, &str) -> bool,
) {
    if is_edited(workspace, "decisioni.md") {
        return;
    }
    let Ok(memories) = facade.list_memories_for_ui(user_id, workspace) else {
        return;
    };
    let now_unix = unix_now();
    let mut decisions: Vec<_> = memories
        .into_iter()
        .filter(|m| {
            m.memory_type == "decision" && memory_is_current_at(m, now_unix, true)
        })
        .collect();
    if decisions.is_empty() {
        return;
    }
    // Lexical dedup for the page too (richest first), so it reads cleanly.
    decisions.sort_by_key(|m| std::cmp::Reverse(m.text.chars().count()));
    let mut kept_tokens: Vec<HashSet<String>> = Vec::new();
    decisions.retain(|m| {
        let tokens = dedup_tokens(&m.text);
        if kept_tokens
            .iter()
            .any(|ex| jaccard(&tokens, ex) >= DEDUP_JACCARD)
        {
            false
        } else {
            kept_tokens.push(tokens);
            true
        }
    });

    let mut body = String::from(
        "# Project decisions\n\n> Page generated from memory (editable by hand: corrections flow back into the structured store).\n\n",
    );
    let mut linked = Vec::new();
    for memory in &decisions {
        linked.push(memory.reference.clone());
        let title = memory.text.lines().next().unwrap_or(&memory.text).trim();
        body.push_str(&format!("## {title}\n\n"));
        if let Some(decision) = memory.metadata.get("decision") {
            if let Some(rationale) = decision.get("rationale").and_then(|r| r.as_str()) {
                if !rationale.trim().is_empty() {
                    body.push_str(&format!("{}\n\n", rationale.trim()));
                }
            }
            if let Some(alts) = decision.get("alternatives").and_then(|a| a.as_array()) {
                for alt in alts {
                    let Some(option) = alt.get("option").and_then(|o| o.as_str()) else {
                        continue;
                    };
                    if option.is_empty() {
                        continue;
                    }
                    let why = alt
                        .get("rejected_because")
                        .and_then(|w| w.as_str())
                        .unwrap_or("");
                    body.push_str(&format!("- Scartata **{option}**: {why}\n"));
                }
            }
        }
        if let Some(affected) = memory
            .metadata
            .get("affects_labels")
            .and_then(|a| a.as_array())
        {
            let files: Vec<&str> = affected.iter().filter_map(|v| v.as_str()).collect();
            if !files.is_empty() {
                body.push_str(&format!("\n_File: {}_\n", files.join(", ")));
            }
        }
        body.push('\n');
    }

    // Reuse the existing page's ref (update in place) or mint a new one.
    let path = "decisioni.md";
    let reference = facade
        .list_wiki_pages_for_ui(user_id, workspace)
        .ok()
        .and_then(|pages| {
            pages
                .into_iter()
                .find(|p| p.path == path)
                .map(|p| p.reference)
        })
        .unwrap_or_else(|| {
            MemoryRef::generated(MemoryRefKind::Wiki, user_id.clone(), workspace.clone())
        });
    let page = WikiPage {
        reference,
        user_id: user_id.clone(),
        workspace_id: workspace.clone(),
        path: path.to_string(),
        title: "Project decisions".to_string(),
        body,
        linked_refs: linked,
        privacy_domain: PrivacyDomain::new("work"),
        sensitivity: DataSensitivity::Internal,
    };
    let _ = facade.record_wiki_page_for_ui(&page);
}

/// Project BRIEF (`brief.md`): the always-on "where this project is going" page —
/// goals + recent state. Generated & editable like profilo.md/decisioni.md (manual
/// edits win). Injected at turn start (push) so the assistant holds the project's
/// direction without being asked. Projects only (not personal/threads). Spostato
/// fedelmente dal gateway.
pub fn rebuild_project_brief(
    facade: &MemoryFacade,
    user_id: &UserId,
    workspace: &WorkspaceId,
    is_edited: &dyn Fn(&WorkspaceId, &str) -> bool,
) {
    if workspace.as_str() == PERSONAL_WORKSPACE || workspace.as_str() == THREADS_WORKSPACE {
        return;
    }
    if is_edited(workspace, "brief.md") {
        return;
    }
    let Ok(memories) = facade.list_memories_for_ui(user_id, workspace) else {
        return;
    };
    let now_unix = unix_now();
    let goals: Vec<String> = memories
        .iter()
        .filter(|m| {
            m.memory_type == "goal" && memory_is_current_at(m, now_unix, true)
        })
        .map(|m| m.text.trim().to_string())
        .collect();
    let decisions: Vec<String> = memories
        .iter()
        .filter(|m| {
            m.memory_type == "decision" && memory_is_current_at(m, now_unix, true)
        })
        .map(|m| m.text.lines().next().unwrap_or(&m.text).trim().to_string())
        .collect();
    if goals.is_empty() && decisions.is_empty() {
        return; // nothing to brief yet
    }
    let mut body = String::from(
        "# Project brief\n\n> Generated view (editable by hand): objectives + status. \
Your edits stick. It's what the assistant ALWAYS keeps in mind about the project.\n\n## Objectives\n\n",
    );
    if goals.is_empty() {
        body.push_str(
            "_No objective recorded — edit this page to define where the project is heading._\n\n",
        );
    } else {
        for g in &goals {
            body.push_str(&format!("- {g}\n"));
        }
        body.push('\n');
    }
    if !decisions.is_empty() {
        body.push_str("## Recent status and decisions\n\n");
        for d in decisions.iter().take(6) {
            body.push_str(&format!("- {d}\n"));
        }
        body.push('\n');
    }
    let path = "brief.md";
    let reference = facade
        .list_wiki_pages_for_ui(user_id, workspace)
        .ok()
        .and_then(|pages| {
            pages
                .into_iter()
                .find(|p| p.path == path)
                .map(|p| p.reference)
        })
        .unwrap_or_else(|| {
            MemoryRef::generated(MemoryRefKind::Wiki, user_id.clone(), workspace.clone())
        });
    let page = WikiPage {
        reference,
        user_id: user_id.clone(),
        workspace_id: workspace.clone(),
        path: path.to_string(),
        title: "Project brief".to_string(),
        body,
        linked_refs: Vec::new(),
        privacy_domain: PrivacyDomain::new("personal"),
        sensitivity: DataSensitivity::Internal,
    };
    let _ = facade.record_wiki_page_for_ui(&page);
}

/// Project status (`stato-lavori.md`): the readable/editable face of open loops.
/// SQL stays canonical; this page makes unfinished work visible in the wiki and
/// links each item back to its source memory ref. Manual edits win like the other
/// generated wiki pages. Spostato fedelmente dal gateway.
pub fn rebuild_status_wiki(
    facade: &MemoryFacade,
    user_id: &UserId,
    workspace: &WorkspaceId,
    is_edited: &dyn Fn(&WorkspaceId, &str) -> bool,
) {
    let path = "stato-lavori.md";
    if is_edited(workspace, path) {
        return;
    }
    let Ok(memories) = facade.list_memories_for_ui(user_id, workspace) else {
        return;
    };
    let now_unix = unix_now();
    let open_loops: Vec<(MemoryRef, String)> = memories
        .into_iter()
        .filter(|m| active_open_loop_record(m, now_unix))
        .map(|memory| (memory.reference, memory.text))
        .collect();
    let (body, linked_refs) = status_wiki_body_from_open_loops(&open_loops);
    let reference = facade
        .list_wiki_pages_for_ui(user_id, workspace)
        .ok()
        .and_then(|pages| {
            pages
                .into_iter()
                .find(|p| p.path == path)
                .map(|p| p.reference)
        })
        .unwrap_or_else(|| {
            MemoryRef::generated(MemoryRefKind::Wiki, user_id.clone(), workspace.clone())
        });
    let privacy_domain = if workspace.as_str() == PERSONAL_WORKSPACE {
        PrivacyDomain::new("personal")
    } else {
        PrivacyDomain::new("work")
    };
    let page = WikiPage {
        reference,
        user_id: user_id.clone(),
        workspace_id: workspace.clone(),
        path: path.to_string(),
        title: "Stato lavori".to_string(),
        body,
        linked_refs,
        privacy_domain,
        sensitivity: DataSensitivity::Internal,
    };
    let _ = facade.record_wiki_page_for_ui(&page);
}

/// Deduplica gli open-loop di uno scope (merge dei parafrasati in quello più
/// ricco). Spostata fedelmente dal gateway (`deduplicate_open_loops`).
pub fn deduplicate_open_loops(
    facade: &MemoryFacade,
    user_id: &UserId,
    workspace: &WorkspaceId,
) -> usize {
    let now_unix = unix_now();
    let mut loops: Vec<crate::MemoryRecord> = facade
        .list_memories_for_ui(user_id, workspace)
        .unwrap_or_default()
        .into_iter()
        .filter(|m| active_open_loop_record(m, now_unix))
        .collect();
    if loops.len() < 2 {
        return 0;
    }

    loops.sort_by_key(|m| std::cmp::Reverse(m.text.chars().count()));
    let lifecycle = MemoryLifecycleRequest {
        actor_id: "open-loop-dedup".to_string(),
        user_id: user_id.clone(),
        workspace_id: workspace.clone(),
        purpose: "deduplicate_open_loops".to_string(),
    };
    let mut kept: Vec<(MemoryRef, HashSet<String>)> = Vec::new();
    let mut merged = 0usize;
    for memory in loops {
        let tokens = dedup_tokens(&memory.text);
        if let Some((canonical, _)) = kept.iter().find(|(_, existing)| {
            jaccard(&tokens, existing) >= DEDUP_JACCARD
                || (tokens.len() >= 2 && tokens.is_subset(existing))
                || (existing.len() >= 2 && existing.is_subset(&tokens))
        }) {
            if facade
                .merge_memories(
                    &lifecycle,
                    canonical,
                    vec![memory.reference.clone()],
                    "open_loop duplicate/superseded",
                )
                .is_ok()
            {
                merged += 1;
            }
        } else {
            kept.push((memory.reference, tokens));
        }
    }
    merged
}

// ──────────────────────────────────────────────────────────────────────────
// consolidate_scope — 3 fasi Send-safe (F3)
// ──────────────────────────────────────────────────────────────────────────

/// Input della fase 2 (off-lock): i sopravvissuti del pre-pass deterministico +
/// il listing testuale per il LLM curatore. `mems` = `(MemoryRef, memory_type, text)`.
pub struct ConsolidateInput {
    /// Sopravvissuti del pre-pass deterministico (ordine originale).
    pub mems: Vec<(MemoryRef, String, String)>,
    /// Listing `[N] (type) text` per il prompt del curatore.
    pub listing: String,
}

/// Prompt di sistema del curatore memoria. Spostato fedelmente (byte-per-byte)
/// dal corpo di `consolidate_scope` del gateway.
pub const CURATOR_SYSTEM: &str = "You are a memory CURATOR. You receive the durable memories of a project/user, each \
with an index [N]. Tasks: (1) MERGE into ONE clear and complete sentence the fragments that say the \
SAME thing or aspects of the same thing; (2) DROP NOISE: transient, trivial, irrelevant information, \
with no future value, or left redundant after merging. Keep ONLY what is truly important and \
reusable. When in doubt, KEEP (do not drop). Do NOT invent: the merged sentence must derive only \
from the listed memories. Reply with JSON ONLY: \
{\"merges\":[{\"into\":\"consolidated sentence\",\"memory_type\":\"fact|preference|decision|goal\",\"importance\":0.0-1.0,\"from\":[indices]}],\
\"drops\":[{\"index\":N,\"reason\":\"why it is noise/irrelevant\"}]}. \
Each \"from\" must have AT LEAST 2 indices (it is a merge). \"importance\": 1=crucial, 0=negligible. \
If there is nothing to do: {\"merges\":[],\"drops\":[]}.";

/// Fase 1 (sync, lock): dedup open-loop + legge memorie/embedding/entity-set +
/// pre-pass deterministico (cancella le ridondanze) + costruisce il `listing`.
/// Ritorna `None` se <3 memorie sopravvivono (early-exit: ricostruisce le pagine
/// wiki). Spostato fedelmente dal corpo di `consolidate_scope` del gateway.
///
/// `is_edited` + `rebuild_wiki` sono callback iniettati dal gateway (il crate non
/// sa leggere i flag wiki-edited dal filesystem gateway): pattern = hooks di learn.
pub fn consolidate_prepare(
    facade: &MemoryFacade,
    user: &UserId,
    workspace: &WorkspaceId,
    is_edited: &dyn Fn(&WorkspaceId, &str) -> bool,
) -> (usize, Option<ConsolidateInput>) {
    let open_loop_merged = deduplicate_open_loops(facade, user, workspace);
    if open_loop_merged > 0 {
        rebuild_status_wiki(facade, user, workspace, is_edited);
    }

    // 1. Read the durable memories + their embeddings.
    let now_unix = unix_now();
    let mems: Vec<(MemoryRef, String, String)> = facade
        .list_memories_for_ui(user, workspace)
        .map(|memories| {
            memories
                .into_iter()
                .filter(|m| {
                    memory_is_current_at(m, now_unix, true)
                        && matches!(
                            m.memory_type.as_str(),
                            "fact" | "preference" | "decision" | "goal"
                        )
                })
                .map(|m| (m.reference, m.memory_type, m.text))
                .collect()
        })
        .unwrap_or_default();
    let embeddings: HashMap<String, Vec<f32>> = facade
        .list_embeddings(user, workspace)
        .map(|v| v.into_iter().map(|(r, vec)| (r.to_string(), vec)).collect())
        .unwrap_or_default();
    if mems.len() < 2 {
        return (open_loop_merged, None);
    }

    // 1a. STRUCTURAL signal: which entities each memory is linked to (mentions edges).
    let entity_sets: HashMap<String, BTreeSet<String>> = {
        let mut map: HashMap<String, BTreeSet<String>> = HashMap::new();
        for rel in facade
            .list_relations_for_ui(user, workspace)
            .unwrap_or_default()
        {
            if rel.relation_type == "mentions" {
                map.entry(rel.source_ref.to_string())
                    .or_default()
                    .insert(rel.target_ref.to_string());
            }
        }
        map
    };
    // Entity-name tokens (e.g. "jannik","sinner") so the structural check can
    // require shared content BEYOND the entity name itself.
    let entity_name_tokens: HashSet<String> = {
        let mut name_tokens: HashSet<String> = HashSet::new();
        for entity in facade
            .list_entities_for_ui(user, workspace)
            .unwrap_or_default()
        {
            for tok in dedup_tokens(&entity.name) {
                name_tokens.insert(tok);
            }
        }
        name_tokens
    };

    // 1b. DETERMINISTIC pre-pass: collapse obvious paraphrase/subset duplicates.
    let mut order: Vec<usize> = (0..mems.len()).collect();
    order.sort_by_key(|&i| std::cmp::Reverse(mems[i].2.chars().count()));
    let mut survivor_idx: Vec<usize> = Vec::new();
    type KeptMeta = (
        String,
        HashSet<String>,
        Option<Vec<f32>>,
        BTreeSet<String>,
    );
    let mut kept_meta: Vec<KeptMeta> = Vec::new();
    let mut redundant: Vec<MemoryRef> = Vec::new();
    for &i in &order {
        let (reference, mtype, text) = &mems[i];
        let tokens = dedup_tokens(text);
        let vector = embeddings.get(&reference.to_string()).cloned();
        let entset = entity_sets
            .get(&reference.to_string())
            .cloned()
            .unwrap_or_default();
        let duplicate = kept_meta.iter().any(|(kt, ktok, kvec, kent)| {
            kt == mtype
                && (jaccard(&tokens, ktok) >= DEDUP_JACCARD
                    || (tokens.len() >= 2 && tokens.is_subset(ktok))
                    || matches!((vector.as_ref(), kvec.as_ref()),
                        (Some(a), Some(b)) if cosine(a, b) >= DEDUP_COSINE)
                    // STRUCTURAL: same entity set (non-empty) AND ≥2 shared content
                    // tokens BEYOND the entity name.
                    || (!entset.is_empty()
                        && &entset == kent
                        && tokens
                            .intersection(ktok)
                            .filter(|t| !entity_name_tokens.contains(*t))
                            .count()
                            >= 2))
        });
        if duplicate {
            redundant.push(reference.clone());
        } else {
            survivor_idx.push(i);
            kept_meta.push((mtype.clone(), tokens, vector, entset));
        }
    }
    let mut merged = open_loop_merged;
    if !redundant.is_empty() {
        let lifecycle = MemoryLifecycleRequest {
            actor_id: "consolidation".to_string(),
            user_id: user.clone(),
            workspace_id: workspace.clone(),
            purpose: "consolidate".to_string(),
        };
        for reference in &redundant {
            if facade
                .delete_memory(&lifecycle, reference, "merged duplicate (consolidation)")
                .is_ok()
            {
                merged += 1;
            }
        }
    }
    // Survivors (original order) feed the LLM curator for the nuanced merges/drops.
    let mems: Vec<(MemoryRef, String, String)> =
        survivor_idx.into_iter().map(|i| mems[i].clone()).collect();
    if mems.len() < 3 {
        rebuild_decisions_wiki(facade, user, workspace, is_edited);
        rebuild_project_brief(facade, user, workspace, is_edited);
        rebuild_status_wiki(facade, user, workspace, is_edited);
        return (merged, None);
    }
    let listing = mems
        .iter()
        .enumerate()
        .map(|(i, (_, t, txt))| format!("[{i}] ({t}) {txt}"))
        .collect::<Vec<_>>()
        .join("\n");
    (merged, Some(ConsolidateInput { mems, listing }))
}

/// Fase 3 (sync, lock re-acquisito): applica i merge (create candidate + confirm
/// + delete from) e i drop (delete_memory) decisi dal curatore LLM, poi ricostruisce
/// le 3 pagine wiki. Ritorna `(merged, dropped)`. Spostato fedelmente dal corpo di
/// `consolidate_scope`.
///
/// `redact` è un callback (pattern = hooks): nel gateway è `redact_sensitive_text`
/// (pura, ma con molti caller gateway-side). `is_edited` pilota le pagine wiki.
pub fn consolidate_apply(
    facade: &MemoryFacade,
    user: &UserId,
    workspace: &WorkspaceId,
    root: &serde_json::Value,
    mems: &[(MemoryRef, String, String)],
    merged_so_far: usize,
    is_edited: &dyn Fn(&WorkspaceId, &str) -> bool,
    redact: &dyn Fn(&str) -> String,
) -> (usize, usize) {
    let merges = root
        .get("merges")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let drops = root
        .get("drops")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let mut merged = merged_so_far;
    let lifecycle = MemoryLifecycleRequest {
        actor_id: "consolidation".to_string(),
        user_id: user.clone(),
        workspace_id: workspace.clone(),
        purpose: "consolidate".to_string(),
    };
    let mut dropped = 0usize;
    for merge in &merges {
        let into = merge
            .get("into")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();
        let from: Vec<usize> = merge
            .get("from")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_u64().map(|n| n as usize))
                    .collect()
            })
            .unwrap_or_default();
        if into.is_empty() || from.len() < 2 {
            continue;
        }
        let memory_type = merge
            .get("memory_type")
            .and_then(|v| v.as_str())
            .unwrap_or("fact")
            .to_string();
        let importance = merge
            .get("importance")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.7);
        let created = facade.create_memory_candidate(crate::MemoryCreateRequest {
            request: lifecycle.clone(),
            memory_type,
            text: redact(into),
            aliases: Vec::new(),
            language_hints: Vec::new(),
            confidence: 1.0,
            privacy_domain: PrivacyDomain::new("work"),
            sensitivity: DataSensitivity::Internal,
            evidence_refs: Vec::new(),
            metadata: serde_json::json!({ "source": "consolidation", "importance": importance }),
        });
        if let Ok(record) = created {
            let _ = facade.confirm_memory(&lifecycle, &record.reference, "consolidated");
            for idx in &from {
                if let Some((reference, _, _)) = mems.get(*idx) {
                    let _ = facade.delete_memory(&lifecycle, reference, "merged in consolidation");
                }
            }
            merged += 1;
        }
    }
    for drop in &drops {
        let Some(idx) = drop
            .get("index")
            .and_then(|v| v.as_u64())
            .map(|n| n as usize)
        else {
            continue;
        };
        let reason = drop
            .get("reason")
            .and_then(|v| v.as_str())
            .unwrap_or("rumore/ininfluente");
        if let Some((reference, _, _)) = mems.get(idx) {
            if facade.delete_memory(&lifecycle, reference, reason).is_ok() {
                dropped += 1;
            }
        }
    }
    rebuild_decisions_wiki(facade, user, workspace, is_edited);
    rebuild_project_brief(facade, user, workspace, is_edited);
    rebuild_status_wiki(facade, user, workspace, is_edited);
    (merged, dropped)
}

/// Ricostruisce le 3 pagine wiki (decisioni/brief/stato-lavori). Helper per il
/// gateway quando il curatore LLM non risponde (early-exit path). Spostato
/// fedelmente dal ramo `None` di `consolidate_scope`.
pub fn rebuild_all_wiki(
    facade: &MemoryFacade,
    user: &UserId,
    workspace: &WorkspaceId,
    is_edited: &dyn Fn(&WorkspaceId, &str) -> bool,
) {
    rebuild_decisions_wiki(facade, user, workspace, is_edited);
    rebuild_project_brief(facade, user, workspace, is_edited);
    rebuild_status_wiki(facade, user, workspace, is_edited);
}
