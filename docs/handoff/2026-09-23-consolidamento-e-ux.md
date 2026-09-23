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

Partire da tre lavori: confronto listini, relazione da materiali, ricorrenza di
un lavoro riuscito. Ricostruire richiesta → chiarimento → accordo → fonti →
esecuzione → revisione → riutilizzo, includendo fallimenti e ripresa dopo giorni.

Discutere quali decisioni l'utente deve davvero prendere e quali configurazioni
possono apparire solo quando necessarie. Conservare obiettivo, autorizzazione,
fonti e verificabilità; misurare attriti e conferme ripetitive prima di cambiare
componenti. Restano aperti recupero MCP, identità/rete, cifratura completa,
qualità del modello e distribuzione verificata.
