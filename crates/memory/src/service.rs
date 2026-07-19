//! `MemoryRecallService` — il boundary contrattuale della memoria.
//!
//! Generalizza il pattern già introdotto in [`crate::vector_index`]
//! (`MemoryVectorIndex`) all'intero percorso memoria: nasconde l'orchestrazione
//! dietro una maniglia stretta, così il gateway detiene `Arc<dyn
//! MemoryRecallService>` invece di reach-are direttamente nel facade.
//!
//! Riferimenti:
//! - `docs/decisions/0022-memory-as-out-of-path-service.md` (ADR, Tappa 1)
//! - `docs/roadmap-fluidita-memoria.md` (piano master)
//! - `prompts/kickoff-memory-service.md` (brief operativo)
//!
//! # Tappa 1 — incapsulamento per delega
//!
//! Qui definiamo solo il **contratto** (tipi + trait). L'impl concreta
//! (`InProcessMemoryRecallService`) vive nel gateway, perché delega a funzioni
//! *del gateway* che questo crate non può vedere (freccia di dipendenza
//! one-way `desktop-gateway → memory`). Nessuna funzione viene migrata in questa
//! tappa: l'estrazione vera è la Tappa 4.
//!
//! # Shape scope-dipendente (invariant P1)
//!
//! Il briefing canonico è **always-on** ma la sua shape dipende dallo scope:
//! - `Project`: ricco (profile memory + objective + brief + recent_work) — qui
//!   vive la continuità cross-chat, la proposta di valore di Homun.
//! - `Personal`: snello (solo preferenze + pochi fatti stabili), NON "riprendi
//!   tutto ciò che so". La cross-chat è una feature dei progetti, non del
//!   Personale.
//!
//! L'isolamento Personale↔Progetto è un invariant: il `scope` è argomento del
//! trait, non globale, e nessuna recall cross-scope accidentale è possibile.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Mutex, OnceLock};

use crate::{
    DataSensitivity, MemoryCollectionKey, MemoryFacade, MemoryScope, MemoryStatus, UserId,
    WorkspaceId,
};

/// Un blocco di testo già formattato pronto da accodare al system prompt.
///
/// I blocchi sono `Option`: `None` = "nulla da iniettare questo turno". L'ordine
/// di [`BriefingPack::ordered_blocks`] è fisso e coincide con quello in cui il
/// gateway assembla il system prompt.
pub type SystemBlock = Option<String>;

/// Briefing canonico always-on — ciò che l'agente *sa stabilmente* dello scope.
///
/// Tappa 1 incapsula la sequenza di assemblaggio del gateway (i blocchi
/// `gather_profile_memory_for_prompt` + `format_memory_block`,
/// `project_objective_block`, `project_brief_block`, `recent_work_block`) in una
/// struct con ordine deterministico.
///
/// La shape è **intrinsecamente snella per `MemoryScope::Personal`**: i blocchi
/// objective/brief/recent_work sono sempre `None` nello scope Personale (non è
/// una "memoria di lavoro" cross-chat). Questo realizza l'invariant P1 senza
/// cambiare il behaviour esistente.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BriefingPack {
    /// Profile memory + open loops (personal preferences / project scope memory),
    /// già budgetizzato. Sempre presente per entrambi gli scope.
    pub profile_block: SystemBlock,
    /// North-star objective del progetto. `None` per `Personal`.
    pub objective: SystemBlock,
    /// Stato/recenti decisioni del progetto (`brief.md`). `None` per `Personal`.
    pub brief: SystemBlock,
    /// Ultimi commit del progetto. `None` per `Personal`.
    pub recent_work: SystemBlock,
}

impl BriefingPack {
    /// I blocchi non-`None` nell'ordine canonico di assemblaggio del system
    /// prompt (profile → objective → brief → recent_work). È l'ordine che il
    /// gateway usa oggi (`main.rs:19476-19509`); mantenerlo è prerequisito del
    /// test di parità.
    pub fn ordered_blocks(&self) -> Vec<SystemBlock> {
        vec![
            self.profile_block.clone(),
            self.objective.clone(),
            self.brief.clone(),
            self.recent_work.clone(),
        ]
    }
}

