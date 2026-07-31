# Foundations + kill list — punti saldi e cosa togliere

> Data: 2026-07-27. Compagno di [TURN_CONTRACT.md](../TURN_CONTRACT.md).
> Obiettivo: rendere **espliciti** i punti saldi del progetto e segnare cosa è in più,
> dormiente, o crea contratti rivali — così non si aggiunge infrastruttura sopra ambiguità.

**Regola:** KEEP = base su cui costruire. CONVERGE = unificare sotto Turn Contract.
KILL/quarantine = rimuovere o isolare perché confonde. DEFER = utile dopo, non ora.

---

## 1. Punti saldi (KEEP) — la base unica

Queste sono le fondamenta. **Non reinventarle. Non affiancarne una seconda.**

| Punto saldo | Dove vive | Perché è saldo |
|---|---|---|
| **Un loop agentico** | `crates/engine` → `run_turn`; seam `run_agent_rounds` | ADR 0021/0024; drive-as-chat **già cancellato** dal codice |
| **Memoria unica** | `MemoryFacade` / `local-first-memory` | Caposaldo #1 |
| **HITL vero (oggi)** | `request_confirm` → `pending_confirm` + `ACTIONABLE_CARD_MARKER_TAGS` (5 tag) → `WaitingUserApproval` | Unico path che ferma loop + task |
| **Broker del turno** | `enqueue_chat_turn` / `execute_chat_turn_task` / `TaskStatus` | Ownership del task chat |
| **Park macchina** | `TurnDelivery::Parked`, `steering_control`, `chat_turn_task_is_parked` | Separato da HITL umano |
| **WS unificato (live)** | `/api/ws`, `WsRegistry`, desktop `wsSubscription` | Un transport live |
| **Piano shape canonica** | `canonical_plan_value` / `LoopState.plan` | Caposaldo #6; drift di shape = piano cieco |
| **Brain deliverable** | `OrchestratorBrain::plan_only` + materialize (`HOMUN_BRAIN_MATERIALIZE`) | Non è secondo motore chat; serve a deck/doc |
| **Capability registry** | registry unico + policy | Caposaldo #7 |
| **Privacy pre-turn vault** | `privacy_guard` | Intercetta prima del loop |
| **Sandbox / seatbelt tipi** | `tool_safety::SandboxPolicy`, seatbelt/landlock | ADR 0023 direzione |

Se una feature nuova non si appoggia a una riga di questa tabella, è sospetta.

---

## 2. CONVERGE — contratti rivali (non “feature mancanti”)

Qui nasce la confusione prodotto (scelta treno senza stop, writing vs waiting, ecc.).

| Cosa | Problema | Destino sotto Turn Contract |
|---|---|---|
| `‹‹CHOICES››` / `choice_prompt` | Sembrava HITL, **non** fermava | **DONE (slice 2026-07-27):** stesso stop di confirm + gate nudge/synthesis; resume click→messaggio ancora OK |
| `needs_clarification` | Era un bool parallelo su `TurnOutcome` | **REMOVED:** Clarify steering usa `TurnOutcome.awaiting_user=Clarify Free`; forced synthesis passa dal gate HITL |
| Nudge `answer_did_not_conclude_plan` | Spinge avanti con piano aperto anche se c’è CHOICES/prosa | Gate: vietato se `AwaitingUser` o CHOICES presente |
| `forced_synthesis` dopo confirm/clarify “senza prosa” | Sovrascrive uno stop | Vietato se wait aperto |
| Vocabolario wait | `waiting_user` / `waiting_user_approval` / `waiting_user_action` / `Parked` | Distinguere human vs machine in UI e status |
| Marker UI + regex desktop | Seconda verità accanto a `event_parts` tipizzati | A regime: eventi tipizzati = verità; marker = persistenza/compat |
| Piano: loop vs `ExecutionPlan` vs memory `open_loop` vs `‹‹PLAN››` | Shape/drift | Una SoT runtime (`LoopState` + durable runtime plan); resto = projection/UI |
| NDJSON dual-publish | Live = WS ma server ancora fan-out NDJSON | Recovery only → poi ritiro live NDJSON |

**Non** convergere “aggiungendo un altro marker”. Si estende l’unico stop.

