# Stato — Homun (documento vivo)

> Aggiornato a OGNI sessione (vedi [METHODOLOGY.md](METHODOLOGY.md) §6). Resta **conciso**: è
> uno *stato*, non un changelog (lo storico va in `archive/`). Da qui si riparte a inizio
> sessione o dopo una compattazione.
>
> **Ultimo aggiornamento: 2026-07-06** — questo file è stato **riscritto da zero** contro il
> codice reale (reset chirurgico della doc). Il vecchio STATO (rolling log fino al 2026-07-01)
> è in [archive/2026-07-06-pre-reset/STATO-2026-07-01.md](archive/2026-07-06-pre-reset/STATO-2026-07-01.md).

## ⭐ Verità del codice (verificata 2026-07-06, non ereditata dalla doc)

> Caposaldo: **il codice è la fonte di verità**. Questi fatti sono da grep/read sul codice,
> non dai doc precedenti (che su alcuni punti — vedi sotto — ingannavano).

- **Motore chat = UN loop guardato ReAct** (ADR 0021): native tool-calling, piano-come-*tool*.
  Vive in `crates/desktop-gateway/src/main.rs` (`run_agent_turn_into_message[_with_fanout]`).
  `main.rs` ≈ **58.9k righe** (monolite da erodere, non far crescere).
- **`crates/engine` NON esiste.** L'estrazione del motore (ADR 0024) è **Proposed**, non
  iniziata: `HOMUN_ENGINE_CRATE` = 0 occorrenze nel codice.
- **`crates/orchestrator`** (~4.2k righe: `brain`/`driver`/`planner`/`step_executor`) = motore
  plan-execute **alternativo e dormiente**, non wired come chat (ADR 0021 ha scelto il single
  loop). È il classico "converge, non duplicare": va **ritirato**, non alimentato.
- **`crates/memory`** (~6k righe, `MemoryFacade`) esiste ed è il **layer condiviso**.
  L'estrazione "memory service out-of-path" (ADR 0022) è **Proposed**, non iniziata:
  `HOMUN_MEMORY_SERVICE` / `HOMUN_MEMORY_POOL` = 0 occorrenze.
- **Turn broker = default-ON** (`turn_broker_enabled()`): è il path chat unico — coda turni +
  executor + **WebSocket unificato** (`/api/ws`, `crates/desktop-gateway/src/ws_gateway.rs`).

## Dove siamo

- **Fase appena chiusa (mergiata su `main` il 2026-07-06): turn-queue-broker + unified WebSocket.**
  Il broker è il path chat unico (retry, coda, browser-gating Fase 1); un solo WS persistente
  (`ws_gateway.rs` server + `apps/desktop/src/lib/wsSubscription.ts` client) sostituisce
  NDJSON + i polling. Piani/spec: `superpowers/plans/2026-07-05-turn-queue-broker-*` e
  `superpowers/{plans,specs}/2026-07-05-unified-websocket-*`.
- **Fix di sessione (2026-07-06, su `main`):**
  - **WS/StrictMode:** il WS singleton veniva chiuso dal cleanup dell'effetto sotto il
    mount→unmount→remount di StrictMode e restava wedged (`isConnecting` bloccato) → niente
    streaming nel renderer. Fix: il cleanup droppa solo l'handler; `disconnect()` resetta lo stato.
  - **Titling a due fasi:** titolo **provvisorio** dal prompt all'**avvio** del turno (prima
    restava "New task" fino a fine turno) + **refine LLM** a fine turno. Root cause qualità:
    `generate_thread_title` usava `max_tokens: 24`, che un reasoning model (deepseek-v4-pro)
    spende tutto nel `reasoning` → `content` vuoto → fallback a troncamento. Fix + audit
    trasversale delle altre chiamate LLM a budget piccolo (task `task_982280f5`).

## Direzione-motore (ADR correnti)

- **ADR 0021** — single guarded loop, planning-as-tool. Supersede 0020, emenda 0016.
  Contesto: 0018 (adaptive harness), 0019 (model output normalizer).
- **ADR 0022 (Proposed)** — memoria come servizio out-of-path (`MemoryFacade` dietro flag).
- **ADR 0024 (Proposed)** — estrazione del motore da `main.rs` in `crates/engine`.
  ⚠️ 0022/0024 sono **direzioni decise ma non implementate**: nessun crate/flag esiste ancora.

## Prossimo passo (candidati, da scegliere a inizio sessione)

1. **Estrazione motore** (ADR 0024): primo slice comportamento-preserving da `main.rs`, dietro flag.
2. **Split file over-limit**: `main.rs` (58.9k) e `ChatView.tsx` (~9.4k) per responsabilità.
3. **Chiudere l'audit** `task_982280f5` (max_tokens reasoning-model) e mergiarlo.
4. **Verifica mappe `architecture/`** contro il codice (parte del reset doc in corso).

## Da verificare / non confermato

- **P0 production hygiene**: la memoria di lavoro dice "shipped su branch `feat/p0-production-hygiene`";
  quel branch **non è su `main` né presente localmente**. Stato reale = **da verificare**.
- **Freschezza `architecture/`** (14 mappe reverse-engineered, 2026-06-22/27): verifica vs codice
  ancora da fare — trattarle come "probabilmente accurate ma non ri-verificate dopo broker/WS".

## Prompt di ripartenza

> Sei su Homun (`app/`), branch `main`. Leggi CAPISALDI + METHODOLOGY + **questo STATO** (la sezione
> "Verità del codice" è verificata). Il motore è il single guarded loop in `main.rs`; broker+WS
> unified sono live su main. Non fidarti di riferimenti a `crates/engine` o `HOMUN_MEMORY_SERVICE`:
> non esistono (ADR 0022/0024 = Proposed). Scegli un "prossimo passo" e verifica sempre col codice
> prima di asserire stato.
