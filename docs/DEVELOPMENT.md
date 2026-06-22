# Homun — Sviluppo (hub vivo)

> **Punto d'ingresso unico.** Da qui si parte e si torna. Questo file è SEMPRE
> aggiornato: se cambia una scelta importante, si aggiorna qui (o nel doc linkato).
> Ultimo aggiornamento: 2026-06-22.

## North Star

Un assistente **local-first** desktop (macOS/Win/Linux) che non è una chat passiva:
osserva, capisce richieste naturali, sceglie strumenti in modo governato, esegue
task anche lunghi (coda/approval/checkpoint), mostra cosa fa (Chat + Local Computer)
e costruisce una **memoria verificabile**. Modello mentale: un apprendista che
osserva, propone, esegue con permesso e diventa maestro operativo. Direzione di
prodotto: avvicinarsi a **Manus** per le PMI (deliverable reali), restando
**local-first** e **capable-first** ma funzionante anche su modelli **locali/deboli**.

## I capisaldi (vincolanti) → [CAPISALDI.md](CAPISALDI.md)

1. Memoria = differenziatore e **layer condiviso** (tutto vi passa, mai store paralleli).
2. Orchestrazione = proprietà dell'**harness**, gira sul tier locale; il motore è il prodotto.
3. Local-first + privacy-by-design.
4. Ciclo di vita dei **deliverable** ≠ chat; artefatti = entità di memoria.
5. Un solo motore / grafo / store: convergere, non duplicare.
6. Stato e control-flow di **codice**; il modello riempie slot vincolati (3 invarianti del piano).
7. Niente keyword/regex; verità verificabile.
8. La memoria cattura il **PERCHÉ** e i **loop aperti**, e collega TUTTO nel grafo (verificabile via eval).

## Mappa della documentazione (una fonte per ogni cosa)

| Domanda | Dove |
|---|---|
| **Principi** (cosa non si viola) | [CAPISALDI.md](CAPISALDI.md) |
| **Scelte precise** (perché abbiamo deciso X) | [decisions/](decisions/) — ADR 0001-0016 (immutabili) |
| **Com'è fatto** (architettura + diagrammi) | [architecture/](architecture/) — overview + memory + agent-loop + plugins + system-map |
| **Dove siamo / cosa manca** (backlog corrente) | [plans/2026-06-22-…](plans/2026-06-22-batch-1042-artifacts-memory.md) |
| **La memoria** (visione + struttura) | [memory-vision.md](memory-vision.md) · [memory-architecture.md](memory-architecture.md) |
| **Prodotto / distribuzione / self-host** | [PRODUCT_LOOP.md](PRODUCT_LOOP.md) · [distribution.md](distribution.md) · [self-host.md](self-host.md) · [release-macos.md](release-macos.md) |
| **Storico** (changelog, vecchi piani, snapshot) | [archive/](archive/) — non più "corrente", solo memoria storica |

## Stato esecuzione — "SEI QUI" (aggiornato 2026-06-22, anti-compattazione)

