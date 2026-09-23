# Ricerca nel catalogo approvato

H07 resta parziale. `ToolRegistry.search` ordina ora per BM25 il catalogo del run:
nome esatto prioritario, filtro sul termine più raro e copertura minima della
metà dei termini conosciuti per query con almeno quattro termini conosciuti.
Nome, toolset, descrizione e nomi dei parametri sono indicizzati; i corpi degli
schemi non diventano parole di ricerca. Parità di punteggio risolta per nome.
La ricerca non esegue strumenti né estende l'autorità del run.

Derivato da `tools/tool_search_catalog.py` di Hermes, commit
`c9dca726514b709cf6e677d236a79fc8d0627f37`, con notice MIT aggiornata.
Tokenizzazione Unicode propria; stemming inglese upstream ancora assente.

## Verifica

Prima dell'implementazione due test fallivano: nome esatto dopo un risultato
alfabeticamente precedente, e mancato recupero di una corrispondenza parziale.
Dopo: **47 test passati** su ranking, registry, ciclo nativo e MCP; architettura
0 errori, 35 avvisi dimensionali preesistenti. Test aggiuntivi coprono Unicode,
parametri, assenza di corrispondenze spurie nei tipi schema, query lunghe,
termini sconosciuti e determinismo indipendente dall'ordine di registrazione.
Nessuna nuova prova con modello reale: è verifica dell'algoritmo e regressione.

## Lavoro successivo per H07 (al momento di questa verifica)

Aggiornamento: il [bridge MCP](2026-09-23-agent-bridge-verifica.md) è ora implementato;
il testo seguente documenta il confine precedente.

Hermes espone `tool_search`, `tool_describe` e `tool_call` al posto degli schemi
differiti. Homun espone ancora tutti gli schemi e usa la ricerca come strumento
ordinario. Integrare il bridge preservando ID canonici, approvazioni MCP,
ripartenza dopo ricevuta e contratti dei run esistenti; verificare con modello
reale ricerca → descrizione → chiamata. La ricerca non è semantica/multilingue:
un termine sconosciuto produce intenzionalmente nessun risultato, come nel
filtro upstream, e richiede riformulazione.
