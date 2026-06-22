# Homun roadmap operativa

## Obiettivo attivo

WS6.2 Resource Governor: rendere durevole e osservabile la backpressure dei task,
così un task bloccato da saturazione risorsa non resta stranded e l'app espone
uso/limite/disponibilità per classe risorsa.

## Fase corrente

Path B e WS6.1c sono chiusi: le scritture MCP Filesystem dentro root progetto
sono workspace-scoped, fuori root restano confirm-gated, e l'approvazione
Telegram riprende il turno restando ancorata a richiesta originale e argomenti
approvati.

WS6.2 ha completato quattro slice locali:

1. gateway sweep `WaitingResource` → `Queued` quando la risorsa torna disponibile;
2. stesso recupero in `TaskRuntime::run_ready_once`;
3. API task queue con `units`, `limit_units`, `available_units`, `saturated`;
4. stress gate cross-connection su SQLite condiviso con due worker/store separati
   e `llm_inference=1`.

Piano attivo:
[2026-06-22-resource-governor-ws6-2.md](superpowers/plans/2026-06-22-resource-governor-ws6-2.md).

## Milestone

1. Decidere se WS6.2 è chiudibile con le verifiche attuali o se serve una
   micro-slice UI/diagnostica per configurare/mostrare i limiti risorsa.
2. Se chiusa, passare a WS6.3 Scheduler/ricorrenza + proactive review.
3. Tenere aggiornata la memoria durevole (`docs/DEVELOPMENT.md` + backlog) a
   ogni checkpoint verificato.

## Blocco noto

Nessun blocco tecnico attivo su WS6.2. La limitazione residua è di prodotto: non
è ancora deciso se i limiti risorsa debbano essere configurabili in UI prima di
iniziare WS6.3.

## Prossima azione

Committare il checkpoint WS6.2d, poi decidere: chiusura WS6.2 e passaggio a
WS6.3 oppure micro-slice WS6.2e UI/diagnostica limiti.
