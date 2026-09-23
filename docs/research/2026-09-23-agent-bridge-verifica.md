# Bridge MCP differito

H07 resta parziale. Nei nuovi run nativi gli schemi MCP selezionati rimangono
nel contratto approvato ma vengono esclusi dalla lista di schemi inviata al
modello. `tool_search` presenta nomi e brevi descrizioni; ricerca e
`tool_describe` recuperano gli schemi. `tool_call` risolve un singolo nome e i
suoi argomenti nel percorso MCP supervisionato esistente. Materiali, richieste
umane e lettura dei risultati salvati rimangono direttamente disponibili.

## Contratti e autorità

- `_tool_bridge_version` è fissato nel run prima del digest di approvazione.
  I run precedenti mantengono gli schemi diretti e i vecchi manifest.
- ID e nome `tool_call` restano nella cronologia canonica. La proposta esterna
  mostra server, strumento originale e argomenti reali. Il validatore risolve
  nuovamente il wrapper prima dell'approvazione e confronta il contratto.
- Ricerca e descrizione non eseguono IO. Target sconosciuti, strumenti diretti
  dentro wrapper e ricorsione sono errori recuperabili. Gli argomenti reali
  vengono validati prima di preparare una proposta esterna.
- Le chiamate dirette a un nome MCP approvato restano compatibili, con gli stessi
  controlli e consenso: nascondere uno schema ottimizza il contesto, non revoca
  un'autorizzazione. La ricerca esclude i tre strumenti intermedi per evitare
  che il catalogo incorporato faccia trovare `tool_search` come risultato.
- I nuovi descrittori MCP includono il nome visibile del server (versione 2),
  così la ricerca trova anche quel nome; i descrittori precedenti restano v1.

## Prove

Due test iniziali fallivano prima del codice: schema non nascosto e wrapper non
risolto. Ulteriori RED/GREEN per esclusione del catalogo della ricerca da se
stesso e ricerca per nome visibile del server.

**828 test engine passati, 1 saltato** nella suite completa; dopo gli ultimi
controlli e la correzione dell'indice del nome server, **58 test mirati passati**.
Coperti consenso, riavvio, ricezione una sola volta, più chiamate con ID distinti,
ricerca e chiamata nello stesso round, annullamento, manomissione degli argomenti,
validazione stretta del wrapper, run precedenti e compatibilità diretta.
Architettura: 0 errori, 35 avvisi dimensionali preesistenti. OpenAPI invariato.
Revisione indipendente: nessuna regressione concreta di autorità o cronologia;
compatibilità diretta chiarita e testata. Nessuna verifica UI aggiuntiva.

- [Prima prova Ollama](evidence/2026-09-23-hermes-parity/agent_bridge_ollama.json):
  tre ricerche, descrizione, chiamata; consenso programmato dalla fixture,
  riapertura SQLite, una chiamata stdio e un artifact con i dati corretti.
- [Prova dopo correzione nome server](evidence/2026-09-23-hermes-parity/agent_bridge_source_ollama.json):
  due ricerche (la prima include il codice ordine non presente nel catalogo),
  descrizione e chiamata. `ordini` ora trova lo strumento. Una chiamata esterna;
  codice OR-93, responsabile Marta e consegna 8 ottobre 2026 presenti nell'artifact.
  Il modello conclude però con «Ora posso preparare la nota»: verifica positiva
  del trasporto e dei dati, non piena riuscita stilistica della consegna.

Modello reale: Ollama `qwen3.5:4b`. Server stdio locale reale, approvazione umana
simulata esplicitamente dalla fixture. Obiettivo del fixture richiede di usare
ricerca, descrizione e chiamata per provare il percorso. Riproduzione:
`agent_mcp_ollama.py <output.json> --bridge` con PYTHONPATH=engine/src.

## Limiti aperti

Solo gli strumenti MCP selezionati sono differiti; nessuna configurazione delle
famiglie da differire o budget dinamico del catalogo. Nessuno stemming inglese,
ricerca semantica o traduzione delle query. Resta il limite di 4 server/32 tool.
Chiamate multiple usano round nativi ordinati, non un batch opaco nel wrapper.
H07 completo e la parità H01–H46 non sono dichiarati raggiunti.
Logica Hermes derivata e attribuita nella notice MIT; nessuna dipendenza runtime.
