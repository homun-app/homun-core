# Homun roadmap operativa

## Obiettivo attivo

WS7.1 deliverable Manus-style: portare documenti/ricerca/meeting al livello del
deck affidabile, con workflow dichiarativi `make_*` guidati dal runtime e output
schema-enforced.

## Fase corrente

WS6 è chiusa localmente:

1. WS6.1 — approval resume, Path B workspace-scoped Filesystem, Telegram UX.
2. WS6.2 — Resource Governor: recovery, visibility, stress gate.
3. WS6.3 — scheduler/ricorrenza + proactive review: recurrence parity,
   scheduled/proactive prompt thread, card surface/dedup.
4. WS6.4 — write-back delle azioni proattive in memoria (`open_loop`/`decision`).

Prima di pubblicare/taggare resta prudente un smoke manuale in-app su una
automazione schedulata reale che compaia nel thread `scheduled`. Non è bloccante
per iniziare WS7 in locale.

## Milestone

1. WS7.1 — workflow dichiarativi per documenti/ricerca/meeting (`make_*`),
   analoghi a `make_deck`.
2. WS7.2 — contratto personalizzazione addon.
3. WS7.3 — deliverable come entità di memoria + provenienza.

## Blocco noto

Nessun blocco tecnico attivo. Il rischio successivo è evitare di riaprire la
fragilità cross-modello già risolta per il deck: i nuovi deliverable devono
essere schema/routine-driven, non prompt liberi.

## Prossima azione

Committare lo stack WS6.3b–WS6.4 senza co-author, poi iniziare WS7.1 dal deck
come riferimento.