/// Un singolo hit di recall RAG episodico.
///
/// In Tappa 1 questo tipo è definito ma non ancora popolato: la recall delega
/// a `relevant_memory_for_prompt` che restituisce un `block: Option<String>`
/// (testo fuso). La popolazione strutturata degli `hits` (con `score`/`kind`)
/// arriva in Tappa 3, quando la recall emette anche eventi tipizzati (UI A1).
#[derive(Debug, Clone, PartialEq)]
pub struct RecallHit {
    /// Riferimento stabile del record memoria.
    pub memory_ref: String,
    /// Testo/summary del record.
    pub text: String,
    /// Score ibrido (RRF + importance + recency), normalizzato [0.0, 1.0].
    pub score: f32,
    /// `memory_type` del record (`decision`/`fact`/`goal`/`preference`/…).
    pub kind: String,
    /// Scope canonico della fonte da cui proviene l'hit.
    pub source_user_id: UserId,
    pub source_workspace_id: WorkspaceId,
    /// Etichetta sicura mostrabile nel prompt e nella UI.
    pub source_label: String,
    /// Raccolta di sistema che ha autorizzato/classificato il record.
    pub collection: MemoryCollectionKey,
    /// Grant che autorizza una fonte collegata; `None` per la fonte locale.
    pub grant_id: Option<String>,
    /// Versione esatta della policy del grant usata per produrre l'hit.
    /// `None` per la fonte locale implicita.
    pub policy_version: Option<u64>,
    pub sensitivity: DataSensitivity,
    pub status: MemoryStatus,
    pub updated_at: String,
    /// Identità semantica esplicita, mai inferita dal testo libero.
    pub subject_key: Option<String>,
    /// Marcato dai task di merge quando due hit restano in conflitto.
    pub conflict: bool,
    /// Identita del collegamento di pubblicazione, quando disponibile. Due copie
    /// che condividono questo valore rappresentano la stessa conoscenza canonica.
    pub publication_link: Option<String>,
    /// Relazioni canoniche percorse dal seed fino a questo hit. Vuoto per gli
    /// hit trovati direttamente dalla query.
    pub graph_path: Vec<String>,
}

/// Risultato della recall RAG episodica — contesto *mirato* alla query.
///
/// A differenza di [`BriefingPack`] (always-on, stabile), la recall è
/// **on-demand**: il loop decide quando chiamarla (Tappa 3). In Tappa 1 il
/// service popola solo [`RecallPack::block`] (l'output testuale di
/// `relevant_memory_for_prompt`); [`RecallPack::hits`] resta vuoto e viene
/// riempito in Tappa 3 (emissione eventi tipizzati per la UI).
#[derive(Debug, Clone)]
pub struct RecallPack {
    /// La query originale (per tracing/UI).
    pub query: String,
    /// Scope isolato in cui è avvenuta la recall (invariant: mai cross-scope).
    pub scope: MemoryScope,
    /// Hits strutturati. **Vuoto in Tappa 1** — vedi sopra.
    pub hits: Vec<RecallHit>,
    /// Blocco testuale già formattato per il system prompt, oppure `None` se
    /// la recall non ha surface-ato nulla. In Tappa 1 è l'unico campo pieno.
    pub block: Option<String>,
    /// Fonti non locali che non hanno contribuito, con soli reason code sicuri.
    pub degraded_sources: Vec<(WorkspaceId, String)>,
}

impl RecallPack {
    /// Costruisce un `RecallPack` dalla sola `block` testuale (caso Tappa 1).
    pub fn from_block(query: impl Into<String>, scope: MemoryScope, block: Option<String>) -> Self {
        Self {
            query: query.into(),
            scope,
            hits: Vec::new(),
            block,
            degraded_sources: Vec::new(),
        }
    }

