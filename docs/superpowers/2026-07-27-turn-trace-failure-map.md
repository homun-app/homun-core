# Failure-mode map — turn-trace reale (`~/.homun/logs/turn-trace.jsonl`)

**Data:** 2026-07-27 · **Corpus:** 85 turni / 875 eventi (modello dominante: `deepseek-v4-pro`).

## Verdetto in una riga

Il sistema **regge le chat senza browser**; **collassa sui task agentici con `browse`**.
La morte tipica non è un crash: è `forced_synthesis` con `finish_reason=post_loop_exhausted`
dopo un thrashing browse↔sandbox, spesso con piano cieco (`plan_final` tutti `todo`).

## Numeri

| Esito primario (71 turni con `turn_end`) | N |
| --- | ---: |
| `clean_end` | 35 |
| `forced_synthesis` (varianti) | 23 |
| `ended_with_blind_plan` / plain | 12 |
| `killed:browser_budget_exceeded` | 1 |

| Cohort | ok-ish | bad |
| --- | ---: | ---: |
| **Con `browse`** | 11 | **23** (~68% bad) |
| **Senza `browse`** | 36 | 1 |

- Nudge: 13× `stopped_without_plan` (spesso `next_step=''`), 2× `answer_did_not_conclude_plan`
- `turn_end` con `final_len=0`: 7 (risposta vuota dopo sintesi/kill)
- Divergenza `plan.sent` (con progresso) → `plan_final` tutti-`todo`: **≥10 turni** nel log

I test di stabilità `TEST-A/B/C` sono quasi tutti `clean_end` — non rappresentano il carico reale.

## Sequenza tipica che fallisce (treni Napoli→Milano)

Pattern ripetuto su decine di turni:

1. `resolve_datetime` → `find_capability` → `browse` (ok di avvio)
2. Molti round `browse` ↔ `run_in_sandbox` (il modello “prova altro” invece di chiudere uno step)
3. Round senza tool + testo → nudge `stopped_without_plan` con **`next_step` vuoto**
4. A volte un `update_plan` tardivo (`sent=['done','doing',…]`)
5. Altri browse/sandbox **senza avanzare il piano nel motore**
6. `forced_synthesis` / `post_loop_exhausted` oppure `browser_budget_exceeded` (`rounds_since_progress` alto)

### Caso A — piano mandato giusto, finale mentito (`…xd90novqsr`, «prenotiamo il primo»)

- Round 4: `update_plan` **sent = canonical = `[done, doing, todo, todo]`**
- Poi ancora browse ×3
- `forced_synthesis` `post_loop_exhausted`
- `plan_final = [todo, todo, todo, todo]` · `incomplete_steps: 4`

→ Conferma il bug di forma/lettura: l’evento `plan` vede il progresso; `turn_end` no. Harness cieco → budget non resetta → esaurimento.

### Caso B — piano parziale corretto ma non conclude (`…id8vywrmmi`, prenota treno)

- Due `update_plan` con `[done, doing, todo, todo]`
- Nudge `answer_did_not_conclude_plan` con next_step sensato («Far scegliere…»)
- Comunque `forced_synthesis` · `plan_final` resta parziale · `final_len=2420` (consegna qualcosa, ma il loop dichiara esaurito)

→ Anche con piano leggibile, **chiudere lo step / ottenere scelta utente** non è un percorso di controllo-flow stabile.

### Caso C — budget browser (`…93r6qlz63x4`)

- 23 round, mix browse/sandbox, piano creato solo al round 17
- `loop_exit: browser_budget_exceeded` · `rounds_since_progress=21`
- Poi `forced_synthesis` · **`final_len=0`**

→ 21 round senza progresso riconosciuto: il budget tempo/browser è l’unico freno perché il progresso di piano non resetta nulla.

### Caso D — nessun piano, solo thrashing (`…syjzprcuu`)

- 21 round, zero `update_plan`
- `forced_synthesis` · risposta lunga comunque (`final_len=2707`)

→ Il modello lavora “a intuito”; l’harness non ha piano da far avanzare → di nuovo solo esaurimento.

## Cosa questo dice sul “sistema sbagliato”

1. **Il path caldo rotto è browse+piano**, non la chat generica.
2. **`forced_synthesis` è la maschera del fallimento** — l’utente vede testo, il sistema ha già dichiarato `post_loop_exhausted`.
3. **Il piano non governa**: o non nasce, o nasce tardi, o il motore non lo vede (`plan_final` vs `sent`), o il nudge ha `next_step=''`.
4. **`run_in_sandbox` entra nel loop treni** al posto di restare sul browse — segnale di routing/confusione tool, non di progresso.
5. Regolare i timeout senza (1)–(3) ripete lo stesso fallimento a un limite diverso.

## Implicazioni (ordine)

1. Verificare live che dopo `589d384d` (piano canonico al motore) `plan_final` == ultimo `sent` su un turno treno fresco.
2. Far sì che auto-advance / nudge usino titoli non vuoti e chiudano step su evidenza browse (non solo su `update_plan` del modello).
3. Trattare `post_loop_exhausted` + `final_len=0` come fallimento prodotto, non come “risposta”.
4. Solo dopo: ritoccare budget browser.

## Turni da non usare come segnale

Smoke `TEST-A/B/C`, turni senza tool, e i pochi browse corti su URL fissi (`rfi.it`) — sopravvivono perché non stressano piano+browser.