---

## 3. KILL / quarantine — togliere perché confonde

| Item | Confidence | Azione | Note |
|---|---|---|---|
| Doc/audit che dicono `HOMUN_DRIVE_CHAT` / `HOMUN_ORCHESTRATED_CHAT` ancora cablati | **high** | Scrub doc | **0 match** nel codice Rust oggi; ADR 0020 superseded |
| Trattare `OrchestratorBrain::drive` / `run_agentic_step` come futuro chat | **high** | Quarantine mentale + commenti | ADR 0021; tenere solo `plan_only` / materialize |
| `tool_exec.rs` scaffold `ToolExecutor` (Phase 0, `#![allow(dead_code)]`) | **high** | **REMOVED** | Era un finto chokepoint non live; dispatch resta in `main.rs` finché non viene estratto davvero |
| Header `tool_safety.rs` “nothing is wired” / allow dead_code globale | **medium** | Correggere commento: tipi usati (`SandboxPolicy`); `assess_tool_safety` ancora solo test | Commento che mente = confusione |
| `TurnOutcome.needs_clarification` senza consumer | **high** | **REMOVED** | Half-landed chiuso: envelope tipizzato come unica SoT |
| Delivery reconcile auto-done (già stub `None`) | **high** | Lasciare morto; non resuscitare | Già quarantined correttamente |
| `/api/events` NDJSON app stream se nessun client desktop | **medium** | Ritirare dopo verifica caller | Dual surface |
| `HOMUN_STREAM_LEGACY_MARKER_DELTAS` a lungo termine | **medium** | Ritirare quando marker≠verità | Compat knob |
| `PLAN_PROPOSE` come seconda SoT del piano | **medium** | Solo UI proposal | Non guidare `LoopState` da lì |

### Cosa **non** killare ancora (falso positivo)

- Intero crate `orchestrator` — serve `ExecutionPlan` + `plan_only` per deliverable.
- NDJSON recovery (`replayBrokerTurnStream`) — finché WS resume non lo sostituisce.
- Marker inline in persistenza — finché `event_parts` non sono l’unica verità a reload.
- Brain materialize — vivo e voluto.

---

## 4. DEFER (dopo Turn Contract)

| Item | Perché dopo |
|---|---|
| Shrink aggressivo di `crates/orchestrator` (solo tipi + plan_only) | Dopo che HITL è uno; meno rischio di “riusare drive” |
| Wire reale di `ToolExecutor` come solo chokepoint | Dopo `AwaitingUser` tipizzato (NeedsApproval è un kind) |
| Parts strutturate end-to-end (stile Codex) al posto dei marker | Forma dati; prima serve ownership del turno |
| Unificare `execution_journal` vs `turn_trace` | Osservabilità; non blocca il contratto |
| Job lunghi “ore” oltre il chat turn | Prodotto separato |

---

## 5. Ordine di lavoro (per non ricadere)

```text
1. Turn Contract scritto (fatto) + gate di review
2. Convergenza CHOICES → stesso stop di confirm (+ test contratto)
3. Gate nudge / forced_synthesis su wait
4. needs_clarification: **removed**; Clarify = `awaiting_user` (Always Contract)
5. Kill scaffold/doc mentitori (`tool_exec` removed; scrub audit/doc legacy next)
6. Solo dopo: transport cleanup, parts tipizzate, tool chokepoint
```

Ogni passo porta test sul **contratto**, non sul tool (Trenitalia/browser = consumer).

---

## 6. Come riconoscere un punto saldo vs debito

| Domanda | Se sì → |
|---|---|
| C’è **una** implementazione live e i doc mentono? | Scrub doc (non nuovo codice) |
| Ci sono **due** path per lo stesso invariante? | CONVERGE o KILL il parallelo |
| È uno scaffold “Phase 0” mai cablato? | Quarantine/delete — non costruire sopra |
| È projection (memory/UI) che guida il loop? | Bug di design — loop guida, projection segue |
| Estende `AwaitingUser` / `MemoryFacade` / `run_turn` / registry? | Probabilmente saldo |
| Introduce un nuovo “modo di aspettare l’utente”? | Violazione Turn Contract → rifiuto |