    /// Costruisce prompt e output strutturato dalla stessa lista di hit, così
    /// provenienza e testo iniettato non possono divergere.
    pub fn from_hits(query: String, scope: MemoryScope, hits: Vec<RecallHit>) -> Self {
        let block = format_recall_hits(&hits);
        Self {
            query,
            scope,
            hits,
            block,
            degraded_sources: Vec::new(),
        }
    }

    pub fn from_hits_and_degraded(
        query: String,
        scope: MemoryScope,
        hits: Vec<RecallHit>,
        degraded_sources: Vec<(WorkspaceId, String)>,
    ) -> Self {
        let block = format_recall_hits(&hits);
        Self {
            query,
            scope,
            hits,
            block,
            degraded_sources,
        }
    }
}

/// Compatibility path used when linked memory sources are disabled. Keeping it
/// beside the structured pack makes the gateway's service-ON and service-OFF
/// paths choose between exactly the same two coordinators.
pub fn recall_single_scope_pack(
    facade: &MemoryFacade,
    user: &UserId,
    workspace: &WorkspaceId,
    query: &str,
    query_vec: &[f32],
    graph_context: Option<
        &(dyn Fn(&MemoryFacade, &UserId, &WorkspaceId, &str) -> Option<String> + Sync),
    >,
) -> RecallPack {
    let block =
        crate::recall_search_on_facade(facade, user, workspace, query, query_vec, graph_context);
    let scope = if workspace.as_str() == crate::PERSONAL_WORKSPACE {
        MemoryScope::Personal
    } else {
        MemoryScope::Project(workspace.clone())
    };
    RecallPack::from_block(query, scope, block)
}

pub fn format_recall_hits(hits: &[RecallHit]) -> Option<String> {
    if hits.is_empty() {
        return None;
    }
    let normal = hits
        .iter()
        .filter(|hit| !hit.conflict)
        .map(format_recall_hit)
        .collect::<Vec<_>>();
    let conflicting = hits
        .iter()
        .filter(|hit| hit.conflict)
        .map(format_recall_hit)
        .collect::<Vec<_>>();
    let mut sections = Vec::new();
    if !normal.is_empty() {
        sections.push(format!("RELEVANT MEMORY:\n{}", normal.join("\n")));
    }
    if !conflicting.is_empty() {
        sections.push(format!(
            "CONFLICTING MEMORY (do not merge silently):\n{}",
            conflicting.join("\n")
        ));
    }
    Some(sections.join("\n\n"))
}

fn format_recall_hit(hit: &RecallHit) -> String {
    if hit.graph_path.is_empty() {
        format!("- [source: {}] {}", hit.source_label, hit.text)
    } else {
        format!(
            "- [source: {}; graph: {}] {}",
            hit.source_label,
            hit.graph_path.join(" -> "),
            hit.text
        )
    }
}

/// Uno scambio completo turno utente↔assistente, input di [`MemoryRecallService::learn`].
///
/// Incapsula i parametri di `learn_from_exchange` del gateway. I campi
/// opzionali coprono i call site esistenti (thread_id, attribuzione speaker
/// per i canali, prev_assistant per groundare le conferme).
#[derive(Debug, Clone, Default)]
pub struct Exchange {
    /// Messaggio utente del turno.
    pub user_message: String,
    /// Risposta assistente del turno.
    pub assistant_message: String,
    /// Traccia azioni del turno (newline-joined), per apprendere anche dal fare.
    pub actions: String,
    /// Thread/conversazione di appartenenza, quando noto.
    pub thread_id: Option<String>,
    /// Attribuzione canale/contatto (es. messaggio in arrivo), quando applicabile.
    pub speaker: Option<String>,
    /// Risposta assistente del turno precedente, per groundare le conferme.
    pub prev_assistant: Option<String>,
}