> Se il contesto si è compattato: rileggi QUESTO blocco + il
> [backlog](plans/2026-06-22-batch-1042-artifacts-memory.md) (gli stati ☐/✅ = i loop
> aperti) e sei di nuovo sul filo. Stesso principio della memoria di Homun (caposaldo #8).

- **Pubblicato:** **v0.1.1043** = memoria coerente (WS5.7: estrattore cattura i *finding*
  inclusi i **negativi** + `open_loop` completi) + **WS5.4a** (open_loop nel briefing
  always-on: `gather_open_loops` + sezione "OPEN LOOPS" in cima a `format_memory_block`).
  *(v1042 aveva WS3 + WS8.1 eval + WS5.2 embed-everything + WS5.3 open_loop.)*
- **DA VERIFICARE IN-APP (gate, modifiche memoria CORE):** re-test Rossi su 1043 →
  (1) chat B deve ricordare anche **"nessun file ancora"** (WS5.7); (2) una chat **NUOVA**
  deve mostrare i loop aperti **senza** nominare il topic (WS5.4a). L'eval headless non
  copre recall/briefing.
- **In locale, 4 commit → v1044 (verde RICONFERMATO, no trailer):** 3 slice WS1-F2 motore
  piano (✅ slice 1 `merge_plan` per `id`, fallback titolo · ✅ slice 1b prompt eco `id` ·
  ✅ slice 2 **`step_advance(id,status)`**: progresso per id **senza re-inviare il piano**,
  weak-model-proof, riusa merge+F2-verify) **+ 1 commit doc**. Delta vs v1043 = **solo Rust**
  (`desktop-gateway/src/main.rs`); test piano **8/8 verdi** (incl. le 3 invarianti del #6 +
  verify-gate F2). Chiude alla radice il gonfiore del piano.
- **DECISO (2026-06-22): opzione (1) — build+run v1044 in-app.** Non per preferenza ma per
  *gate*: 2 modifiche-cuore non verificate impilate (memoria 1043 + motore-piano) → (2)/(3)
  ne impilerebbero una **terza**. Run: `cd apps/desktop && npm run electron:dev` — electron
  fa `cargo run -p local-first-desktop-gateway` **da HEAD = v1044** (nessun bump/tag: il
  tag *è* il publish, solo su comando). Un solo run copre memoria 1043 **e** piano.
- **GATE in-app — RISULTATO (2026-06-22, modello `kimi-k2.6:cloud`):**
  · ✅ **Memoria 1043 VERIFICATA → chiusa**: chat B ha ricordato *"il file del preventivo
  non è stato ancora trovato"* (WS5.7, finding **negativo**); una chat **NUOVA** ha mostrato
  **2** loop aperti (preventivo Rossi + bug gateway browser-headless) **senza** nominare il
  topic (WS5.4a). · ❌ **Piano NON esercitato end-to-end**: task 5-step (`demo-piano`) →
  **‹‹PLAN›› = 0** nel thread (verificato nel chat store), loop fermo a **2/5** (cartella +
  `note.md`), poi turno chiuso. Le slice v1044 (merge-per-id, `step_advance`) sono
  **unit-verdi (8/8) ma non raggiunte**: stanno *a valle* di un piano che non viene **creato
  né guidato a termine**.
- **ROOT CAUSE (INCHIODATA — Passo 0, lettura del loop):** il guard anti-stop-prematuro è a
  `main.rs:13533`: allo stop (no tool-call) il nudge F5 scatta **solo** dentro
  `if let Some(step) = plan_next_open(&plan)` → **solo se il piano ha uno step aperto**. Ma
  `plan` cresce **solo** via `update_plan`/`step_advance` (`merge_plan`, :12717) o F4-resume
  (:10742): **nulla lo forza**. Task generico → modello salta `update_plan` → `plan` vuoto →
  `plan_next_open`=None → nudge saltato → stop a 2/5 accettato (:13584 `final_done;break`).
  **Tutta F1–F5 è gated su `plan` non-vuoto** — protegge un piano esistente, non lo fa
  nascere. `make_deck` immune perché **one-call** (no loop multi-step). Caposaldo #2.
- **FIX proposto (slice 2.5 — guard SIMMETRICO @ `main.rs:13524-13565`):** se `mode=="agent"`
  + tool usati nel turno + budget + `plan` **vuoto**, un giudice-completamento cheap (riusa
  `verify_step_complete`, **fail-open**) valuta "richiesta soddisfatta?"; se NO → directive
  nudge "chiama `update_plan` con TUTTI gli step, poi fai il primo non fatto". Bound già
  esistenti: `MAX_PLAN_NUDGES=8` + `is_final_round`. Chirurgica, non sovra-pianifica i turni
  banali, riusa F2. Follow-up = "Floor ovunque" (forza-piano a round 1). **Verifica: gemma
  demo-piano → 5/5.** Poi: slice 3 / WS2. ⚠️ Side-note UI: turni cloud etichettati "Local model".
- **Coda:** WS5.4b (`stato-lavori.md`) · WS5.4c (chiusura+dedup) · WS5.5 (provenienza) ·
  WS2 · WS1 3-6 · WS6/7/8/9. Ordine nel backlog.
- **Regole operative:** build LOCAL, verde a ogni passo, doc aggiornati nello stesso turno,
  **publish solo su comando utente**, **niente trailer Co-Authored-By** ([[homun-no-claude-coauthor]]).
- **Sfondo:** Motore cross-modello Fase 1 ✅ v1041 (deck verificato vero-locale, gemma4:latest).

## Diagrammi dettagliati (si aggiornano "man mano")

- [architecture/agent-loop.md](architecture/agent-loop.md) — il motore / agent loop (cross-modello).
- [architecture/memory.md](architecture/memory.md) — la memoria a 3 livelli (SQL + grafo + markdown).
- [architecture/plugins.md](architecture/plugins.md) — skill, capability e addon (ADR 0011).
- [architecture/overview.md](architecture/overview.md) — il quadro d'insieme (poster SVG su richiesta).
- [architecture/system-map.md](architecture/system-map.md) — mappa componenti.

## Disciplina di aggiornamento (come teniamo viva la doc)

1. **Una scelta nuova** → un **ADR** in `decisions/` (numerato, immutabile).
2. **Un cambio di stato/avanzamento** → aggiorna il **backlog** in `plans/`.
3. **Un cambio di funzionamento** → aggiorna il **diagramma** in `architecture/` + questo hub.
4. **Un principio nuovo** → `CAPISALDI.md`.
5. Lo **storico** non si cancella: va in `archive/`.

Regola d'oro: **se una modifica viola un caposaldo, si ridiscute, non si spedisce.**
