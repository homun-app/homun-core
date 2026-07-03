# Turn-trace observability — design

Data: 2026-07-03. Stato: **approvato** (brainstorming). Prossimo: writing-plans.

## Problema

Quando un turno di chat si comporta male (es. l'agente naviga bene ma consegna una risposta senza il
deliverable richiesto e dichiara il falso — vedi il caso "cerca notizie in tabella" del 2026-07-03),
**non abbiamo un modo leggibile di vedere cosa è successo in quel turno**. L'osservabilità P0 esiste ma
è frammentata:
- `~/.homun/logs/gateway.log` — righe `eprintln!` sparse (`[plan] …`, `[answer] …`, `browser-step`),
  utili ma da grep+correlare a mano;
- `tool_trace_dump` → `tool-trace.jsonl` — un **oracolo di parità** per l'estrazione motore (ADR 0024):
  hashato (args/result → FNV), `result_head` a 120 char, gated da `HOMUN_TRACE_DUMP=1`. **Non** è per il
  debug umano.

Diagnosticare il caso sopra ha richiesto archeologia (grep del log + pull del messaggio persistito via
API + correlazione manuale). Serve un **trace di turno leggibile** che racconti in un colpo: round,
finish_reason, transizioni piano (e il verify-hold), decisione reconcile, fingerprint della risposta, e
**segnali derivati** (deliverable mancante / step incompleti / done-senza-artefatto).

Questo è l'osservabilità Codex-parity (`confronto-codex-produzione.md`, P0 = osservabilità) sul pezzo che
manca: *capire un turno*.

## Scope

- **Dentro**: eventi del **loop di chat** (`stream_chat_via_openai`) — ragionamento/round, piano,
  reconcile, risposta finale + segnali derivati.
- **Fuori** (non-goal in questo spec): eventi fuori dal loop (recall memoria, consolidation); una vista
  in-app ("Turn inspector") — è un follow-on che consumerà questo file; l'oracolo di parità
  (`tool_trace_dump`) resta separato e invariato.
- **Consumo**: un file **leggibile** `turn-trace.jsonl` che si segue con `tail -f` durante il retest.

## Approccio: A — recorder `TurnTrace` locale nel loop → JSONL leggibile

Scartati (in `docs`): **B** (`tracing` crate — adozione pesante, over-engineering) e **C** (estendere
`tool_trace_dump` — inquina l'oracolo di parità hashato con uno scopo diverso; una responsabilità per
unità).

## Design

### Unità e confini

1. **Modulo `turn_trace` (nuovo)** — `crates/desktop-gateway/src/turn_trace.rs`. Puro + I/O di append,
   niente `AppState`. Mirror del pattern `tool_trace_dump` (append di righe JSON a un file nella logs
   dir) ma **leggibile** (non hashato) e **turn-scoped**. Responsabilità unica: definire gli eventi e
   scriverli.

2. **Tipi evento** (serde). Ogni evento è una riga JSON con campi comuni `{turn_id, seq, t_ms, kind}` +
   payload per `kind`:
   - `turn_start` — `{ prompt_head: String (≤200 char), prompt_len: usize, mode: String, model: String, tier: String }`
   - `round` — `{ round: usize, finish_reason: String, tool_calls: Vec<String> (nomi), content_delta_len: usize }`
   - `plan` — `{ op: String ("update_plan"|"step_advance"), sent: Vec<String>, canonical: Vec<String> }`
     (le due liste di status rendono visibile il **verify-hold**: `sent=done` ma `canonical=doing`)
   - `nudge` — `{ reason: String, next_step: String }`
   - `forced_synthesis` — `{ finish_reason: String }`
   - `reconcile` — `{ fired: bool, step: String, open_steps: usize, delivered_chars: usize, threshold: usize }`
   - `turn_end` — `{ final_len: usize, plan_final: Vec<String>, signals: AnswerSignals, derived: DerivedFlags }`

3. **Helper puri (testabili, cuore del valore)**:
   - `answer_signals(text: &str, artifact_count: usize) -> AnswerSignals` →
     `{ has_table: bool, sources_count: usize, artifact_count: usize }`. `has_table` = presenza di una
     tabella markdown (`^\s*\|.*\|` su ≥2 righe consecutive); `sources_count` = link in una sezione
     "Sources"/"Fonti" (o conteggio URL).
   - `derive_flags(plan_final: &[String], signals: &AnswerSignals, plan_titles: &[String]) -> DerivedFlags`
     → `{ incomplete_steps: usize, claimed_done_without_artifact: bool }`.
     - `incomplete_steps` = quanti step in `plan_final` non sono `done`.
     - `claimed_done_without_artifact` = **true** se ESISTE uno step il cui titolo implica un artefatto
       (match case-insensitive su `tabella|table|file|deck|presentazione|documento|report|grafico|chart`)
       ed è marcato/atteso come consegnato **ma** il segnale corrispondente è assente (es. titolo dice
       "tabella" e `has_table==false`; `artifact_count==0` per file/deck). È il flag che avrebbe segnalato
       subito il bug del 2026-07-03.