/// Alias per un future boxed `Send` — serve a rendere il trait object-safe
/// senza `async_trait` (il repo non lo usa; edition 2024).
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Boundary contrattuale della memoria (ADR 0022, Tappa 1).
///
/// Nasconde l'orchestrazione memoria dietro tre maniglie strette:
///
/// - [`brief`](MemoryRecallService::brief) — briefing canonico **always-on**,
///   chiamato OGNI turno. Shape scope-dipendente (ricco per `Project`, snello
///   per `Personal`). NON va off-path; è bounded e cacheabile (Tappa 1.5).
/// - [`recall`](MemoryRecallService::recall) — recall RAG episodico
///   **on-demand**, mirato alla query. Rispetta l'isolamento scope.
/// - [`learn`](MemoryRecallService::learn) — scrittura post-turno, asincrona.
///
/// # Object safety
///
/// `recall`/`learn` sono asincrone (fanno chiamate HTTP di embedding) ma il
/// trait deve essere istanziabile come `Arc<dyn MemoryRecallService>`. Per
/// restare object-safe senza `async_trait`, i metodi async ritornano
/// [`BoxFuture`] (boxed futures) invece di usare `async fn` in trait.
pub trait MemoryRecallService: Send + Sync {
    /// Briefing canonico always-on per lo scope dato. Sync: non fa I/O di rete,
    /// solo letture dal facade (lock + scan locali).
    ///
    /// `user_message` è necessario perché il briefing attuale è **prompt-dipendente**:
    /// per reply brevi ("ok", "va bene") il profile-memory inietta *solo*
    /// preferenze, e gli open-loops si iniettano solo per messaggi non-brevi
    /// (predicati `*_for_prompt` del gateway). Passare il prompt al service è il
    /// modo per realizzare la parità "comportamento identico" del DoD senza
    /// duplicare i predicati fuori dal service.
    fn brief(&self, scope: &MemoryScope, user_message: &str) -> BriefingPack;

    /// Recall RAG episodico on-demand per `query` nello scope dato. Async:
    /// include la query embedding HTTP (cached, con degradazione).
    fn recall<'a>(&'a self, query: &'a str, scope: &'a MemoryScope) -> BoxFuture<'a, RecallPack>;

    /// Scrittura post-turno (estrazione + persistenza). Async: chiama il
    /// modello estrattore.
    fn learn<'a>(&'a self, exchange: &'a Exchange, scope: &'a MemoryScope) -> BoxFuture<'a, ()>;
}

// ──────────────────────────────────────────────────────────────────────────
// Tappa 1.5 — cache del briefing always-on
// ──────────────────────────────────────────────────────────────────────────

/// ADR 0022 (Tappa 1.5) — entry della cache del briefing per uno scope.
///
/// Memorizza i blocchi **cached** del briefing (profile + objective + brief;
/// `recent_work` NON è qui perché dipende da git log, non dalla memoria, e va
/// ricalcolato fresco ogni `brief()`). L'invalidazione include sia la generation
/// locale sia il fingerprint delle fonti effettivamente usate; il prompt resta
/// parte della chiave perché profile/open-loops sono prompt-dipendenti.
#[derive(Debug, Clone)]
pub struct CachedBriefing {
    /// Generation del facade al momento del rebuild. Se diverge da quella
    /// corrente → il contenuto dello scope è cambiato → cache miss.
    pub generation: u64,
    /// Policy effettiva + generation delle fonti usate dal briefing. Revoca,
    /// scadenza, modifica grant o scrittura in una source → cache miss.
    pub source_fingerprint: u64,
    /// Fingerprint del `user_message` (hash) al momento del rebuild. I blocchi
    /// profile + open-loops dipendono dal prompt (gating `should_inject_*`):
    /// prompt diverso → cache miss anche se la generation combacia.
    pub prompt_fingerprint: u64,
    /// I 3 blocchi cached (profile/objective/brief). `recent_work` è `None` qui
    /// e viene ricalcolato a ogni `brief()`.
    pub pack_sans_recent_work: BriefingPack,
}

/// ADR 0022 (Tappa 1.5) — cache process-global del briefing, keyed per scope.
///
/// Singleton via [`OnceLock`] (stesso pattern di `memory_query_embedding_cache`
/// nel gateway). Condivisa tra tutti i `brief()` concorrenti. L'eviction è LRU
/// su `max_entries` (knob `HOMUN_BRIEFING_CACHE_MAX`, default 64 scope).
pub struct BriefingCache {
    entries: Mutex<HashMap<String, CachedBriefing>>,
    max_entries: usize,
}

