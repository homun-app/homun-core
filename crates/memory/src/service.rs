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

use std::future::Future;
use std::pin::Pin;

use crate::MemoryScope;

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
}

impl RecallPack {
    /// Costruisce un `RecallPack` dalla sola `block` testuale (caso Tappa 1).
    pub fn from_block(query: impl Into<String>, scope: MemoryScope, block: Option<String>) -> Self {
        Self {
            query: query.into(),
            scope,
            hits: Vec::new(),
            block,
        }
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
        let ordered: Vec<String> = pack
            .ordered_blocks()
            .into_iter()
            .flatten()
            .collect();
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
        let non_empty: Vec<String> = pack
            .ordered_blocks()
            .into_iter()
            .flatten()
            .collect();
        assert_eq!(non_empty.len(), 1, "Personal briefing deve avere shape snella");
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
        let ordered: Vec<String> = pack
            .ordered_blocks()
            .into_iter()
            .flatten()
            .collect();
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