4. **`append(dir, event)`** — serializza una riga JSON e la appende a `<dir>/turn-trace.jsonl`
   (best-effort, non-panica mai: errori I/O ignorati, come `tool_trace_dump::append`).

### Recorder + wiring

- Un `TurnTrace` locale creato in cima a `stream_chat_via_openai`: tiene `turn_id` (= `request_id` del
  turno, già disponibile), la logs dir (`gateway_logs_dir()`), un contatore `seq`, e lo `start_instant`
  (per `t_ms`). Metodo `record(&mut self, kind_payload)` che incrementa `seq`, calcola `t_ms` e chiama
  `append`.
- Chiamate `trace.record(...)` **accanto** agli `eprintln!` esistenti ai punti chiave, tutti dentro
  `stream_chat_via_openai` (basso rischio, additivo):
  - `turn_start`: all'ingresso del turno (dopo aver risolto `mode`/`model`/`tier`).
  - `round`: nel `for round in 0..hard_round_ceiling()` (`main.rs:24048`), dopo il parse della risposta
    del modello (finish_reason + tool_calls noti lì).
  - `plan`: dove oggi si logga `[plan] update_plan: sent[…] → canonical[…]`.
  - `nudge` / `forced_synthesis`: ai due path esistenti (`plan_nudges`, `[answer] … → forced synthesis`).
  - `reconcile`: al blocco F2.2 (`main.rs:24901`), con `fired` e gli input di `answer_concludes_plan`.
  - `turn_end`: alla finalizzazione, con `answer_signals`/`derive_flags` calcolati sul contenuto finale.
- **Nessun** threading di un writer attraverso firme profonde: tutti i punti sono nella stessa funzione
  (o in helper che già ricevono il contesto del turno).

### Attivazione / privacy / bound

- **Always-on** (dev e prod): il file vive **solo in locale** (`~/.homun/logs/`), stessa sensibilità del
  chat store che già contiene i messaggi interi. Contenuto **troncato** (`prompt_head` ≤200 char; nessun
  answer-body intero — solo `final_len` + segnali). Nessun secret nel trace.
- **Bound/rotazione**: cap dimensione file (es. `HOMUN_TURN_TRACE_MAX_BYTES`, default ~5 MB) → truncate/
  rotate `turn-trace.jsonl`→`turn-trace.jsonl.1` alla soglia. (Meccanica semplice: dettaglio nel plan.)
- **Opt-out**: `HOMUN_TURN_TRACE=0`/`off` disattiva (default on). Coerente col pattern flag esistente.

### Error handling

- `append` best-effort: un errore I/O non deve mai far fallire il turno (mirror `tool_trace_dump`).
- `gateway_logs_dir()` non risolvibile → il trace è no-op silenzioso (il turno procede normale).
- Helper puri totali: input malformi → default sicuri (es. plan vuoto → `incomplete_steps:0`).

## Testing

- **Unit (helper puri)**:
  - `answer_signals`: testo con tabella markdown → `has_table:true`; prosa+Sources → `has_table:false`,
    `sources_count>0`; conteggio artefatti passthrough.
  - `derive_flags`: step "Compilare **tabella** finale" + `has_table:false` → `claimed_done_without_artifact:true`;
    con tabella presente → `false`; step aperti contati; nessuno step-artefatto → `false`.
  - `append` non-panica su dir inesistente/permessi (come `tool_trace_dump::append_never_panics`).
- **Runtime (validare eseguendo, il retest illuminato)**: rifare "cerca ultime notizie … in una tabella"
  sul dev app → `turn-trace.jsonl` deve contenere, per quel `turn_id`: una sequenza `round` con
  finish_reason; `plan` con sent≠canonical (verify-hold); `reconcile{fired:true, step:"Compilare tabella…"}`;
  `turn_end.derived.claimed_done_without_artifact:true` + `incomplete_steps≥1`. Cioè: il trace **racconta**
  esattamente il bug che stamattina ho ricostruito a mano.

## Caposaldi

- Converge sulla logs dir esistente (`gateway_logs_dir`), **non** un terzo store; **non** tocca l'oracolo
  di parità `tool_trace_dump` (una responsabilità per unità) — caposaldo #5.
- Local-first + privacy: solo-locale, contenuto troncato, opt-out — caposaldo #3.
- Superfici spiegabili/verificabili del workspace agentico — caposaldo #9 (il trace rende il turno
  ispezionabile).

## Non-goal (dichiarati)

- Vista in-app "Turn inspector" (follow-on che consuma questo file).
- Cattura di eventi fuori dal loop (recall/consolidation/canali).
- Inclusione nel Export chat / bundle condivisibile (follow-on).
- Sostituire o rendere leggibile `tool_trace_dump` (resta l'oracolo di parità).