impl BriefingCache {
    pub fn new(max_entries: usize) -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            max_entries,
        }
    }

    /// Lookup: hit solo se tutti i fingerprint combaciano.
    /// Ritorna un clone dei blocchi cached (senza recent_work).
    pub fn get(
        &self,
        scope_key: &str,
        generation: u64,
        source_fingerprint: u64,
        prompt_fingerprint: u64,
    ) -> Option<BriefingPack> {
        let entries = self.entries.lock().ok()?;
        let entry = entries.get(scope_key)?;
        if entry.generation == generation
            && entry.source_fingerprint == source_fingerprint
            && entry.prompt_fingerprint == prompt_fingerprint
        {
            Some(entry.pack_sans_recent_work.clone())
        } else {
            None
        }
    }

    /// Inserisce/aggiorna l'entry per uno scope. Se la cache è piena, evicta
    /// l'entry più vecchia (FIFO — semplice; la mutabilità bassa rende l'hit
    /// rate alto anche senza LRU vero).
    pub fn put(&self, scope_key: String, entry: CachedBriefing) {
        if let Ok(mut entries) = self.entries.lock() {
            // Eviction: se pieni, rimuovi una entry arbitraria (HashMap non
            // ordina; per Tappa 1.5 basta bounded — il vero LRU è overkill dato
            // l'alto hit rate). Iteratore + next() = O(1) ammortizzato.
            if entries.len() >= self.max_entries && !entries.contains_key(&scope_key) {
                if let Some(stale_key) = entries.keys().next().cloned() {
                    entries.remove(&stale_key);
                }
            }
            entries.insert(scope_key, entry);
        }
    }
}

/// Accessore singleton della cache process-global. Stesso pattern di
/// `memory_query_embedding_cache` nel gateway.
pub fn briefing_cache() -> &'static BriefingCache {
    static CACHE: OnceLock<BriefingCache> = OnceLock::new();
    CACHE.get_or_init(|| BriefingCache::new(briefing_cache_max_entries()))
}

fn briefing_cache_max_entries() -> usize {
    std::env::var("HOMUN_BRIEFING_CACHE_MAX")
        .ok()
        .and_then(|value| value.trim().parse().ok())
        .filter(|value: &usize| *value > 0)
        .unwrap_or(64)
}

