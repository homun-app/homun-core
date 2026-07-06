# Decision 0024: Estrazione del motore agentico da main.rs in crates/engine

Date: 2026-07-06

## Status

**Proposed.** Formalizza una direzione già citata come corrente (in `CLAUDE.md` e nella memoria di
lavoro) ma **non ancora iniziata**. Attua la [0021](0021-single-guarded-loop-planning-as-tool.md)
(il motore canonico è il **single guarded loop**) dandogli una casa di primo livello, e prepara la
convergenza del caposaldo #5 (ritirare `crates/orchestrator`, non alimentarlo).

> ⚠️ **Stato reale del codice (verificato 2026-07-06):** `crates/engine` **non esiste**;
> `HOMUN_ENGINE_CRATE` ha **0 occorrenze**. Il loop guardato ReAct (motore #1) vive dentro
> `crates/desktop-gateway/src/main.rs` (`run_agent_turn_into_message[_with_fanout]`), che è
> ≈ **58.9k righe**. Questo ADR è la **decisione di estrarlo**, non un fatto compiuto.

## Perché questa decisione esiste

Due tensioni concrete:

- **Monolite.** `main.rs` a ~58.9k righe supera di gran lunga i limiti di file della
  [METHODOLOGY](../METHODOLOGY.md) (soft ~1500, hard ~2500). Il motore agentico — la parte più
  importante e più testata del prodotto — è sepolto lì dentro, difficile da isolare e da testare
  in unità.
- **Convergenza (caposaldo #5).** La 0021 ha stabilito che il motore canonico è il single guarded
  loop e che `crates/orchestrator` (motore plan-execute alternativo, dormiente) va **ritirato**.
  Perché quel ritiro sia reale serve che il motore canonico abbia una collocazione chiara e
  riusabile, non che resti indistinguibile dal resto del gateway.

Estrarre il motore in un crate dedicato lo rende un **fixed point** (contratto + test) su cui
costruire, invece che una funzione dentro un monolite.

## La decisione

1. **`crates/engine` diventa la casa del motore canonico**: il loop guardato ReAct (native
   tool-calling), il chokepoint dei tool, i guardrail (cap step, no-progress/wander, gate di
   verifica, permessi, fail-open) della 0021.
2. **Estrazione incrementale e comportamento-preserving da `main.rs`**, dietro
   **`HOMUN_ENGINE_CRATE`** (flag-off di default finché non validato a parità di comportamento).
3. **Bottom-up e gated** (METHODOLOGY): ogni slice porta il suo test; non si costruisce sopra un
   layer finché quello sotto non è un punto fermo verde.
4. **La memoria è un servizio con cui il motore dialoga**, non codice intessuto — sinergia con la
   [0022](0022-memory-as-out-of-path-service.md).
5. **Fine-linea: ritiro di `crates/orchestrator`** come driver del turno (la 0021 ha già scelto il
   single loop); non lo si cabla, lo si dismette una volta che il motore estratto copre i casi.

## Conseguenze

- Il motore diventa testabile in isolamento; `main.rs` si sgonfia per responsabilità (obiettivo
  METHODOLOGY sul monolite).
- Superficie chiara per riuso (chat, canali, automazioni, subagenti) attorno a **un** motore.
- Rischio da gestire: estrazione a parità di comportamento su un loop grande — procedere a slice
  piccoli dietro flag, con confronto di comportamento prima di promuovere.

## Cosa NON cambia

- La **forma** del motore (single guarded loop, planning-as-tool) è quella della 0021: questo ADR
  ne cambia la *collocazione*, non il design.
- Local-first, registry unico delle capability, memoria come layer condiviso, harness che possiede
  il control flow.

## Note di implementazione (aperte)

- Nessun crate/flag ancora creato. Primo slice suggerito: isolare il cuore del loop
  (`run_agent_turn_into_message_with_fanout` e le sue dipendenze dirette) dietro `HOMUN_ENGINE_CRATE`,
  con un test di parità sul percorso interattivo.

Vedi memoria: `homun-single-loop-evidence-verdict`, `homun-longhorizon-engine`.
