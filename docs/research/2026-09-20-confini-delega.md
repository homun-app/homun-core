# Confini della delega operativa — consegna e verifica

**Data:** 20 settembre 2026, tranche successiva a [contesto autorizzato](2026-09-20-contesto-autorizzato.md); slice che chiude il passo D della [specifica di passaggio](../handoff/2026-09-19-ripresa-sviluppo-homun.md).
**Branch:** `fabio/production-foundations`, working tree con tutta l'implementazione precedente intatta più questa tranche.

## La lacuna trovata

L'accesso è per grant di progetto: un agente delegato owner con grant può già condurre turni di chat sul lavoro. Ma `authority(approval=True)` di confronto CSV e lettura materiale controllava solo l'appartenenza a {owner, reviewer} — **un agente owner avrebbe potuto approvare l'esecuzione dei propri strumenti**. Contro il principio del prodotto («l'autonomia si concede per attività e contesto; approvare un risultato non autorizza un effetto»), era una frontiera aperta.

## Cosa è stato costruito

1. **Gate persona sulle azioni concrete**: l'approvazione dell'esecuzione di confronto CSV e lettura materiale richiede `actor.kind == 'person'`, anche quando il proprietario del lavoro è l'agente delegato. L'agente propone e lavora; la persona approva gli effetti.
2. **Cap di budget propri per delegato** (`BudgetAllocation` dentro `WorkBudget`): limite proprio di tentativi/token per attore, contatori propri (reserved/spent/unknown), sub-cap dentro la busta del lavoro. `reserve` ammette rispetto a busta **e** allocazione dell'attore; `reconcile`/`reconcile_unknown`/`release`/`recover_pending` aggiornano anche l'allocazione (la riserva registra l'attore). Il comando `work.set_budget` accetta `allocations: [{actor_id, model_attempts, input_tokens?, output_tokens?}]` — attori noti, limiti sostituiti, **contatori già spesi conservati**; `GET /works/{id}` espone le allocazioni con i contatori. È la lezione Hermes dei sub-cap per delegati, nella forma Homun: esaurimento tipizzato per il singolo delegato mentre la busta e gli altri attori continuano.

## Prove eseguite (distinte per tipo)

**Deterministici motore** (421 passati, 1 saltato; 3 nuovi): delegato con allocazione 1 — esaurisce il proprio sub-cap mentre la busta ha spazio, l'umano e altri attori proseguono, il rialzo esplicito dell'allocazione lo ripristina conservando i contatori; **agente owner con grant non approva** l'esecuzione del confronto né della lettura (person gate, nessun artifact); **prova di delega end-to-end via HTTP** — agente con grant di scrittura posta nel lavoro, l'interpretazione gira addebitata alla sua allocazione, al secondo messaggio 429 `budget_exhausted` solo per lui, l'umano continua a parlare indisturbato.

**Frontend** (160 passati): nessuna regressione; typecheck, build, architettura 0 errori/29 avvisi, `git diff --check` pulito, OpenAPI invariata e verificata. (La verifica col modello reale non aggiunge qui: il percorso toccato è policy e contabilità, già coperti dal fake deterministico e dalle prove D1–D3 con provider reale.)

**Pacchetto:** bundle ricostruito, **8/8 test desktop** col motore incorporato.

## Build di riferimento

- App: `dist/desktop/2026-09-20T12-09-11-805Z/Homun-darwin-arm64/Homun.app`
- ZIP: `dist/desktop/2026-09-20T12-09-11-805Z/Homun-0.1.0-macos-arm64.zip`
- SHA-256: `b1b75c3f8a9e7ab75269f9cb3409f5e855b0d71a646cbba3e974d19083c1543f`
- Non firmata e non notarizzata: candidato locale, non una release. Le build precedenti restano come prove storiche.

## Accettazione del passo D (dal passaggio) e stato

- «Budget persistito per lavoro che includa chiamate, retry e delegati; riserva atomica prima dell'azione e riconciliazione dopo»: fatto (D1+D2+D4: delegati con cap propri).
- «Usage sconosciuto resta sconosciuto, non zero»: fatto (contatori separati, prove dedicate).
- «Estendere il contesto autorizzato con lavoro, materiali e memoria pertinente, mantenendo riferimenti/versioni/hash e limiti espliciti»: fatto (D3).
- «Riesaminare accesso prima di pubblicare effetti»: fatto (rivalidazione con identità materiali; person gate sulle approvazioni).
- «Solo dopo questi confini rendere operativa una delega più ampia»: la delega ora operativa e delimitata — l'agente owner con grant conduce turni di chat sotto il proprio cap; le azioni concrete restano approvazione umana.
- Concorrenza, esaurimento, cancellazione, retry, revoca, restart, fonti tracciabili: tutti con prove nelle tranche D.

**Il passo D è completo.** Restano fuori, come da passaggio: il loop multi-tool generico (catene di strumenti in un turno, oltre le capacità singole approvate) e le skill portabili.

## Limiti rimasti

- La delega operativa copre i turni conversazionali del delegato; l'agente non avvia autonomamente azioni strumento: propone, l'umano approva. Il loop multi-tool (agente che compone più capacità in un turno, con approvazione per effetto) è il passo successivo naturale.
- Le allocazioni si impostano solo via comando/API; nessuna UI. La revisione umana dell'operato del delegato usa le superfici esistenti (transcript, diagnostica, budget via API).
- Un owner agente senza allocazione spende dalla busta comune fino al cap del lavoro: senza allocazione esplicita non ha limite proprio.
- Restano i limiti storici (skill portabili, cifratura, firma/notarizzazione, identità multiutente, i18n UI, catalogo materiali nella UI).

## Riproduzione della prova

Test deterministici: `engine/.venv/bin/pytest -q engine/tests/test_budgets.py` (14 test, inclusi gate persona, sub-cap delegato e prova di delega HTTP). Scenario manuale: confermare un intake affidando a un agente, emettere `grant.issue` di scrittura all'agente sul progetto, `work.set_budget` con `allocations` per l'agente, poi due messaggi in chat con header attore agente: il primo gira, il secondo 429; l'umano continua. Il profilo reale in `~/Library/Application Support/Homun/engine` non è stato toccato.