/// Fingerprint stabile di un prompt (hash 64-bit). Usato come parte della chiave
/// di cache: prompt diverso → cache miss (i blocchi profile/open-loops sono
/// prompt-dipendenti). Implementazione FNV-1a 64 (nessuna dipendenza esterna).
pub fn prompt_fingerprint(prompt: &str) -> u64 {
    // FNV-1a offset basis (64-bit).
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in prompt.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

// ──────────────────────────────────────────────────────────────────────────
// Test della cache (Tappa 1.5)
// ──────────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod cache_tests {
    use super::*;

    fn empty_pack() -> BriefingPack {
        BriefingPack {
            profile_block: None,
            objective: None,
            brief: None,
            recent_work: None,
        }
    }

    #[test]
    fn cache_hits_when_generation_and_fingerprint_match() {
        let cache = BriefingCache::new(4);
        let entry = CachedBriefing {
            generation: 7,
            source_fingerprint: 11,
            prompt_fingerprint: 42,
            pack_sans_recent_work: empty_pack(),
        };
        cache.put("scope-1".to_string(), entry);
        assert!(
            cache.get("scope-1", 7, 11, 42).is_some(),
            "hit quando generation e fingerprint combaciano"
        );
    }

    #[test]
    fn cache_misses_when_source_fingerprint_differs() {
        let cache = BriefingCache::new(4);
        cache.put(
            "scope-1".to_string(),
            CachedBriefing {
                generation: 7,
                source_fingerprint: 11,
                prompt_fingerprint: 42,
                pack_sans_recent_work: empty_pack(),
            },
        );
        assert!(
            cache.get("scope-1", 7, 12, 42).is_none(),
            "una modifica a grant o source deve invalidare il briefing"
        );
    }

    #[test]
    fn cache_misses_when_generation_differs() {
        let cache = BriefingCache::new(4);
        cache.put(
            "scope-1".to_string(),
            CachedBriefing {
                generation: 7,
                source_fingerprint: 11,
                prompt_fingerprint: 42,
                pack_sans_recent_work: empty_pack(),
            },
        );
        // Una scrittura ha incrementato la generation nel facade → miss.
        assert!(
            cache.get("scope-1", 8, 11, 42).is_none(),
            "miss quando la generation diverge (scrittura invalida)"
        );
    }

    #[test]
    fn cache_misses_when_prompt_fingerprint_differs() {
        let cache = BriefingCache::new(4);
        cache.put(
            "scope-1".to_string(),
            CachedBriefing {
                generation: 7,
                source_fingerprint: 11,
                prompt_fingerprint: 42,
                pack_sans_recent_work: empty_pack(),
            },
        );
        // Prompt diverso (gating should_inject_* diverso) → miss.
        assert!(
            cache.get("scope-1", 7, 11, 999).is_none(),
            "miss quando il prompt cambia (blocchi prompt-dipendenti)"
        );
    }

    #[test]
    fn cache_evicts_when_full() {
        let cache = BriefingCache::new(2);
        cache.put(
            "a".to_string(),
            CachedBriefing {
                generation: 1,
                source_fingerprint: 1,
                prompt_fingerprint: 1,
                pack_sans_recent_work: empty_pack(),
            },
        );
        cache.put(
            "b".to_string(),
            CachedBriefing {
                generation: 1,
                source_fingerprint: 1,
                prompt_fingerprint: 1,
                pack_sans_recent_work: empty_pack(),
            },
        );
        // Terza entry → eviction (bounded).
        cache.put(
            "c".to_string(),
            CachedBriefing {
                generation: 1,
                source_fingerprint: 1,
                prompt_fingerprint: 1,
                pack_sans_recent_work: empty_pack(),
            },
        );
        // Almeno una delle prime due è stata evicta; la terza è presente.
        assert!(
            cache.get("c", 1, 1, 1).is_some(),
            "la nuova entry è presente"
        );
        let present = ["a", "b"]
            .iter()
            .filter(|k| cache.get(k, 1, 1, 1).is_some())
            .count();
        assert!(
            present <= 1,
            "bounded: al massimo max_entries entry coesistono"
        );
    }

    #[test]
    fn cache_put_refreshes_existing_key_without_evicting() {
        let cache = BriefingCache::new(2);
        cache.put(
            "a".to_string(),
            CachedBriefing {
                generation: 1,
                source_fingerprint: 1,
                prompt_fingerprint: 1,
                pack_sans_recent_work: empty_pack(),
            },
        );
        // Re-put della stessa key (refresh) NON deve evictare un'altra entry.
        cache.put(
            "a".to_string(),
            CachedBriefing {
                generation: 2,
                source_fingerprint: 1,
                prompt_fingerprint: 1,
                pack_sans_recent_work: empty_pack(),
            },
        );
        assert!(
            cache.get("a", 2, 1, 1).is_some(),
            "refresh aggiorna la entry"
        );
        assert!(
            cache.get("a", 1, 1, 1).is_none(),
            "la vecchia generation è invalidata"
        );
    }

    #[test]
    fn prompt_fingerprint_is_stable_and_distinct() {
        assert_eq!(prompt_fingerprint("ciao"), prompt_fingerprint("ciao"));
        assert_ne!(prompt_fingerprint("ciao"), prompt_fingerprint("hello"));
        assert_ne!(prompt_fingerprint(""), prompt_fingerprint("a"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::WorkspaceId;
    /// L'ordine canonico di `ordered_blocks()` deve essere [profile, objective,
    /// brief, recent_work] — identico all'assemblaggio del system prompt nel
    /// gateway. È il prerequisito del test di parità Tappa 1: se cambia l'ordine,
    /// il system prompt cambia.
    #[test]
    fn briefing_pack_ordered_blocks_has_canonical_order() {
        let pack = BriefingPack {
            profile_block: Some("PROFILE".to_string()),
            objective: Some("OBJECTIVE".to_string()),
            brief: Some("BRIEF".to_string()),
            recent_work: Some("RECENT".to_string()),
        };
        let ordered: Vec<String> = pack.ordered_blocks().into_iter().flatten().collect();
        assert_eq!(ordered, vec!["PROFILE", "OBJECTIVE", "BRIEF", "RECENT"]);
    }

    /// Invariant P1 — shape snella per Personal: un `BriefingPack` costruito per
    /// lo scope Personal deve poter avere objective/brief/recent_work a `None`.
    /// La *garanzia* che siano None deriva dal fatto che i blocchi `project_*`
    /// del gateway ritornano None per PERSONAL_WORKSPACE; qui verifichiamo che la
    /// struct del contratto lo rappresenti correttamente (un pack Personal è
    /// ben formato con solo il profile_block).
    #[test]
    fn briefing_pack_personal_shape_is_well_formed_with_profile_only() {
        let pack = BriefingPack {
            profile_block: Some("- preferenza: risposte in italiano".to_string()),
            objective: None,
            brief: None,
            recent_work: None,
        };
        // Per Personal, solo il profile_block contribuisce al prompt.
        let non_empty: Vec<String> = pack.ordered_blocks().into_iter().flatten().collect();
        assert_eq!(
            non_empty.len(),
            1,
            "Personal briefing deve avere shape snella"
        );
        assert_eq!(non_empty[0], "- preferenza: risposte in italiano");
    }

    /// I blocchi `None` vengono saltati senza interrompere la sequenza —
    /// l'assemblaggio del system prompt deve accodare solo i blocchi presenti.
    #[test]
    fn briefing_pack_ordered_blocks_skips_none_without_reordering() {
        let pack = BriefingPack {
            profile_block: None,
            objective: Some("OBJECTIVE".to_string()),
            brief: None,
            recent_work: Some("RECENT".to_string()),
        };
        let ordered: Vec<String> = pack.ordered_blocks().into_iter().flatten().collect();
        assert_eq!(ordered, vec!["OBJECTIVE", "RECENT"]);
    }

    /// `RecallPack::from_block` (caso Tappa 1) lascia `hits` vuoto e riporta
    /// scope + block. La popolazione degli hits strutturati è Tappa 3.
    #[test]
    fn recall_pack_from_block_tappa1_carries_scope_and_block_only() {
        let scope = MemoryScope::Project(WorkspaceId::new("proj-1"));
        let pack = RecallPack::from_block(
            "qual è la decisione sul DB?",
            scope.clone(),
            Some("MEMORY RELEVANT…".to_string()),
        );
        assert_eq!(pack.query, "qual è la decisione sul DB?");
        assert_eq!(pack.scope, scope);
        assert!(pack.hits.is_empty(), "hits si popolano in Tappa 3");
        assert_eq!(pack.block.as_deref(), Some("MEMORY RELEVANT…"));
    }

    /// `RecallPack` vuoto (recall non ha surface-ato nulla) resta ben formato.
    #[test]
    fn recall_pack_from_block_handles_none() {
        let pack = RecallPack::from_block("q", MemoryScope::Personal, None);
        assert!(pack.block.is_none());
        assert!(pack.hits.is_empty());
    }

    /// Verifica object-safety: il trait deve essere istanziabile come
    /// `Arc<dyn MemoryRecallService>` (requisito del DoD). Se questo compila, i
    /// boxed future rendono il trait object-safe senza `async_trait`.
    #[test]
    fn memory_recall_service_is_object_safe() {
        #[allow(dead_code)]
        fn accept_dyn(_svc: std::sync::Arc<dyn MemoryRecallService>) {}
        // Se la firma qui sopra tipa, il trait è object-safe.
    }
}
