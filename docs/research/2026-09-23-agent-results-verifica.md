# Risultati voluminosi nel ciclo agente

H07 resta parziale. I nuovi run nativi salvano integralmente in SQLite i risultati
JSON oltre 12.000 caratteri serializzati. Cronologia e osservazioni ricevono la
stessa anteprima di 1.600 caratteri, distribuita 40% inizio e 60% fine, con
riferimento SHA-256 e indicazione esplicita delle parti omesse. I flag di errore
restano visibili. `read_tool_result` consulta pagine fino a 1.000 caratteri o
cerca testo letterale, esclusivamente nei risultati del run autorizzato.
I run precedenti mantengono catalogo e comportamento originali.

## Evidenze

- Suite engine: **805 passati, 1 saltato**, più **7 controlli finali** del modulo
  (comprendono due test aggiunti dopo l'avvio della suite completa).
- Ricostruzione JSON esatta con Unicode, virgolette e backslash; hash corrotto e
  riferimenti di altri run rifiutati; revoca della fonte blocca la lettura.
- Ricevuta MCP di errore, riavvio, ricerca centrale e artifact finale: una sola
  chiamata esterna, flag di errore conservato anche nella pagina letta.
- Typecheck, test web e build passati; OpenAPI allineato; architettura senza errori
  con 35 avvisi dimensionali preesistenti. Build segnala i consueti chunk grandi.
- Revisione indipendente: nessun blocco concreto, 18 test mirati passati.
- [Traccia reale](evidence/2026-09-23-hermes-parity/agent_results_ollama.json):
  Ollama `qwen3.5:4b` sceglie lo strumento MCP stdio, la fixture approva
  esplicitamente, il contesto viene chiuso e ricreato, il modello cerca `owner`
  tramite `read_tool_result` e consegna OR-93, Marta, 8 ottobre 2026. Una chiamata
  esterna e un artifact. Consenso simulato programmaticamente; nessuna prova UI.
  Riproduzione: `agent_mcp_ollama.py <output.json> --large`, con Ollama locale.

## Limiti ancora aperti

Nessuna retention/GC o quota complessiva per lo storage; i risultati esterni
restano anche nelle ricevute e quindi occupano spazio duplicato. Il limite è
in caratteri JSON, non token o byte. Non introduce attivazione pigra degli
strumenti, nuove policy di compattazione o parità completa H07/H01–H46.
Derivazione dai due moduli Hermes documentata nella notice MIT; motore Homun.
