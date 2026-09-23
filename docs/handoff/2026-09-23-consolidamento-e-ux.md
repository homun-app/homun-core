# Punto fermo tecnico e prosecuzione UX

23 settembre 2026. Repository `/Users/fabio/Projects/Homun/homun2`, branch `main`.
Il commit `8b7658b2` integra in fast-forward il consolidamento autorizzato.
Non sono stati pubblicati tag o release né aggiornata l'app installata.

## Che cosa è chiuso

Materiali/Plugin autorevoli, scadenze reali da Compiti, recupero catene con ordine
journal DBOS, budget dell'assegnatario e consumi parziali, binding della sintesi,
riconciliazione cron/fuso e dialogo updater singolo. Dettagli e limiti nel
[rapporto](../research/2026-09-23-consolidamento-verifica.md).

Dopo il merge sono rieseguiti typecheck, 201 test frontend, build web/prototipo,
11 test desktop, suite motore e inventario (534 passati complessivi, 1 saltato),
OpenAPI e architettura (0 errori, 35 avvisi). Lint resta debito noto. Le prove
browser del rapporto precedente non sono state ripetute durante il merge.

## Mandato attuale

Fabio ha chiesto commit/merge, aggiornamento dei documenti e confronto con
Hermes su utilizzo reale; poi discutere come migliorare la UX e semplificare.
Non interpretare la ricerca come approvazione di un redesign o di maggiore
autonomia. Nessuna modifica al vecchio repository `../app`.

Leggere [uso Homun](../USO-HOMUN.md), [confronto](../research/2026-09-23-hermes-homun-utilizzo.md),
[stato](../STATO.md) e [matrice requisiti](../specifications/STATO-IMPLEMENTAZIONE.md).
Il [registro documentale](../REGISTRO-DOCUMENTI.md) distingue manuali correnti,
requisiti e storia. I passaggi del 19/21 settembre non sono più la lista di
cose da implementare da zero.

## Prossimo confronto con Fabio

La [verifica visione/codice](../research/2026-09-23-visione-prodotto-gap.md)
recepisce la direzione ribadita da Fabio: uso diretto generalista e onboarding
aziendale per costruire una squadra di persone e bot. Questa era già la visione
iniziale; il confronto listini resta una fixture tecnica, non il posizionamento.

Discutere insieme i due ingressi, il passaggio da domanda ad azione e quando
serve un collaboratore stabile. I gap principali sono il ciclo adattivo con
strumenti, l'onboarding organizzativo, il coordinamento operativo e le identità
condivise. Preservare dominio, DBOS, artifact, memoria e procedure già presenti.
L'analisi è statica: nessun nuovo walkthrough o test multipersona è stato svolto.
Nessuna implementazione di questi percorsi è autorizzata dal solo rapporto.
