# Design — Auto-compaction token-budget-driven come checkpoint di memoria (Fase 1.1)

Data: 2026-07-03. Implementa la **Fase 1.1** della [roadmap Codex-parity](../../roadmap-codex-parity.md)
("compaction token-budget-driven + consapevolezza contesto"), integrata col motore di memoria
([ADR 0022](../../decisions/0022-memory-as-out-of-path-service.md)) e coerente con l'harness-owns-control-flow
([ADR 0021](../../decisions/0021-single-guarded-loop-planning-as-tool.md)).

## Problema (verificato sul codice, 2026-07-03)

Le sessioni lunghe si rompono quando la conversazione supera il context-window del modello. Oggi:

- **Nessun conteggio token.** Tutto è char-based (`chat_context_budget_chars`); `max_tokens` nei payload è
  solo il cap di OUTPUT (~6000), non il budget di contesto.
- **La compaction esistente è plan-step-driven, non token-driven.** `compact_completed_step`
  (`main.rs:14555`) collassa lo slice di uno step completato quando `pending_compaction` è settato
  (`main.rs:21390`); non scatta quando la conversazione si avvicina al limite del window a prescindere dai
  passi di piano.
- **La compaction perde ciò che il summary non cattura — e non alimenta la memoria.** Il summary vive
  **in-memory per il turn** (`main.rs:24635`); lo span collassato non passa dal motore di memoria. Una
  compaction intra-turn avviene PRIMA del learn post-turn, quindi il contenuto scartato può non raggiungere
  mai la memoria. Contraddice il caposaldo *memoria = layer condiviso* (ogni capacità instrada write-back al
  motore unico).

Il context-window per-modello **esiste già** (`registry_model_capabilities().context_length`, già calcolato
nel turn a `main.rs:22442`; `CAPABLE_MODEL_CONTEXT_WINDOW = 32_000`). Manca il trigger token-budget + il
write-back in memoria.

## Design — “Compaction come checkpoint di memoria”

Codex comprime-e-dimentica; Homun comprime-**dentro**-la-memoria: lossless e richiamabile. Nel round loop,
al confine di round (dove `prune_browser_history`/`compact_completed_step` già girano, `main.rs:24043`), PRIMA
di `build_chat_payload`:

### 1. Stima token (pura) + trigger
- `estimate_tokens(messages) -> usize`: euristica **char/4** sul JSON dei messaggi. Model-agnostic, **nessuna
  dipendenza nuova**. *Perché non `tiktoken`:* accurato solo per i tokenizer OpenAI, **sbagliato** per i
  locali (Llama/Gemma/Qwen) → tradirebbe il differenziatore local-first/model-agnostic. È una valvola di
  sicurezza con soglia conservativa, non un contatore di fatturazione. (Calibrazione dall'`usage` reale =
  follow-up.)
- `needs_context_compaction(estimated, context_window, threshold) -> bool`: `context_window` noto **e**
  `estimated > threshold * context_window`. Soglia **0.75** (margine per output ~6k + tool schemas).
  Window **ignoto** (`None`) → `false` (fail-open al comportamento round-based esistente; il catalog auto-filla
  il window per Ollama/cloud, quindi raro).

### 2. Selezione dello span (pura, boundary-safe)
`context_compaction_span(roles: &[&str], keep_head, keep_tail_min) -> Option<(usize, usize)>` → lo `[from, to)`
da collassare. Preserva:
- **head**: `system` (idx 0) + primo `user` (ancora del task) → `keep_head = 2`.
- **tail**: almeno `keep_tail_min` messaggi recenti, ma `to` è spostato in avanti finché punta a un messaggio
  **non-`tool`** (assistant/user), così non si orfanizza un tool-result dal suo `assistant tool_calls` (OpenAI-
  compat valido). `None` se lo span risultante è troppo corto per valere il round-trip.

### 3. Write-back in memoria (il cuore) — off-path, motore unico
Prima di rimpiazzare lo span, il suo contenuto è passato a `learn_via_service_or_inline(state, user, assistant,
actions, thread_id, …)` → il motore estrae entità/fatti/decisioni e li rende **durabili + richiamabili**.
Fire-and-forget (non blocca il turn), instradato al **motore unico** (ADR 0022), fallback inline se il servizio
è OFF. **Rete di sicurezza:** anche se il summary perdesse qualcosa, la memoria tiene lo scambio grezzo → nulla
è perso davvero.

### 4. Summary salience-aware
Rimpiazzo lo span con **una nota** il cui prompt preserva lo **stato saliente**: goal/piano corrente, decisioni
prese, domande aperte, artefatti prodotti, dati/fatti chiave verbatim; comprime solo la narrazione. Estraggo il
summarizer di `compact_completed_step` in `summarize_message_slice(http, slice) -> Option<String>` condiviso
(converge, non duplica), rafforzandone il system-prompt sulla salience. Best-effort: su qualsiasi errore lascio
`messages` intatto (meno compaction, mai data-loss) — il write-back al §3 resta la garanzia.

### 5. Hook
Nuova `async fn compact_for_context_budget(state, messages, model, base_url, context_window)` chiamata al confine
di round subito prima di `build_chat_payload` (`main.rs:24091`), accanto alla compaction esistente.

## Approcci valutati
- **A ⭐** harness-driven budget check + memory checkpoint (questo). Harness-owned (ADR 0021), memory-integrated
  (ADR 0022), model-agnostic.
- **B** tool `get_context_remaining` esposto al modello (letterale Codex): contraddice ADR 0021 e aggiunge slot
  ai modelli deboli. Respinto come meccanismo (semmai segnale UI, follow-up).
- **C** solo pruning più aggressivo (estendere `prune_browser_history`): butta immagini, non il testo
  conversazionale che gonfia il window. Non risolve.

## Test (TDD, puri, senza LLM)
- `estimate_tokens`: message-set noto → stima attesa (char/4).
- `needs_context_compaction`: over/under soglia; window `None` → false.
- `context_compaction_span`: preserva head+tail; sposta `to` oltre i `tool`-result (no orfani); `None` se corto.

Il write-back e il summary sono I/O best-effort (testati col pattern esistente: fallimento → no-op senza
data-loss).

## Confine onesto & Follow-up (dichiarati, fuori slice 1)
- **Recall-enrichment** della nota-summary (compaction↔memoria bidirezionale): aggiunge un recall-round-trip a
  metà turn → follow-up.
- **Calibrazione da `usage` reale**: leggere `prompt_tokens` dalle risposte per affinare il rapporto
  char/token per-modello. Oggi lo streaming non estrae `usage`.
- **Persistenza durabile** delle summary nel thread store (oggi in-memory per il turn, come la compaction
  esistente): follow-up condiviso con quella.
- **Indicatore UI “context fill %”**.

## Success
- Su un turn che si avvicina al context-window del modello, l'harness compatta autonomamente (nessun tool per
  il modello); lo span compattato è **scritto in memoria** prima del collasso; head+tail preservati; struttura
  OpenAI-compat valida (nessun tool-result orfano).
- Le funzioni pure (estimate/trigger/span) coperte da test; write-back e summary best-effort senza data-loss.
- Nessuna regressione quando il window è ignoto o la conversazione è sotto soglia (comportamento invariato).
